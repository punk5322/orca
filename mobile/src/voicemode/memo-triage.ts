import { classifyDecision } from './voice-approvals'

export type TriageTask = {
  repo: string
  title: string
  task: string
  source: string | null
}

const MAX_TASKS = 12
const FIRST_RUN_DAYS = 3

const VOICE_MEMOS_FOLDER = '~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings'
// Recordings can also be dropped here by hand (AirDrop, Files), which does not depend on iCloud.
const MINUTES_INBOX = '~/.minutes/inbox'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// Voice Memos names each recording after its local date and time (20260812 122224.m4a), so the
// cut-off is given the same way: local time, to the minute.
function localStamp(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * What the triage chat is asked to do. It works on the desktop: it finds the voice memos recorded
 * since the last run, has Minutes transcribe only those, and reads the transcripts, so no audio or
 * transcript passes through the phone. It answers in a fixed shape the phone can parse. `since` is
 * when memos were last processed, or null on the first run.
 */
export function buildTriagePrompt(repoNames: string[], since: number | null, now: number): string {
  const cutoff = localStamp(since ?? now - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000)
  return [
    'Help me triage my voice memos into coding tasks. Do not change, create or delete any of my files. The only commands you may run that write anything are `minutes process`, which saves a transcript, and `ffmpeg`, only to write a temporary copy under /tmp.',
    '',
    `1. Find my new voice memos: audio files in ${VOICE_MEMOS_FOLDER} and in ${MINUTES_INBOX}. In the first, each file name starts with its recording date and time (YYYYMMDD HHMMSS, local time); for a file without one, use its modified time. Use only recordings made after ${cutoff}, and ignore every older file.`,
    '2. For each of those, make sure it has a transcript. Minutes saves transcripts as markdown under ~/meetings (memos are in ~/meetings/memos); reuse one that already exists for that recording, and otherwise run `minutes process "<full path to the audio file>"` and read the transcript it writes. Newer Voice Memos recordings are .qta files, which Minutes cannot read directly: first make a temporary copy with `ffmpeg -i "<file>.qta" -c:a aac "/tmp/<name>.m4a"` (never touch the original) and process that. This can take a minute or two per recording.',
    '3. Read the transcripts and pull out each distinct piece of work I asked for, or issue I mentioned, that a coding agent could act on. Skip chatter, conversations with other people, and anything already done.',
    `4. For each, choose the project it belongs to from this exact list: ${repoNames.join(', ')}. If you cannot tell, use "unknown".`,
    '5. Reply with only a JSON array in a ```json fenced block, and nothing else. Each item is {"repo": "<project from the list>", "title": "<five words or fewer>", "task": "<a self-contained instruction for a coding agent that has not heard the memo>", "source": "<audio file name>"}. If there is nothing to do, reply with [].'
  ].join('\n')
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The tasks in a triage reply, or null if no JSON array could be found at all. */
export function parseTriageReply(reply: string): TriageTask[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1]
  const bare = reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1)
  for (const candidate of [fenced, bare]) {
    if (!candidate || !candidate.trim().startsWith('[')) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!Array.isArray(parsed)) {
        continue
      }
      return parsed.slice(0, MAX_TASKS).flatMap((entry): TriageTask[] => {
        const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
          string,
          unknown
        >
        const task = text(row.task)
        return task
          ? [
              {
                repo: text(row.repo) ?? 'unknown',
                title: text(row.title) ?? task.slice(0, 40),
                task,
                source: text(row.source)
              }
            ]
          : []
      })
    } catch {
      // Not valid JSON; try the next candidate.
    }
  }
  return null
}

const START_ALL = /\b(start all|start them all|start them|go ahead|confirm)\b/i

/** Whether a spoken answer clearly means "start them", never leaning that way on a refusal. */
export function saysStartAll(heard: string): boolean {
  return classifyDecision(heard) !== 'deny' && START_ALL.test(heard)
}

/** What is read aloud before asking whether to start. */
export function triageSummary(tasks: { repo: string; title: string }[]): string {
  if (tasks.length === 0) {
    return 'I found no new tasks in your voice memos.'
  }
  const lines = tasks.slice(0, 4).map((task, index) => `${index + 1}. ${task.repo}: ${task.title}.`)
  const more = tasks.length > 4 ? ` And ${tasks.length - 4} more.` : ''
  return `I found ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}. ${lines.join(' ')}${more} Say start all, or tap the ones you want.`
}
