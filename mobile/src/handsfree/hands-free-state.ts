// Whether hands-free mode is on. Not persisted: it keeps the app awake and the microphone ready, so
// it always starts off and the user turns it on deliberately.
let enabled = false
const listeners = new Set<() => void>()

// Where a start attempt stands, so a caller (the watch) can wait for the real outcome instead of
// assuming the switch took. `failed` is kept after the mode turns itself off, so the reason survives.
export type HandsFreeStatus = 'off' | 'starting' | 'on' | 'failed'
let status: HandsFreeStatus = 'off'
let failure: string | null = null

export function isHandsFreeActive(): boolean {
  return enabled
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setHandsFreeActive(on: boolean): void {
  if (enabled === on) {
    return
  }
  enabled = on
  if (on) {
    status = 'starting'
    failure = null
  } else if (status !== 'failed') {
    status = 'off'
  }
  notify()
}

export function reportHandsFreeReady(): void {
  status = 'on'
  notify()
}

export function reportHandsFreeFailed(message: string): void {
  status = 'failed'
  failure = message
  notify()
}

export function handsFreeFailure(): string | null {
  return failure
}

/** Resolves once a start attempt has either worked or failed, or after the timeout. */
export function waitForHandsFreeStart(timeoutMs: number): Promise<HandsFreeStatus> {
  return new Promise((resolve) => {
    if (status !== 'starting') {
      resolve(status)
      return
    }
    const done = (): void => {
      if (status !== 'starting') {
        clearTimeout(timer)
        listeners.delete(done)
        resolve(status)
      }
    }
    const timer = setTimeout(() => {
      listeners.delete(done)
      resolve(status)
    }, timeoutMs)
    listeners.add(done)
  })
}

export function subscribeHandsFree(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
