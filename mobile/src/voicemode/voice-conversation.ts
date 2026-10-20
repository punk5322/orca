import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { readyClient, sendToAgentSession } from '../watch/use-watch-bridge'
import { listenAndTranscribe } from '../handsfree/hands-free-session'
import { acquireAudio } from '../handsfree/audio-lease'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import { ChatTracker } from './chat-tracker'
import { setVoiceModeActive } from './voice-mode-state'
import { beginActivity, endActivity, updateActivity } from '../handsfree/live-activity'
import { isReadMore, moreOfReply, spokenReply } from './reply-speech'
import {
  approvalSpeech,
  classifyDecision,
  pickApprovalOptions,
  type ApprovalPrompt
} from './voice-approvals'
import { requestStructuredAgentSessionMutation } from '../session/mobile-structured-agent-session-rpc'

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
const MAX_APPROVALS_PER_TURN = 8
// Added once, to the first message, so replies come back short enough to listen to.
const VOICE_STYLE_HINT =
  " (I'm talking to you by voice, so reply in a few short spoken sentences, without code blocks or lists unless I ask.)"

export class VoiceConversation {
  private running = false
  private abort = new AbortController()
  private release: () => Promise<void> = async () => {}
  private tracker: ChatTracker | null = null
  // What of the last reply has not been read aloud yet, for "read more".
  private unread: string[] = []
  private client: RpcClient | null = null
  private readonly acquisition: HostClientAcquisition = {}

  constructor(
    private readonly getCtx: () => RpcClientContextValue,
    private readonly sessionId: string,
    private readonly callbacks: VoiceCallbacks,
    /** A message to send first instead of listening, e.g. the task just dictated. */
    private readonly firstMessage?: string
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
      beginActivity('voice', 'Voice mode')
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
    endActivity('voice')
    setVoiceModeActive(false)
    this.callbacks.onState('idle')
  }

  private async fail(error: unknown): Promise<void> {
    this.callbacks.onNotice(error instanceof Error ? error.message : 'Voice mode stopped.')
    await this.stop()
    this.callbacks.onEnded()
  }

  // Also drives the lock screen card, so the state shown there is always the one on screen.
  private emitState(state: VoiceState): void {
    this.callbacks.onState(state)
    if (state !== 'idle') {
      updateActivity('voice', state)
    }
  }

  private async say(text: string, interruptible = false): Promise<void> {
    this.emitState('speaking')
    await nativeHandsFree?.speak(text, interruptible)
  }

  // Reads a permission request aloud and acts only on a clear "go ahead" (or a refusal). Anything
  // else leaves the request waiting in the chat. Returns whether it was answered.
  private async resolveApproval(
    client: RpcClient,
    tracker: ChatTracker,
    prompt: ApprovalPrompt
  ): Promise<boolean> {
    const { allow, deny } = pickApprovalOptions(prompt.options)
    if (!allow || !deny) {
      this.callbacks.onNotice(`Needs you in the chat: ${prompt.title}`)
      await this.say('This one needs you. Check the chat.')
      return false
    }
    this.callbacks.onNotice(`Permission needed: ${prompt.title}`)
    let ask = approvalSpeech(prompt)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.say(ask)
      this.emitState('listening')
      const heard = await listenAndTranscribe(client)
      if (!this.running) {
        return false
      }
      const decision = classifyDecision(heard)
      if (decision === 'unclear') {
        ask = 'Say go ahead to allow it, or hold off to refuse.'
        continue
      }
      if (tracker.fence === null) {
        await this.say("I can't answer that right now. Check the chat.")
        return false
      }
      const result = await requestStructuredAgentSessionMutation({
        client,
        method: 'agentSession.respondToApproval',
        fingerprintMethod: 'agentSession.respondTo:approval',
        sessionId: this.sessionId,
        expectedRuntimeFence: tracker.fence,
        fields: {
          itemId: prompt.itemId,
          expectedRevision: prompt.revision,
          optionId: decision === 'allow' ? allow.id : deny.id
        }
      })
      if (result.status !== 'accepted') {
        await this.say("That didn't go through. Check the chat.")
        return false
      }
      this.callbacks.onNotice(`${decision === 'allow' ? 'Allowed' : 'Refused'}: ${prompt.title}`)
      await this.say(decision === 'allow' ? 'Going ahead.' : 'Held off.')
      return true
    }
    await this.say("I'll leave it for you in the chat.")
    return false
  }

  private async loop(): Promise<void> {
    const client = this.client
    const tracker = this.tracker
    if (!client || !tracker) {
      return
    }
    let emptyRounds = 0
    let firstMessage = true
    let readyMade = this.firstMessage
    while (this.running) {
      let heard: string
      const useReadyMade = readyMade !== undefined
      if (useReadyMade) {
        heard = readyMade as string
        readyMade = undefined
      } else {
        this.emitState('listening')
        try {
          heard = await listenAndTranscribe(client)
        } catch (error) {
          await this.fail(error)
          return
        }
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
      if (!useReadyMade && isReadMore(heard)) {
        const more = moreOfReply(this.unread)
        this.unread = more.rest
        await this.say(more.spoken, true)
        continue
      }
      if (!useReadyMade && END_PHRASE.test(heard)) {
        await this.say('Goodbye.')
        await this.stop()
        this.callbacks.onEnded()
        return
      }
      if (!useReadyMade && CANCEL_PHRASE.test(heard)) {
        continue
      }
      this.callbacks.onUserText(heard)
      updateActivity('voice', 'thinking', heard)
      this.emitState('thinking')
      try {
        const after = tracker.mark()
        await sendToAgentSession(
          client,
          this.sessionId,
          firstMessage ? heard + VOICE_STYLE_HINT : heard
        )
        firstMessage = false
        let reply = await tracker.reply(after, this.abort.signal)
        // A permission request pauses the turn; once answered, wait for the turn to carry on.
        for (
          let approvals = 0;
          reply.kind === 'approval' && this.running && approvals < MAX_APPROVALS_PER_TURN;
          approvals += 1
        ) {
          if (!(await this.resolveApproval(client, tracker, reply.prompt))) {
            break
          }
          this.emitState('thinking')
          reply = await tracker.reply(after, this.abort.signal)
        }
        if (!this.running) {
          return
        }
        if (reply.kind === 'text') {
          this.callbacks.onReplyText(reply.text)
          updateActivity('voice', 'speaking', reply.text)
          const { spoken, rest } = spokenReply(reply.text)
          this.unread = rest
          // Interruptible: talking over it, or a play/pause press, cuts in and becomes the reply.
          await this.say(spoken, true)
        } else if (reply.kind === 'approval') {
          // Left unanswered above; it waits in the chat.
        } else if (reply.kind === 'question') {
          this.callbacks.onNotice(`The agent has a question: ${reply.detail}`)
          await this.say('The agent has a question. Check the chat.')
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
