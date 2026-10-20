// Whether hands-free mode is on. Not persisted: it keeps the app awake and the microphone ready, so
// it always starts off and the user turns it on deliberately.
let enabled = false
const listeners = new Set<() => void>()

export function isHandsFreeActive(): boolean {
  return enabled
}

export function setHandsFreeActive(on: boolean): void {
  if (enabled === on) {
    return
  }
  enabled = on
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeHandsFree(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
