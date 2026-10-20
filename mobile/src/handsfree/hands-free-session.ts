import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { readyClient, sendToAgentSession } from '../watch/use-watch-bridge'
import {
  onWatchAlert,
  publishDesktopNotification,
  type WatchAlert
} from '../watch/watch-alert-feed'
import { nativeHandsFree } from './native-hands-free'
import { acquireAudio } from './audio-lease'
import { beginActivity, endActivity, updateActivity } from './live-activity'
import { isVoiceModeActive } from '../voicemode/voice-mode-state'

const DICTATION_SAMPLE_RATE = 16_000
const LISTEN_CEILING_MS = 70_000
const SPOKEN_BODY_MAX = 200
const GIST_MAX = 140
const CANCEL_PHRASE = /^(cancel|never ?mind|skip|ignore|nothing|no)\b/i

type Row = Record<string, unknown>

function trimForSpeech(text: string): string {
  return text.length > SPOKEN_BODY_MAX ? `${text.slice(0, SPOKEN_BODY_MAX)}…` : text
}

// The title reads "project · worktree - Claude finished"; spoken, only the part after the last dash
// matters. The body is a preview of the agent's last message: one plain sentence is the gist.
function spokenSummary(alert: WatchAlert): string {
  const dash = alert.title.lastIndexOf(' - ')
  const status = dash >= 0 ? alert.title.slice(dash + 3) : alert.title
  const plain = alert.body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = plain.match(/^.{20,}?[.!?](\s|$)/)?.[0].trim() ?? plain
  const gist = sentence.length > GIST_MAX ? `${sentence.slice(0, GIST_MAX).trim()}…` : sentence
  return gist && gist !== status ? `${status}. ${gist}` : status
}

// Right after the audio session starts the microphone can need a moment, and native.listen rejects
// until it is ready; give it a few short tries before giving up.
async function listenWithRetry(native: { listen: () => Promise<void> }): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await native.listen()
      return
    } catch (error) {
      if (attempt >= 6) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}

// One listen: stream the microphone to the desktop's speech model, return what was said.
export async function listenAndTranscribe(client: RpcClient): Promise<string> {
  const native = nativeHandsFree
  if (!native) {
    throw new Error('Hands-free is not available in this build')
  }
  const dictationId = randomV4Uuid()
  const started = await client.sendRequest('speech.dictation.start', { dictationId })
  if (!started.ok) {
    throw new Error(started.error.message)
  }
  // Chunks go one at a time so the desktop receives the audio in order.
  let queue: Promise<void> = Promise.resolve()
  let failure: Error | null = null
  const chunks = native.addListener('onChunk', ({ audio }) => {
    queue = queue
      .then(async () => {
        const fed = await client.sendRequest('speech.dictation.chunk', {
          dictationId,
          audioBase64: audio,
          sampleRate: DICTATION_SAMPLE_RATE
        })
        if (!fed.ok) {
          throw new Error(fed.error.message)
        }
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error))
      })
  })
  let ended: () => void = () => {}
  const endedPromise = new Promise<void>((resolve) => {
    ended = resolve
  })
  const endedSub = native.addListener('onListenEnded', () => ended())
  const ceiling = setTimeout(() => void native.stopListening(), LISTEN_CEILING_MS)
  try {
    await listenWithRetry(native)
    await endedPromise
    await queue
  } finally {
    clearTimeout(ceiling)
    chunks.remove()
    endedSub.remove()
  }
  if (failure) {
    await client.sendRequest('speech.dictation.cancel', { dictationId }).catch(() => undefined)
    throw failure
  }
  const done = await client.sendRequest(
    'speech.dictation.finish',
    { dictationId },
    { timeoutMs: 30_000 }
  )
  if (!done.ok) {
    throw new Error(done.error.message)
  }
  const text = (done.result as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text.trim() : ''
}

// The chat that finished is the one to answer: its active chat tab in that workspace.
async function findChat(client: RpcClient, worktreeId: string): Promise<string | null> {
  const reply = await client.sendRequest('session.tabs.list', { worktree: `id:${worktreeId}` })
  if (!reply.ok) {
    return null
  }
  const tabs = (reply.result as { tabs?: Row[] } | null)?.tabs ?? []
  const chats = tabs.filter(
    (tab) => tab.type === 'agent-session' && typeof tab.sessionId === 'string'
  )
  const chosen = chats.find((tab) => tab.isActive === true) ?? chats[0]
  return chosen ? (chosen.sessionId as string) : null
}

async function converse(
  alert: WatchAlert,
  getCtx: () => RpcClientContextValue,
  acquisition: HostClientAcquisition
): Promise<void> {
  const native = nativeHandsFree
  if (!native || isVoiceModeActive()) {
    return
  }
  const say = (text: string, interruptible = false): Promise<void> =>
    native.speak(text, interruptible)
  try {
    const { client } = await readyClient(getCtx(), acquisition)
    // Only this first prompt can be interrupted; the confirmations play through.
    updateActivity('hands-free', 'speaking', alert.title)
    await say(`${spokenSummary(alert)} What's next?`, true)
    updateActivity('hands-free', 'listening')
    const heard = await listenAndTranscribe(client)
    updateActivity('hands-free', 'thinking', heard)
    if (!heard) {
      await say("I didn't hear anything.")
      return
    }
    if (CANCEL_PHRASE.test(heard)) {
      await say('Okay.')
      return
    }
    const sessionId = alert.worktreeId ? await findChat(client, alert.worktreeId) : null
    if (!sessionId) {
      await say("I couldn't find a chat to send that to.")
      return
    }
    await say(`Sending: ${trimForSpeech(heard)}`)
    await sendToAgentSession(client, sessionId, heard)
    await say('Sent.')
  } catch (error) {
    await say(error instanceof Error ? error.message : 'Something went wrong.').catch(
      () => undefined
    )
  } finally {
    updateActivity('hands-free', 'idle', '')
  }
}

/** Turns hands-free mode on; returns what turns it off. */
export function startHandsFree(
  getCtx: () => RpcClientContextValue,
  onFatal: (message: string) => void,
  onReady: () => void
): () => void {
  const native = nativeHandsFree
  const acquisition: HostClientAcquisition = {}
  let stopped = false
  let unsubscribe = (): void => {}
  let stopAlerts = (): void => {}
  let release = async (): Promise<void> => {}
  // Alerts that arrive mid-conversation wait their turn instead of talking over each other.
  let queue: Promise<void> = Promise.resolve()

  void (async () => {
    if (!native) {
      onFatal('Hands-free is not available in this build.')
      return
    }
    try {
      release = await acquireAudio()
      const { client } = await readyClient(getCtx(), acquisition)
      if (stopped) {
        return
      }
      // Why: the home screen's own subscription only exists while that screen is mounted; this one
      // lives as long as hands-free does, so alerts keep arriving with the screen locked.
      unsubscribe = client.subscribe(
        'notifications.subscribe',
        { includeDesktopSuppressed: true },
        publishDesktopNotification
      )
      stopAlerts = onWatchAlert((alert) => {
        queue = queue.then(() => converse(alert, getCtx, acquisition))
      })
      onReady()
      beginActivity('hands-free', 'Hands-free', 'Waiting for agents')
      await native.speak('Hands-free is on.', false)
    } catch (error) {
      endActivity('hands-free')
      await release().catch(() => undefined)
      onFatal(error instanceof Error ? error.message : 'Could not start hands-free mode.')
    }
  })()

  return () => {
    endActivity('hands-free')
    stopped = true
    stopAlerts()
    unsubscribe()
    const ctx = getCtx()
    for (const { hostId } of ctx.getAllClients()) {
      ctx.release(hostId, acquisition)
    }
    if (native) {
      void queue
        .then(() => native.speak('Hands-free is off.', false))
        .catch(() => undefined)
        .then(() => release())
        .catch(() => undefined)
    }
  }
}
