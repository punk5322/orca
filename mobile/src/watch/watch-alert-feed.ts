// Why: the phone already receives the desktop's notification stream; this fans the events worth a
// wrist tap out to whoever listens (the watch bridge) without a second subscription.
export type WatchAlert = {
  title: string
  body: string
  worktreeId: string | null
  /** The agent's state when the desktop reported it, e.g. waiting for input. */
  agentState: string | null
}

type Listener = (alert: WatchAlert) => void

const listeners = new Set<Listener>()
// Why: the home screen and hands-free mode can both hold a notification subscription, so the same
// event can arrive twice; remember recent ones and drop repeats.
const seen: string[] = []
const SEEN_MAX = 50

export function onWatchAlert(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Takes a raw `notifications.subscribe` frame; ignores everything but finished-agent events. */
export function publishDesktopNotification(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) {
    return
  }
  const event = frame as Record<string, unknown>
  // shortcut: only agent completions alert the watch; add terminal-bell or plugin events if wanted.
  if (event.type !== 'notification' || event.source !== 'agent-task-complete') {
    return
  }
  const key = text(event.notificationId) ?? `${String(event.emittedAt)}:${text(event.title)}`
  if (seen.includes(key)) {
    return
  }
  seen.push(key)
  if (seen.length > SEEN_MAX) {
    seen.shift()
  }
  const alert: WatchAlert = {
    title: text(event.title) ?? 'Orca',
    body: text(event.body) ?? '',
    worktreeId: text(event.worktreeId),
    agentState: text(event.agentState)
  }
  for (const listener of listeners) {
    listener(alert)
  }
}
