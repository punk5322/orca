// Whether the voice mode screen is mid-conversation. Hands-free alerts stay quiet meanwhile, so a
// finished agent elsewhere does not talk over a conversation the user is having.
let active = false

export function isVoiceModeActive(): boolean {
  return active
}

export function setVoiceModeActive(on: boolean): void {
  active = on
}
