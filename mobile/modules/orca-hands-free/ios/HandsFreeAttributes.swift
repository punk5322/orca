import ActivityKit

// Why: the lock screen card is drawn by a widget extension, which keeps its own copy of this type;
// ActivityKit matches the two by name and by their Codable shape, so the fields must stay identical
// to targets/handsfree-activity/HandsFreeAttributes.swift.
@available(iOS 16.1, *)
struct HandsFreeAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// idle, listening, thinking or speaking.
    var phase: String
    var detail: String
  }

  var title: String
}
