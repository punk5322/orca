import type { RpcClient } from '../transport/rpc-client'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../src/shared/agent-session-turn-record'

export type ChatReply =
  | { kind: 'text'; text: string }
  | { kind: 'needs-you'; what: 'approval' | 'question'; detail: string }
  | { kind: 'none' }

type Frame = {
  type?: unknown
  page?: { items?: AgentJournalRenderItem[]; removedItemIds?: string[] }
  batch?: { items?: AgentJournalRenderItem[]; removedItemIds?: string[] }
  fence?: unknown
}

const START_WAIT_MS = 25_000
const POLL_MS = 1_000
const SETTLE_MS = 700

function order(a: AgentJournalRenderItem, b: AgentJournalRenderItem): number {
  return a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
}

function assistantText(body: AgentJournalItemBody): string {
  if (body.kind !== 'message' || body.role !== 'assistant') {
    return ''
  }
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

// Follows one chat's journal over its subscription so a spoken turn can wait for the agent's reply:
// note where the journal stands before sending, then read what the agent wrote after that point
// once its turn has ended.
export class ChatTracker {
  private readonly items = new Map<string, AgentJournalRenderItem>()
  private readonly wakers = new Set<() => void>()
  private closeStream: () => void = () => {}
  readonly ready: Promise<void>

  constructor(client: RpcClient, sessionId: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      let first = true
      const timer = setTimeout(() => reject(new Error('The chat did not answer.')), 10_000)
      this.closeStream = client.subscribe('agentSession.subscribe', { sessionId }, (raw) => {
        const frame = raw as Frame
        this.apply(frame)
        if (first && (frame.type === 'snapshot' || frame.type === 'reset')) {
          first = false
          clearTimeout(timer)
          resolve()
        }
        for (const wake of this.wakers) {
          wake()
        }
      })
    })
  }

  close(): void {
    this.closeStream()
  }

  /** Where the journal stands now; anything the agent writes after this is the reply. */
  mark(): number {
    let top = -1
    for (const item of this.items.values()) {
      top = Math.max(top, item.sequence)
    }
    return top
  }

  private apply(frame: Frame): void {
    const replace = frame.type === 'snapshot' || frame.type === 'reset'
    const source = replace ? frame.page : frame.type === 'batch' ? frame.batch : undefined
    if (!source) {
      return
    }
    if (replace) {
      this.items.clear()
    }
    for (const item of source.items ?? []) {
      const known = this.items.get(item.itemId)
      if (!known || item.revision >= known.revision) {
        this.items.set(item.itemId, item)
      }
    }
    for (const id of source.removedItemIds ?? []) {
      this.items.delete(id)
    }
  }

  private evaluate(after: number): 'waiting' | 'not-started' | ChatReply {
    const fresh = [...this.items.values()].filter((item) => item.sequence > after).sort(order)
    for (const item of fresh) {
      const body = item.body
      if (
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending'
      ) {
        return {
          kind: 'needs-you',
          what: body.kind,
          detail: body.kind === 'approval' ? body.title : body.question
        }
      }
    }
    const turns = fresh.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
    if (turns.length === 0) {
      return 'not-started'
    }
    if (turns.some((turn) => turn.state === 'running')) {
      return 'waiting'
    }
    // The session's own agent only: subagents write into the same journal.
    const text = fresh
      .filter((item) => !item.agentId)
      .map((item) => assistantText(item.body))
      .filter(Boolean)
      .join('\n')
      .trim()
    return text ? { kind: 'text', text } : { kind: 'none' }
  }

  /** Resolves when the turn sent after `after` has ended; rejects if `signal` aborts. */
  async reply(after: number, signal: AbortSignal): Promise<ChatReply> {
    const startedAt = Date.now()
    let settledAt: number | null = null
    for (;;) {
      if (signal.aborted) {
        throw new Error('stopped')
      }
      const state = this.evaluate(after)
      if (state === 'not-started') {
        if (Date.now() - startedAt > START_WAIT_MS) {
          return { kind: 'none' }
        }
        settledAt = null
      } else if (state === 'waiting') {
        settledAt = null
      } else if (state.kind === 'needs-you') {
        return state
      } else {
        // Let the final batch land before reading the finished reply.
        settledAt ??= Date.now()
        if (Date.now() - settledAt >= SETTLE_MS) {
          return state
        }
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.wakers.delete(done)
          signal.removeEventListener('abort', done)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(done, settledAt === null ? POLL_MS : 200)
        this.wakers.add(done)
        signal.addEventListener('abort', done)
      })
    }
  }
}
