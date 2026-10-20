import Foundation
import AVFoundation
import WatchConnectivity

struct Worktree: Identifiable, Hashable { let id: String; let name: String }
// kind is "terminal" or "agent"; ref is the terminal handle or the chat session id.
struct Terminal: Identifiable, Hashable { var id: String { ref }; let kind: String; let ref: String; let title: String }

struct PhoneError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

// Why: the phone holds the paired, encrypted host connection; the watch only relays requests to it.
final class PhoneLink: NSObject, ObservableObject, WCSessionDelegate {
  static let shared = PhoneLink()

  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func worktrees() async throws -> [Worktree] {
    let reply = try await request(["op": "worktrees"])
    let rows = reply["worktrees"] as? [[String: Any]] ?? []
    return rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      return Worktree(id: id, name: row["name"] as? String ?? id)
    }
  }

  func terminals(worktreeId: String) async throws -> (terminals: [Terminal], others: [String]) {
    let reply = try await request(["op": "terminals", "worktreeId": worktreeId])
    let rows = reply["terminals"] as? [[String: Any]] ?? []
    let terminals = rows.compactMap { row -> Terminal? in
      guard let ref = row["ref"] as? String, let kind = row["kind"] as? String else { return nil }
      return Terminal(kind: kind, ref: ref, title: row["title"] as? String ?? "Terminal")
    }
    return (terminals, reply["others"] as? [String] ?? [])
  }

  func send(to target: Terminal, text: String) async throws {
    _ = try await request(["op": "send", "kind": target.kind, "ref": target.ref, "text": text])
  }

  func dictationStart() async throws -> String {
    let reply = try await request(["op": "dictStart"])
    guard let id = reply["id"] as? String else { throw PhoneError(message: "Dictation did not start") }
    return id
  }

  func dictationChunk(id: String, audio: Data) async throws {
    _ = try await request(["op": "dictChunk", "id": id, "audio": audio.base64EncodedString()])
  }

  func dictationFinish(id: String) async throws -> String {
    let reply = try await request(["op": "dictFinish", "id": id])
    return reply["text"] as? String ?? ""
  }

  func dictationCancel(id: String) async {
    _ = try? await request(["op": "dictCancel", "id": id])
  }

  private func request(_ body: [String: Any]) async throws -> [String: Any] {
    let session = WCSession.default
    // Why: right after launch or a restart the session is still activating and reachability lags it,
    // so give both a few seconds before telling the user the phone is missing.
    for _ in 0..<60 where session.activationState != .activated || !session.isReachable {
      if session.activationState != .activated { session.activate() }
      try await Task.sleep(nanoseconds: 250_000_000)
    }
    guard session.activationState == .activated else {
      throw PhoneError(message: "Still connecting to your iPhone. Try again.")
    }
    guard session.isReachable else {
      throw PhoneError(
        message:
          "iPhone not reachable. Open Orca on your phone. [b4 act=\(session.activationState.rawValue) inst=\(session.isCompanionAppInstalled) reach=\(session.isReachable)]"
      )
    }
    let data = try JSONSerialization.data(withJSONObject: body)
    let json = String(decoding: data, as: UTF8.self)
    return try await withCheckedThrowingContinuation { continuation in
      session.sendMessage(
        ["json": json],
        replyHandler: { reply in
          guard let text = reply["json"] as? String,
            let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
          else {
            continuation.resume(throwing: PhoneError(message: "Unreadable reply from phone"))
            return
          }
          if parsed["ok"] as? Bool == true {
            continuation.resume(returning: parsed)
          } else {
            continuation.resume(
              throwing: PhoneError(message: parsed["error"] as? String ?? "Request failed"))
          }
        },
        errorHandler: { continuation.resume(throwing: $0) })
    }
  }

  func session(
    _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?
  ) {}
}


// Records the microphone as 16 kHz mono 16-bit PCM, the format the desktop's dictation takes, hands
// it out in half-second chunks, and reports when the speaker has gone quiet.
final class Recorder {
  private static let rate = 16_000.0
  private static let chunkBytes = 16_000  // 0.5 s of 16-bit samples
  private static let speechLevel: Float = 0.02
  private static let quietLevel: Float = 0.012
  private static let quietSeconds = 1.5
  private static let noSpeechSeconds = 8.0
  private static let maxSeconds = 60.0

  private let engine = AVAudioEngine()
  private let target = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: Recorder.rate, channels: 1, interleaved: true)!
  private let lock = NSLock()
  private var converter: AVAudioConverter?
  private var pending = Data()
  private var heardSpeech = false
  private var quietSince: Date?
  private var startedAt = Date()
  private var running = false
  private var autoStopFired = false

  var onChunk: ((Data) -> Void)?
  var onAutoStop: (() -> Void)?

  static func requestPermission() async -> Bool {
    await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
    }
  }

  func start() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .default)
    try session.setActive(true)
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    converter = AVAudioConverter(from: format, to: target)
    lock.lock()
    pending = Data()
    heardSpeech = false
    quietSince = nil
    startedAt = Date()
    autoStopFired = false
    running = true
    lock.unlock()
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.handle(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  /// Stops capture and hands out whatever audio is left. Safe to call more than once.
  func stop() {
    lock.lock()
    let wasRunning = running
    running = false
    let rest = pending
    pending = Data()
    lock.unlock()
    guard wasRunning else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    try? AVAudioSession.sharedInstance().setActive(false)
    if !rest.isEmpty { onChunk?(rest) }
  }

  private func handle(_ buffer: AVAudioPCMBuffer) {
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Recorder.rate / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else { return }
    let count = Int(out.frameLength)
    var sum: Float = 0
    for i in 0..<count {
      let sample = Float(channel[0][i]) / 32768
      sum += sample * sample
    }
    let level = (sum / Float(count)).squareRoot()
    let bytes = Data(bytes: channel[0], count: count * 2)

    var chunks: [Data] = []
    var shouldAutoStop = false
    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    pending.append(bytes)
    while pending.count >= Recorder.chunkBytes {
      chunks.append(pending.prefix(Recorder.chunkBytes))
      pending.removeFirst(Recorder.chunkBytes)
    }
    let now = Date()
    if level > Recorder.speechLevel {
      heardSpeech = true
      quietSince = nil
    } else if level < Recorder.quietLevel, quietSince == nil {
      quietSince = now
    }
    let elapsed = now.timeIntervalSince(startedAt)
    if heardSpeech, let quietSince, now.timeIntervalSince(quietSince) > Recorder.quietSeconds {
      shouldAutoStop = true
    } else if !heardSpeech && elapsed > Recorder.noSpeechSeconds {
      shouldAutoStop = true
    } else if elapsed > Recorder.maxSeconds {
      shouldAutoStop = true
    }
    if shouldAutoStop && autoStopFired { shouldAutoStop = false }
    if shouldAutoStop { autoStopFired = true }
    lock.unlock()

    for chunk in chunks { onChunk?(chunk) }
    if shouldAutoStop { DispatchQueue.main.async { [weak self] in self?.onAutoStop?() } }
  }
}

// One dictation: record, stream to the phone as it goes, then ask for the transcript.
@MainActor
final class DictationSession: ObservableObject {
  enum Phase { case idle, starting, listening, transcribing }
  @Published var phase: Phase = .idle

  private let recorder = Recorder()
  private var id: String?
  private var continuation: AsyncStream<Data>.Continuation?
  private var sender: Task<Void, Error>?
  private var phone: PhoneLink?
  private var onResult: ((Result<String, Error>) -> Void)?

  func start(phone: PhoneLink, onResult: @escaping (Result<String, Error>) -> Void) async throws {
    guard phase == .idle else { return }
    // Why: the permission prompt can take seconds; without a state of its own the button looks dead
    // and a second tap would start a second session.
    phase = .starting
    guard await Recorder.requestPermission() else {
      phase = .idle
      throw PhoneError(message: "Microphone access is off for Orca.")
    }
    let (stream, continuation) = AsyncStream<Data>.makeStream()
    self.phone = phone
    self.onResult = onResult
    self.continuation = continuation
    recorder.onChunk = { continuation.yield($0) }
    recorder.onAutoStop = { [weak self] in Task { await self?.stop() } }
    do {
      try recorder.start()
    } catch {
      continuation.finish()
      reset()
      throw error
    }
    phase = .listening
    // Why: opening the desktop session takes a round trip, so start recording first and let the
    // audio wait in the stream; the speaker never waits for the connection.
    // Chunks then go one at a time so the desktop receives the audio in order.
    sender = Task {
      do {
        let id = try await phone.dictationStart()
        self.id = id
        for await audio in stream { try await phone.dictationChunk(id: id, audio: audio) }
      } catch {
        await self.fail(error)
        throw error
      }
    }
  }

  func stop() async {
    guard phase == .listening, let phone else { return }
    phase = .transcribing
    recorder.stop()
    continuation?.finish()
    do {
      try await sender?.value
      guard let id else { throw PhoneError(message: "Dictation did not start") }
      let text = try await phone.dictationFinish(id: id)
      finish(.success(text))
    } catch {
      if let id { await phone.dictationCancel(id: id) }
      finish(.failure(error))
    }
  }

  /// The desktop session failed while the speaker was already talking: stop and say why now.
  private func fail(_ error: Error) async {
    guard phase == .listening else { return }
    recorder.stop()
    continuation?.finish()
    if let id, let phone { await phone.dictationCancel(id: id) }
    finish(.failure(error))
  }

  private func finish(_ result: Result<String, Error>) {
    let callback = onResult
    reset()
    callback?(result)
  }

  private func reset() {
    phase = .idle
    id = nil
    continuation = nil
    sender = nil
    onResult = nil
  }
}
