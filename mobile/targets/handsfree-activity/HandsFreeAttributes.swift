import ActivityKit

// A copy of modules/orca-hands-free/ios/HandsFreeAttributes.swift: ActivityKit matches the app's
// activity to this widget by the type's name and Codable shape, so keep the two identical.
struct HandsFreeAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var phase: String
    var detail: String
  }

  var title: String
}
