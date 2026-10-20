import type { RpcClient } from '../transport/rpc-client'
import { listenAndTranscribe } from '../handsfree/hands-free-session'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import type { VoiceProject } from './voice-targets'
import { listOut, rankRepos, repoChoices, type RepoChoice } from './repo-match'
import type { VoiceState } from './voice-conversation'

export type TaskIntake = { repo: string; target: VoiceProject; task: string }

const CONFIDENT_SCORE = 0.8
const CONFIDENT_LEAD = 0.1
const NEAR_SCORE = 0.4
const MAX_SUGGESTIONS = 3
const PROJECT_ATTEMPTS = 3
const TASK_ATTEMPTS = 2
const YES = /^(yes|yeah|yep|yup|correct|right|that one|exactly)\b/i
const CANCEL = /^(cancel|never ?mind|forget it|stop)\b/i

export type IntakeHooks = {
  onState: (state: VoiceState) => void
  /** What was heard, so the screen can show it. */
  onHeard: (label: string, text: string) => void
  signal: AbortSignal
}

// Asks which project, then what the task is, out loud. Returns null if the user backs out.
export async function runTaskIntake(
  client: RpcClient,
  projects: VoiceProject[],
  hooks: IntakeHooks
): Promise<TaskIntake | null> {
  const native = nativeHandsFree
  if (!native) {
    throw new Error('Voice is not available in this build.')
  }
  const check = (): void => {
    if (hooks.signal.aborted) {
      throw new Error('stopped')
    }
  }
  const say = async (text: string): Promise<void> => {
    check()
    hooks.onState('speaking')
    await native.speak(text, false)
    check()
  }
  const hear = async (): Promise<string> => {
    check()
    hooks.onState('listening')
    const heard = await listenAndTranscribe(client)
    check()
    return heard
  }

  const choices = repoChoices(projects)
  if (choices.length === 0) {
    await say("I don't see any projects on your desktop.")
    return null
  }

  let chosen: RepoChoice | null = null
  let suggested: RepoChoice | null = null
  let prompt = 'Which project?'
  for (let attempt = 0; attempt < PROJECT_ATTEMPTS && !chosen; attempt += 1) {
    await say(prompt)
    const heard = await hear()
    hooks.onHeard('Project', heard)
    if (!heard) {
      prompt = "I didn't hear a project name. Which project?"
      suggested = null
      continue
    }
    if (CANCEL.test(heard)) {
      return null
    }
    if (suggested && YES.test(heard)) {
      chosen = suggested
      break
    }
    const ranked = rankRepos(heard, choices)
    const top = ranked[0]
    const second = ranked[1]
    if (
      top &&
      top.score >= CONFIDENT_SCORE &&
      (!second || top.score - second.score >= CONFIDENT_LEAD)
    ) {
      chosen = top.choice
      break
    }
    const near = ranked.filter((entry) => entry.score >= NEAR_SCORE).slice(0, MAX_SUGGESTIONS)
    suggested = near.length === 1 ? (near[0]?.choice ?? null) : null
    prompt = near.length
      ? `Did you mean ${listOut(near.map((entry) => entry.choice.repo))}?`
      : "I didn't recognize that project. Which one?"
  }
  if (!chosen) {
    await say("I couldn't tell which project. Let's try again later.")
    return null
  }

  let task = ''
  prompt = "What's the task?"
  for (let attempt = 0; attempt < TASK_ATTEMPTS && !task; attempt += 1) {
    await say(prompt)
    task = await hear()
    hooks.onHeard('Task', task)
    if (task && CANCEL.test(task)) {
      return null
    }
    prompt = "I didn't catch that. What's the task?"
  }
  if (!task) {
    await say("I didn't hear a task.")
    return null
  }
  await say(`Starting a chat in ${chosen.repo}.`)
  return { repo: chosen.repo, target: chosen.target, task }
}
