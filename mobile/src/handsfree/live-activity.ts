import { nativeHandsFree } from './native-hands-free'

export type ActivityPhase = 'idle' | 'listening' | 'thinking' | 'speaking'

type Owner = 'hands-free' | 'voice'

// Why: hands-free mode and the voice screen can both be on, but the lock screen shows one card. The
// most recent owner drives it, and the card ends only when the last owner is done.
const owners: { owner: Owner; phase: ActivityPhase; detail: string }[] = []

function detailText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat
}

function swallow(promise: Promise<void> | undefined): void {
  void promise?.catch(() => undefined)
}

export function beginActivity(owner: Owner, title: string, detail = ''): void {
  const native = nativeHandsFree
  if (!native) {
    return
  }
  const entry = { owner, phase: 'idle' as ActivityPhase, detail: detailText(detail) }
  const existing = owners.findIndex((candidate) => candidate.owner === owner)
  if (existing >= 0) {
    owners.splice(existing, 1)
  }
  owners.push(entry)
  swallow(native.activityStart(title, entry.phase, entry.detail))
}

export function updateActivity(owner: Owner, phase: ActivityPhase, detail?: string): void {
  const native = nativeHandsFree
  const entry = owners.find((candidate) => candidate.owner === owner)
  if (!native || !entry) {
    return
  }
  entry.phase = phase
  if (detail !== undefined) {
    entry.detail = detailText(detail)
  }
  // Only the owner driving the card may change it.
  if (owners[owners.length - 1] === entry) {
    swallow(native.activityUpdate(entry.phase, entry.detail))
  }
}

export function endActivity(owner: Owner): void {
  const native = nativeHandsFree
  const index = owners.findIndex((candidate) => candidate.owner === owner)
  if (!native || index < 0) {
    return
  }
  owners.splice(index, 1)
  const next = owners[owners.length - 1]
  swallow(next ? native.activityUpdate(next.phase, next.detail) : native.activityEnd())
}
