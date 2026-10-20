import ExpoModulesCore
import WatchConnectivity

// Why: requests cross as one JSON string under "json" so the wire stays a plain property list
// and JS owns the protocol; this file only moves bytes between WatchConnectivity and JS.
public class OrcaWatchBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaWatchBridge")
    Events("onWatchRequest")

    OnCreate {
      WatchRelay.shared.start { [weak self] id, json in
        self?.sendEvent("onWatchRequest", ["id": id, "json": json])
      }
    }

    AsyncFunction("respond") { (id: String, json: String) in
      WatchRelay.shared.respond(id: id, json: json)
    }
  }
}

final class WatchRelay: NSObject, WCSessionDelegate {
  static let shared = WatchRelay()
  // Why: a watch request that JS never answers must still release the watch's spinner.
  private static let replyTimeout: TimeInterval = 25

  private let lock = NSLock()
  private var pending: [String: ([String: Any]) -> Void] = [:]
  private var onRequest: ((String, String) -> Void)?

  func start(onRequest: @escaping (String, String) -> Void) {
    self.onRequest = onRequest
    guard WCSession.isSupported() else { return }
    NSLog("[OrcaWatchBridge] activating WCSession")
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func respond(id: String, json: String) {
    lock.lock()
    let reply = pending.removeValue(forKey: id)
    lock.unlock()
    NSLog("[OrcaWatchBridge] reply for %@ delivered=%d", id, reply == nil ? 0 : 1)
    reply?(["json": json])
  }

  func session(
    _ session: WCSession, didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    NSLog("[OrcaWatchBridge] message from watch, jsReady=%d", onRequest == nil ? 0 : 1)
    guard let json = message["json"] as? String, let onRequest else {
      replyHandler(["json": "{\"ok\":false,\"error\":\"Orca is not ready on the phone\"}"])
      return
    }
    let id = UUID().uuidString
    lock.lock()
    pending[id] = replyHandler
    lock.unlock()
    onRequest(id, json)
    DispatchQueue.global().asyncAfter(deadline: .now() + Self.replyTimeout) { [weak self] in
      self?.respond(id: id, json: "{\"ok\":false,\"error\":\"The phone took too long to answer\"}")
    }
  }

  func session(
    _ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?
  ) {
    NSLog(
      "[OrcaWatchBridge] activated state=%d paired=%d installed=%d reachable=%d err=%@",
      state.rawValue, session.isPaired ? 1 : 0, session.isWatchAppInstalled ? 1 : 0,
      session.isReachable ? 1 : 0, String(describing: error))
  }
  func sessionReachabilityDidChange(_ session: WCSession) {
    NSLog("[OrcaWatchBridge] reachable=%d", session.isReachable ? 1 : 0)
  }
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
