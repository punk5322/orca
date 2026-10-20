import ActivityKit
import SwiftUI
import WidgetKit

private func symbol(_ phase: String) -> String {
  switch phase {
  case "listening": return "mic.fill"
  case "thinking": return "ellipsis"
  case "speaking": return "speaker.wave.2.fill"
  default: return "waveform"
  }
}

private func label(_ phase: String) -> String {
  switch phase {
  case "listening": return "Listening…"
  case "thinking": return "Thinking…"
  case "speaking": return "Speaking"
  default: return "Waiting for agents"
  }
}

// Opens Orca and turns hands-free off: a Link is what a Live Activity can offer without an App
// Intent, and the microphone is only ever switched off, never on, from here.
private let stopLink = URL(string: "orca-cc://hands-free-off")!

struct HandsFreeLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: HandsFreeAttributes.self) { context in
      HStack(spacing: 12) {
        Image(systemName: symbol(context.state.phase)).font(.title2)
        VStack(alignment: .leading, spacing: 2) {
          Text(context.attributes.title).font(.headline)
          Text(label(context.state.phase)).font(.subheadline)
          if !context.state.detail.isEmpty {
            Text(context.state.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
          }
        }
        Spacer()
        Link(destination: stopLink) {
          Text("Stop").font(.subheadline.bold()).padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color.red, in: Capsule()).foregroundStyle(.white)
        }
      }
      .padding()
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Image(systemName: symbol(context.state.phase)) }
        DynamicIslandExpandedRegion(.center) { Text(label(context.state.phase)) }
        DynamicIslandExpandedRegion(.trailing) {
          Link("Stop", destination: stopLink).foregroundStyle(.red)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if !context.state.detail.isEmpty {
            Text(context.state.detail).font(.caption).lineLimit(2)
          }
        }
      } compactLeading: {
        Image(systemName: symbol(context.state.phase))
      } compactTrailing: {
        Text(label(context.state.phase).prefix(4))
      } minimal: {
        Image(systemName: symbol(context.state.phase))
      }
    }
  }
}
