import ActivityKit

// Starts, updates and ends the lock screen card that shows what hands-free mode is doing. An
// activity can only be started while the app is on screen, which hands-free mode already needs.
@available(iOS 16.2, *)
enum LiveActivityControl {
  private static var current: Activity<HandsFreeAttributes>?

  static func start(title: String, phase: String, detail: String) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    // One card at a time, and none left over from a previous launch.
    for stale in Activity<HandsFreeAttributes>.activities {
      Task { await stale.end(nil, dismissalPolicy: .immediate) }
    }
    current = nil
    let content = ActivityContent(
      state: HandsFreeAttributes.ContentState(phase: phase, detail: detail), staleDate: nil)
    current = try? Activity.request(
      attributes: HandsFreeAttributes(title: title), content: content, pushType: nil)
  }

  static func update(phase: String, detail: String) {
    guard let activity = current else { return }
    let content = ActivityContent(
      state: HandsFreeAttributes.ContentState(phase: phase, detail: detail), staleDate: nil)
    Task { await activity.update(content) }
  }

  static func end() {
    guard let activity = current else { return }
    current = nil
    Task { await activity.end(nil, dismissalPolicy: .immediate) }
  }
}
