import SwiftUI
import WatchKit

struct WorktreeListView: View {
  @EnvironmentObject var phone: PhoneLink
  @State private var worktrees: [Worktree] = []
  @State private var error: String?
  @State private var loading = true
  @State private var handsFree = false

  var body: some View {
    List {
      // Hands-free mode lives on the phone; this only switches it.
      Toggle("Hands-free", isOn: $handsFree)
        .onChange(of: handsFree) { _, on in
          Task {
            do { handsFree = try await phone.setHandsFree(on) } catch { self.error = error.localizedDescription }
          }
        }
      if let error {
        Text(error).foregroundStyle(.red).font(.footnote)
        Button("Retry") { Task { await load() } }
      }
      ForEach(worktrees) { worktree in
        NavigationLink(worktree.name) { TerminalListView(worktree: worktree) }
      }
    }
    .overlay { if loading { ProgressView() } }
    .navigationTitle("Orca")
    .sheet(item: $phone.alert) { alert in AlertView(alert: alert) }
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      worktrees = try await phone.worktrees()
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct TerminalListView: View {
  @EnvironmentObject var phone: PhoneLink
  let worktree: Worktree
  @State private var terminals: [Terminal] = []
  @State private var others: [String] = []
  @State private var error: String?
  @State private var loading = true

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red).font(.footnote) }
      ForEach(terminals) { terminal in
        NavigationLink(terminal.title) { DictateView(terminal: terminal) }
      }
      if !loading && error == nil && terminals.isEmpty {
        Text("No terminals or chats here.").font(.footnote)
      }
      // Why: only terminals accept dictated text; list the rest so an empty screen explains itself.
      ForEach(others, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
    }
    .overlay { if loading { ProgressView() } }
    .navigationTitle(worktree.name)
    .task {
      do {
        let result = try await phone.terminals(worktreeId: worktree.id)
        terminals = result.terminals
        others = result.others
      } catch { self.error = error.localizedDescription }
      loading = false
    }
  }
}

struct DictateView: View {
  @EnvironmentObject var phone: PhoneLink
  @StateObject private var dictation = DictationSession()
  let terminal: Terminal
  @State private var text = ""
  @State private var status: String?
  @State private var sending = false
  // Why: if watchOS will not present dictation from a button, fall back to the text field, which
  // always offers the mic.
  @State private var dictationUnavailable = false

  var body: some View {
    ScrollView {
      VStack(spacing: 8) {
        if !text.isEmpty {
          Text(text).font(.footnote)
          Button(sending ? "Sending…" : "Send") { Task { await send() } }
            .tint(.green).disabled(sending)
          Button("Redo") { text = ""; status = nil }.disabled(sending)
        } else {
          switch dictation.phase {
          case .idle:
            Button { Task { await listen() } } label: {
              Image(systemName: "mic.fill").font(.system(size: 36)).frame(maxWidth: .infinity, minHeight: 70)
            }
            .tint(.blue)
            if dictationUnavailable { TextField("Dictate", text: $text) }
          case .starting:
            ProgressView()
            Text("Starting…").font(.footnote)
          case .listening:
            Button { Task { await dictation.stop() } } label: {
              Image(systemName: "stop.fill").font(.system(size: 36)).frame(maxWidth: .infinity, minHeight: 70)
            }
            .tint(.red)
            Text("Listening…").font(.footnote)
          case .transcribing:
            ProgressView()
            Text("Transcribing…").font(.footnote)
          }
        }
        if let status { Text(status).font(.footnote) }
      }
    }
    .navigationTitle(terminal.title)
  }

  private func listen() async {
    status = nil
    do {
      try await dictation.start(phone: phone) { result in
        switch result {
        case .success(let heard): Task { await handle(heard) }
        case .failure(let error): status = error.localizedDescription
        }
      }
    } catch {
      // Recording is unavailable (permission, hardware, or the desktop has no speech model): fall
      // back to the system dictation screen, and say why.
      status = error.localizedDescription
      await systemDictate()
    }
  }

  private func handle(_ heard: String) async {
    guard !heard.trimmingCharacters(in: .whitespaces).isEmpty else {
      status = "Didn't catch that."
      return
    }
    text = heard
    // Why: an agent copes with a misheard word, but a raw terminal would run it as a command, so
    // only chats skip the confirm step.
    if terminal.kind == "agent" { await send() }
  }

  private func systemDictate() async {
    let heard: String? = await withCheckedContinuation { continuation in
      guard let controller = WKExtension.shared().visibleInterfaceController else {
        continuation.resume(returning: nil)
        dictationUnavailable = true
        return
      }
      controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) {
        continuation.resume(returning: ($0?.first as? String))
      }
    }
    if let heard { await handle(heard) }
  }

  private func send() async {
    sending = true
    defer { sending = false }
    do {
      let sent = text
      try await phone.send(to: terminal, text: sent)
      text = ""
      status = "Sent: \(sent)"
    } catch { status = error.localizedDescription }
  }
}


struct AlertView: View {
  @Environment(\.dismiss) private var dismiss
  let alert: WatchAlert

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 8) {
          Text(alert.title).font(.headline)
          if !alert.body.isEmpty { Text(alert.body).font(.footnote) }
          if let worktreeId = alert.worktreeId {
            // Reply goes to the same worktree's chats and terminals, ready to dictate "what's next".
            NavigationLink("Reply") {
              TerminalListView(worktree: Worktree(id: worktreeId, name: alert.title))
            }
            .tint(.blue)
          }
          Button("Dismiss") { dismiss() }
        }
      }
    }
  }
}
