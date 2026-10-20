// The fork's own scheme is orca-cc://, which the App Store app (orca://) cannot take over.
export type VoiceLinkRoute = '/new-task' | '/voice-mode'

// Why: Expo Router reports a host-only custom-scheme link such as orca://new-task as an unmatched
// route (the same reason orca://pair is routed by hand in the root layout), so these links are
// matched here and sent to their screens explicitly.
export function voiceLinkRoute(url: string): VoiceLinkRoute | null {
  const match = /^orca(?:-cc)?:\/\/\/?(new-task|voice-mode)\/?(?:[?#].*)?$/i.exec(url.trim())
  if (!match) {
    return null
  }
  return match[1]?.toLowerCase() === 'new-task' ? '/new-task' : '/voice-mode'
}
