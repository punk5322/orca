import SwiftUI

@main
struct OrcaWatchApp: App {
  @StateObject private var phone = PhoneLink.shared

  var body: some Scene {
    WindowGroup {
      NavigationStack { WorktreeListView() }.environmentObject(phone)
    }
  }
}
