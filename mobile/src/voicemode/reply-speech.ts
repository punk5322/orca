const FIRST_CHUNK_MAX = 320
const MORE_CHUNK_MAX = 600
const READ_MORE =
  /^(read (me )?(the )?(rest|more|it all|the whole (thing|reply))|tell me more|keep going|go on)\b/i

export function isReadMore(heard: string): boolean {
  return READ_MORE.test(heard.trim())
}

type Spoken = { spoken: string; rest: string[] }

function plainSentences(text: string): { sentences: string[]; hadCode: boolean } {
  const hadCode = /```/.test(text)
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*\d.\s]+/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = plain ? (plain.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [plain]) : []
  return { sentences: sentences.map((sentence) => sentence.trim()).filter(Boolean), hadCode }
}

function takeChunk(sentences: string[], max: number): { chunk: string; rest: string[] } {
  let chunk = ''
  let used = 0
  while (used < sentences.length) {
    const next = sentences[used] ?? ''
    if (chunk && `${chunk} ${next}`.length > max) {
      break
    }
    chunk = chunk ? `${chunk} ${next}` : next
    used += 1
  }
  return { chunk, rest: sentences.slice(used) }
}

// What is read first: a few plain sentences, with the rest kept so "read more" can continue.
export function spokenReply(text: string): Spoken {
  const { sentences, hadCode } = plainSentences(text)
  if (sentences.length === 0) {
    return { spoken: hadCode ? 'I left some code in the chat.' : 'Done.', rest: [] }
  }
  const { chunk, rest } = takeChunk(sentences, FIRST_CHUNK_MAX)
  const tail =
    rest.length > 0
      ? ' Say read more to hear the rest.'
      : hadCode
        ? ' I left the code in the chat.'
        : ''
  return { spoken: `${chunk}${tail}`, rest }
}

/** The next stretch of a reply for "read more". */
export function moreOfReply(rest: string[]): Spoken {
  if (rest.length === 0) {
    return { spoken: "That's everything.", rest: [] }
  }
  const { chunk, rest: remaining } = takeChunk(rest, MORE_CHUNK_MAX)
  return {
    spoken: remaining.length > 0 ? `${chunk} Say read more to keep going.` : chunk,
    rest: remaining
  }
}
