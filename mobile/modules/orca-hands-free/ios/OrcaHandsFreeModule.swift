import AVFoundation
import ExpoModulesCore
import MediaPlayer

// Why: hands-free mode needs the app to keep running with the screen locked, which iOS allows only
// while an audio session is active. This module owns that session, speaks text, and captures the
// microphone; JS owns the conversation logic and the desktop connection.
public class OrcaHandsFreeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaHandsFree")
    Events("onChunk", "onListenEnded", "onLevel")

    OnCreate {
      HandsFreeAudio.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { promise.resolve($0) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { promise.resolve($0) }
      }
    }
    AsyncFunction("getRate") { () -> Double in HandsFreeAudio.savedRate() }
    AsyncFunction("setRate") { (value: Double) in HandsFreeAudio.saveRate(value) }
    AsyncFunction("voices") { () -> [[String: String]] in HandsFreeAudio.voiceList() }
    AsyncFunction("currentVoice") { () -> String? in HandsFreeAudio.savedVoiceId() }
    AsyncFunction("setVoice") { (id: String?) in HandsFreeAudio.saveVoice(id) }
    AsyncFunction("preview") { (id: String, promise: Promise) in
      HandsFreeAudio.shared.speak(
        "Good evening. The build has succeeded. What would you like to do next?",
        interruptible: false, voiceId: id.isEmpty ? nil : id
      ) { promise.resolve() }
    }
    AsyncFunction("start") { () throws in try HandsFreeAudio.shared.start() }
    AsyncFunction("stop") { HandsFreeAudio.shared.stop() }
    AsyncFunction("speak") { (text: String, interruptible: Bool, promise: Promise) in
      HandsFreeAudio.shared.speak(text, interruptible: interruptible, voiceId: nil) { promise.resolve() }
    }
    AsyncFunction("listen") { () throws in try HandsFreeAudio.shared.listen() }
    AsyncFunction("cancelSpeech") { HandsFreeAudio.shared.cancelSpeech() }
    AsyncFunction("stopListening") { HandsFreeAudio.shared.stopListening(reason: "stopped") }
  }
}

struct HandsFreeError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

final class HandsFreeAudio: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = HandsFreeAudio()
  var emit: ((String, [String: Any]) -> Void)?

  private static let rate = 16_000.0
  private static let chunkBytes = 16_000  // 0.5 s of 16-bit mono samples
  private static let baselineSeconds = 0.6
  private static let quietSeconds = 1.6
  private static let noSpeechSeconds = 10.0
  private static let maxSeconds = 40.0
  private static let ringBytes = 38_400  // the last 1.2 s kept for a voice interruption
  private static let echoLearnSeconds = 0.7
  private static let bargeSeconds = 0.35

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let synthesizer = AVSpeechSynthesizer()
  private let target = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: HandsFreeAudio.rate, channels: 1, interleaved: true)!
  private let lock = NSLock()
  private var active = false
  private var observers: [NSObjectProtocol] = []
  private var speakDone: (() -> Void)?

  private var listening = false
  // Audio captured after an interruption waits here until JS calls listen() and attaches.
  private var attached = false
  private var endedBeforeAttach: String?
  private var tapInstalled = false
  private var lastLevelAt = Date.distantPast
  private var speaking = false
  private var monitoring = false
  private var ring = Data()
  private var monitorStartedAt = Date()
  private var echoSum: Float = 0
  private var echoCount = 0
  private var bargeRun = 0.0
  private var remoteTargets: [(MPRemoteCommand, Any)] = []
  private var converter: AVAudioConverter?
  private var pending = Data()
  private var startedAt = Date()
  private var baselineSum: Float = 0
  private var baselineCount = 0
  private var speechLevel: Float = 0.02
  private var quietLevel: Float = 0.012
  private var heardSpeech = false
  private var quietSince: Date?

  // MARK: keep-alive session

  func start() throws {
    guard !active else { return }
    try configureSession(ducking: false)
    let format = engine.outputNode.inputFormat(forBus: 0)
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    // Why: a looping silent buffer is what keeps iOS treating the app as playing audio.
    if let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate)) {
      silence.frameLength = silence.frameCapacity
      for channel in 0..<Int(format.channelCount) {
        memset(silence.floatChannelData?[channel], 0, Int(silence.frameLength) * MemoryLayout<Float>.size)
      }
      player.scheduleBuffer(silence, at: nil, options: .loops)
    }
    synthesizer.delegate = self
    // Why: the engine only brings the microphone up if its input node exists before it starts;
    // touching it afterwards leaves the input format invalid for a moment and crashes installTap.
    _ = engine.inputNode
    try engine.start()
    player.play()
    active = true
    installRemoteCommands()
    observers = [
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if raw == AVAudioSession.InterruptionType.ended.rawValue { self?.resume() }
      },
      NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
      ) { [weak self] _ in self?.resume() },
    ]
  }

  func stop() {
    stopListening(reason: "stopped")
    synthesizer.stopSpeaking(at: .immediate)
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    removeRemoteCommands()
    player.stop()
    engine.stop()
    engine.detach(player)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    active = false
  }

  // Why: the play/pause press on AirPods, a steering wheel or the lock screen is the one interrupt
  // that works in a noisy car, where detecting a voice over our own speech is least reliable.
  private func installRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    for command in [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand] {
      command.isEnabled = true
      let token = command.addTarget { [weak self] _ in
        DispatchQueue.main.async { self?.barge(byVoice: false) }
        return .success
      }
      remoteTargets.append((command, token))
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "Orca hands-free"]
  }

  private func removeRemoteCommands() {
    for (command, token) in remoteTargets { command.removeTarget(token) }
    remoteTargets = []
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  private func resume() {
    guard active else { return }
    try? AVAudioSession.sharedInstance().setActive(true)
    if !engine.isRunning { try? engine.start() }
    if !player.isPlaying { player.play() }
    // A configuration change can leave the tap on the old format, so put it back on the new one.
    lock.lock()
    let hadTap = tapInstalled
    lock.unlock()
    if hadTap {
      removeTapIfInstalled()
      try? ensureTap()
    }
  }

  private func configureSession(ducking: Bool) throws {
    var options: AVAudioSession.CategoryOptions = [
      .mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP,
    ]
    if ducking { options.insert(.duckOthers) }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .spokenAudio, options: options)
    try session.setActive(true)
  }

  // MARK: speech

  func speak(_ text: String, interruptible: Bool, voiceId: String?, done: @escaping () -> Void) {
    DispatchQueue.main.async {
      // A preview can run with hands-free off, when no session is active yet.
      if self.active {
        try? self.configureSession(ducking: true)
      } else {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        self.synthesizer.delegate = self
      }
      self.speakDone = done
      self.lock.lock()
      self.speaking = true
      self.monitoring = interruptible && !self.listening
      self.ring = Data()
      self.echoSum = 0
      self.echoCount = 0
      self.bargeRun = 0
      self.monitorStartedAt = Date()
      let monitor = self.monitoring
      self.lock.unlock()
      if monitor { try? self.ensureTap() }
      let utterance = AVSpeechUtterance(string: text)
      utterance.voice = voiceId.flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? Self.bestVoice()
      utterance.rate = min(
        AVSpeechUtteranceMaximumSpeechRate,
        AVSpeechUtteranceDefaultSpeechRate * Float(Self.savedRate()))
      self.synthesizer.speak(utterance)
      // Why: if no audio route ever plays the utterance the delegate never fires; do not hang JS.
      DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in self?.finishSpeaking() }
    }
  }

  /// Cuts the speech short and starts capturing the reply, keeping the last second of audio when
  /// the interruption was a voice so the first words are not lost.
  private func barge(byVoice: Bool) {
    lock.lock()
    guard speaking, !listening else {
      lock.unlock()
      return
    }
    listening = true
    attached = false
    endedBeforeAttach = nil
    pending = byVoice ? ring : Data()
    startedAt = Date()
    baselineSum = 0
    baselineCount = 0
    speechLevel = 0.02
    quietLevel = 0.012
    heardSpeech = byVoice
    quietSince = nil
    monitoring = false
    lock.unlock()
    try? ensureTap()
    synthesizer.stopSpeaking(at: .immediate)
  }

  // Why: the default voice is the compact one that sounds robotic. Enhanced and Premium voices are
  // free downloads in iOS Settings (Accessibility > Spoken Content > Voices) and sound far more
  // natural, so use the best installed one in the user's language, skipping novelty voices.
  private static let voiceKey = "orca.handsfree.voice"
  private static let rateKey = "orca.handsfree.rate"

  /// Speech speed as a multiple of the system's default rate.
  static func savedRate() -> Double {
    let stored = UserDefaults.standard.double(forKey: rateKey)
    return stored > 0 ? min(max(stored, 0.7), 1.7) : 1.05
  }

  static func saveRate(_ value: Double) {
    UserDefaults.standard.set(min(max(value, 0.7), 1.7), forKey: rateKey)
  }

  static func savedVoiceId() -> String? { UserDefaults.standard.string(forKey: voiceKey) }

  static func saveVoice(_ id: String?) {
    if let id, !id.isEmpty {
      UserDefaults.standard.set(id, forKey: voiceKey)
    } else {
      UserDefaults.standard.removeObject(forKey: voiceKey)
    }
  }

  /// English voices installed on this phone, best first, without the novelty and robot voices.
  static func voiceList() -> [[String: String]] {
    func label(_ voice: AVSpeechSynthesisVoice) -> String {
      switch voice.quality {
      case .premium: return "premium"
      case .enhanced: return "enhanced"
      default: return "compact"
      }
    }
    return AVSpeechSynthesisVoice.speechVoices()
      .filter {
        $0.language.hasPrefix("en") && !$0.identifier.contains("speech.synthesis.voice")
          && !$0.identifier.contains("eloquence")
      }
      .sorted { ($0.quality.rawValue, $1.name) > ($1.quality.rawValue, $0.name) }
      .map { ["id": $0.identifier, "name": $0.name, "language": $0.language, "quality": label($0)] }
  }

  private static func bestVoice() -> AVSpeechSynthesisVoice? {
    if let saved = savedVoiceId(), let voice = AVSpeechSynthesisVoice(identifier: saved) {
      return voice
    }
    let language = AVSpeechSynthesisVoice.currentLanguageCode()
    let voices = AVSpeechSynthesisVoice.speechVoices().filter {
      $0.language == language && !$0.identifier.contains("speech.synthesis.voice")
    }
    return voices.max { $0.quality.rawValue < $1.quality.rawValue }
      ?? AVSpeechSynthesisVoice(language: language)
  }

  func cancelSpeech() {
    DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate) }
  }

  private func finishSpeaking() {
    if active {
      try? configureSession(ducking: false)
    } else {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    lock.lock()
    speaking = false
    monitoring = false
    ring = Data()
    let capturing = listening
    lock.unlock()
    if !capturing { removeTapIfInstalled() }
    let done = speakDone
    speakDone = nil
    done?()
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finishSpeaking()
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finishSpeaking()
  }

  // MARK: microphone

  private func ensureTap() throws {
    lock.lock()
    let installed = tapInstalled
    lock.unlock()
    guard !installed else { return }
    let input = engine.inputNode
    // Why: installTap asserts the format matches the hardware's. After speech the session can
    // change the microphone's rate (built-in vs Bluetooth), and the engine-side outputFormat lags
    // that, so ask for the hardware-side format.
    let format = input.inputFormat(forBus: 0)
    // Why: an input that is not ready reports zero rate or channels, and installing a tap with that
    // format throws an Objective-C exception that cannot be caught, so check it first.
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw HandsFreeError(message: "The microphone is not ready yet.")
    }
    converter = AVAudioConverter(from: format, to: target)
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.handle(buffer)
    }
    lock.lock()
    tapInstalled = true
    lock.unlock()
  }

  private func removeTapIfInstalled() {
    lock.lock()
    let installed = tapInstalled
    tapInstalled = false
    lock.unlock()
    if installed { engine.inputNode.removeTap(onBus: 0) }
  }

  func listen() throws {
    guard active else { return }
    var flush = Data()
    var ended: String?
    var fresh = false
    lock.lock()
    if let reason = endedBeforeAttach {
      // The interruption already finished speaking before JS attached: hand over the whole thing.
      flush = pending
      pending = Data()
      endedBeforeAttach = nil
      ended = reason
    } else if listening {
      attached = true
      flush = pending
      pending = Data()
    } else {
      startedAt = Date()
      pending = Data()
      baselineSum = 0
      baselineCount = 0
      speechLevel = 0.02
      quietLevel = 0.012
      heardSpeech = false
      quietSince = nil
      listening = true
      attached = true
      fresh = true
    }
    lock.unlock()
    if fresh {
      do {
        try ensureTap()
      } catch {
        // Leave nothing half-started, so the next attempt begins clean.
        lock.lock()
        listening = false
        attached = false
        lock.unlock()
        throw error
      }
    }
    var offset = 0
    while offset < flush.count {
      let end = min(offset + HandsFreeAudio.chunkBytes, flush.count)
      emit?("onChunk", ["audio": flush.subdata(in: offset..<end).base64EncodedString()])
      offset = end
    }
    if let ended { emit?("onListenEnded", ["reason": ended]) }
  }

  func stopListening(reason: String) {
    lock.lock()
    let was = listening
    listening = false
    attached = false
    let rest = pending
    pending = Data()
    let stillSpeaking = speaking
    lock.unlock()
    guard was else { return }
    if !stillSpeaking { removeTapIfInstalled() }
    if !rest.isEmpty { emit?("onChunk", ["audio": rest.base64EncodedString()]) }
    emit?("onListenEnded", ["reason": reason])
  }

  private func handle(_ buffer: AVAudioPCMBuffer) {
    // The route can change mid-listen; follow the buffers' own format rather than the one the
    // converter was built for.
    if converter == nil || converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: target)
    }
    guard let converter else { return }
    let capacity =
      AVAudioFrameCount(Double(buffer.frameLength) * HandsFreeAudio.rate / buffer.format.sampleRate)
      + 64
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
    var endReason: String?
    var shouldBarge = false
    var levelToEmit: Float?
    lock.lock()
    let now = Date()
    // Feeds the on-screen visualizer; about twelve a second is plenty.
    if (listening || monitoring) && now.timeIntervalSince(lastLevelAt) > 0.08 {
      lastLevelAt = now
      levelToEmit = level
    }
    if listening {
      pending.append(bytes)
      // Chunks only go to JS once it has attached; before that the audio waits in `pending`.
      while attached && pending.count >= HandsFreeAudio.chunkBytes {
        chunks.append(pending.prefix(HandsFreeAudio.chunkBytes))
        pending.removeFirst(HandsFreeAudio.chunkBytes)
      }
      let elapsed = now.timeIntervalSince(startedAt)
      if elapsed < HandsFreeAudio.baselineSeconds && !heardSpeech {
        // Why: a car is never silent, so learn the cabin noise first and judge speech against it.
        baselineSum += level
        baselineCount += 1
      } else {
        if baselineCount > 0, speechLevel == 0.02 {
          let floor = min(baselineSum / Float(baselineCount), 0.03)
          speechLevel = max(0.02, floor * 3)
          quietLevel = max(0.012, floor * 1.8)
        }
        if level > speechLevel {
          heardSpeech = true
          quietSince = nil
        } else if level < quietLevel, quietSince == nil {
          quietSince = now
        }
        if heardSpeech, let quietSince, now.timeIntervalSince(quietSince) > HandsFreeAudio.quietSeconds {
          endReason = "silence"
        } else if !heardSpeech, elapsed > HandsFreeAudio.noSpeechSeconds {
          endReason = "no-speech"
        } else if elapsed > HandsFreeAudio.maxSeconds {
          endReason = "timeout"
        }
      }
      if let reason = endReason, !attached {
        // Ended before JS attached (a short interjection): keep the audio for listen() to collect.
        listening = false
        endedBeforeAttach = reason
        endReason = nil
        DispatchQueue.main.async { [weak self] in self?.removeTapIfInstalled() }
      }
    } else if monitoring {
      ring.append(bytes)
      if ring.count > HandsFreeAudio.ringBytes { ring.removeFirst(ring.count - HandsFreeAudio.ringBytes) }
      let sinceStart = now.timeIntervalSince(monitorStartedAt)
      if sinceStart < HandsFreeAudio.echoLearnSeconds {
        // The first moments of our own speech tell us how loud it sounds in the microphone.
        echoSum += level
        echoCount += 1
      } else if echoCount > 0 {
        let threshold = max(0.05, (echoSum / Float(echoCount)) * 2.2 + 0.02)
        if level > threshold {
          bargeRun += Double(count) / HandsFreeAudio.rate
        } else {
          bargeRun = 0
        }
        shouldBarge = bargeRun >= HandsFreeAudio.bargeSeconds
      }
    }
    lock.unlock()

    if let levelToEmit { emit?("onLevel", ["level": levelToEmit]) }
    if shouldBarge { DispatchQueue.main.async { [weak self] in self?.barge(byVoice: true) } }
    for chunk in chunks { emit?("onChunk", ["audio": chunk.base64EncodedString()]) }
    // Why: removing the tap from inside its own callback can deadlock, so finish on the main queue.
    if let endReason { DispatchQueue.main.async { [weak self] in self?.stopListening(reason: endReason) } }
  }
}
