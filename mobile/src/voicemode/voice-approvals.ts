export type ApprovalOption = { id: string; label: string }

export type ApprovalPrompt = {
  itemId: string
  revision: number
  title: string
  detail: string | null
  options: ApprovalOption[]
}

export type Decision = 'allow' | 'deny' | 'unclear'

const DETAIL_SPOKEN_MAX = 160

// Deliberately lopsided: allowing something takes a clear "go ahead" or "confirm", while any word
// of refusal wins over it, so a mishearing can only ever lean towards doing nothing.
const ALLOW = /\b(go ahead|confirm|confirmed)\b/i
const DENY =
  /\b(hold off|deny|denied|reject|no|nope|stop|cancel|don'?t|do not|wait|never|negative)\b/i

export function classifyDecision(heard: string): Decision {
  if (DENY.test(heard)) {
    return 'deny'
  }
  return ALLOW.test(heard) ? 'allow' : 'unclear'
}

// Only the plain one-time allow and the plain refusal can be chosen by voice: "allow for this
// session" and similar standing permissions are never picked from speech.
export function pickApprovalOptions(options: ApprovalOption[]): {
  allow: ApprovalOption | null
  deny: ApprovalOption | null
} {
  const standing = /(session|always|forever|remember|all|every)/i
  const allow =
    options.find((option) => option.id === 'allow') ??
    options.find(
      (option) =>
        /^(allow|accept|approve)$/i.test(option.id) &&
        !standing.test(`${option.id} ${option.label}`)
    ) ??
    null
  const deny =
    options.find((option) => option.id === 'deny') ??
    options.find((option) => /^(deny|decline|reject)$/i.test(option.id)) ??
    null
  return { allow, deny }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max).trim()}…` : flat
}

/** What is read aloud: what is being asked, then the exact words that answer it. */
export function approvalSpeech(prompt: ApprovalPrompt): string {
  const detail = prompt.detail ? ` ${clip(prompt.detail, DETAIL_SPOKEN_MAX)}.` : ''
  return `Permission needed. ${prompt.title}${detail} Say go ahead, or hold off.`
}
