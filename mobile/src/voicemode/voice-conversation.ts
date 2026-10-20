import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { readyClient, sendToAgentSession } from '../watch/use-watch-bridge'
import { listenAndTranscribe } from '../handsfree/hands-free-session'
import { acquireAudio } from '../handsfree/audio-lease'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import { ChatTracker } from './chat-tracker'
import { setVoiceModeActive } from './voice-mode-state'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export type VoiceCallbacks = {
  onState: (state: VoiceState) => void
  onUserText: (text: string) => void
  onReplyText: (text: string) => void
  /** A message for the screen, or null to clear it. */
  onNotice: (text: string | null) => void
  /** The conversation ended by itself: an error, "goodbye", or a long silence. */
  onEnded: () => void
}

const END_PHRASE =
  /^(goodbye|good bye|end (the )?(conversation|chat|session)|that'?s all|stop listening|exit)\b/i
const CANCEL_PHRASE = /^(cancel|never ?mind|nothing|no)\b/i
const EMPTY_ROUNDS_BEFORE_PAUSE = 3
const SPOKEN_MAX = 320
// Added once, to the first message, so replies come back short enough to listen to.
const VOICE_STYLE_HINT =
  " (I'm talking to you by voice, so reply in a few short spoken sentences, without code blocks or lists unless I ask.)"

// A reply read aloud: plain sentences up to a limit, with a pointer to the chat for the rest.
export function spokenReply(text: string): string {
  const hadCode = /```/.test(text)
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*\d.\s]+/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) {
    return hadCode ? 'I left some code in the chat.' : 'Done.'
  }
  let out = ''
  for (const sentence of plain.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [plain]) {
    if ((out + sentence).length > SPOKEN_MAX) {
      break
    }
    out += sentence
  }
  out = (out || plain.slice(0, SPOKEN_MAX)).trim()
  if (hadCode) {
    return `${out} I left the code in the chat.`
  }
  return out.length < plain.length ? `${out} The rest is in the chat.` : out
}

export class VoiceConversation {
  private running = false
  private abort = new AbortController()
  private release: () => Promise<void> = async () => {}
  private tracker: ChatTracker | null = null
  private client: RpcClient | null = null
  private readonly acquisition: HostClientAcquisition = {}

  constructor(
    private readonly getCtx: () => RpcClientContextValue,
    private readonly sessionId: string,
    private readonly callbacks: VoiceCallbacks
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    setVoiceModeActive(true)
    this.callbacks.onNotice(null)
    try {
      this.release = await acquireAudio()
      const { client } = await readyClient(this.getCtx(), this.acquisition)
      this.client = client
      this.tracker = new ChatTracker(client, this.sessionId)
      await this.tracker.ready
      if (!this.running) {
        return
      }
      void this.loop()
    } catch (error) {
      await this.fail(error)
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }
    this.running = false
    this.abort.abort()
    const native = nativeHandsFree
    await native?.stopListening().catch(() => undefined)
    await native?.cancelSpeech().catch(() => undefined)
    this.tracker?.close()
    this.tracker = null
    const ctx = this.getCtx()
    for (const { hostId } of ctx.getAllClients()) {
      ctx.release(hostId, this.acquisition)
    }
    await this.release().catch(() => undefined)
    setVoiceModeActive(false)
    this.callbacks.onState('idle')
  }

  private async fail(error: unknown): Promise<void> {
    this.callbacks.onNotice(error instanceof Error ? error.message : 'Voice mode stopped.')
    await this.stop()
    this.callbacks.onEnded()
  }

  private async say(text: string, interruptible = false): Promise<void> {
    this.callbacks.onState('speaking')
    await nativeHandsFree?.speak(text, interruptible)
  }

  private async loop(): Promise<void> {
    const client = this.client
    const tracker = this.tracker
    if (!client || !tracker) {
      return
    }
    let emptyRounds = 0
    let firstMessage = true
    while (this.running) {
      this.callbacks.onState('listening')
      let heard: string
      try {
        heard = await listenAndTranscribe(client)
      } catch (error) {
        await this.fail(error)
        return
      }
      if (!this.running) {
        return
      }
      if (!heard) {
        emptyRounds += 1
        if (emptyRounds >= EMPTY_ROUNDS_BEFORE_PAUSE) {
          this.callbacks.onNotice('Paused after a while with no speech. Tap Start to continue.')
          await this.stop()
          this.callbacks.onEnded()
          return
        }
        continue
      }
      emptyRounds = 0
      if (END_PHRASE.test(heard)) {
        await this.say('Goodbye.')
        await this.stop()
        this.callbacks.onEnded()
        return
      }
      if (CANCEL_PHRASE.test(heard)) {
        continue
      }
      this.callbacks.onUserText(heard)
      this.callbacks.onState('thinking')
      try {
        const after = tracker.mark()
        await sendToAgentSession(
          client,
          this.sessionId,
          firstMessage ? heard + VOICE_STYLE_HINT : heard
        )
        firstMessage = false
        const reply = await tracker.reply(after, this.abort.signal)
        if (!this.running) {
          return
        }
        if (reply.kind === 'text') {
          this.callbacks.onReplyText(reply.text)
          // Interruptible: talking over it, or a play/pause press, cuts in and becomes the reply.
          await this.say(spokenReply(reply.text), true)
        } else if (reply.kind === 'needs-you') {
          const what = reply.what === 'approval' ? 'needs your approval' : 'has a question'
          this.callbacks.onNotice(`The agent ${what}: ${reply.detail}`)
          await this.say(`The agent ${what}. Check the chat.`)
        } else {
          await this.say("I didn't get a reply.")
        }
      } catch (error) {
        if (!this.running) {
          return
        }
        const message = error instanceof Error ? error.message : 'Something went wrong.'
        this.callbacks.onNotice(message)
        await this.say(message.length > 120 ? 'Something went wrong.' : message).catch(
          () => undefined
        )
      }
    }
  }
}
