import { useEffect, useRef } from 'react'
import { useRpcClientContext } from '../transport/client-context'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { loadHosts } from '../transport/host-store'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import { nativeWatchBridge } from './native-watch-bridge'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { sendMobileStructuredAgentSessionMessage } from '../session/mobile-structured-agent-session-send'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'

// Why: the watch keeps no relay credentials. It asks this phone, which already holds the paired,
// end-to-end encrypted host connection, and the phone forwards over the same RPC the app uses.

const CONNECT_WAIT_MS = 10_000
const POLL_MS = 250
const SEND_TIMEOUT_MS = 15_000
const FENCE_WAIT_MS = 8_000
const DICTATION_SAMPLE_RATE = 16_000
const DICTATION_FINISH_TIMEOUT_MS = 30_000

type WatchRequest =
  | { op: 'worktrees' }
  | { op: 'terminals'; worktreeId: string }
  | { op: 'send'; kind: 'terminal' | 'agent'; ref: string; text: string }
  | { op: 'dictStart' }
  | { op: 'dictChunk'; id: string; audio: string }
  | { op: 'dictFinish'; id: string }
  | { op: 'dictCancel'; id: string }

type Row = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

// shortcut: always uses the first paired host; add a host picker on the watch if you pair several.
async function readyClient(
  ctx: RpcClientContextValue,
  acquisition: HostClientAcquisition
): Promise<{ client: RpcClient; deviceToken: string | null }> {
  const host = (await loadHosts())[0]
  if (!host) {
    throw new Error('No paired desktop. Pair one in the Orca phone app.')
  }
  const deadline = Date.now() + CONNECT_WAIT_MS
  while (Date.now() < deadline) {
    const client = ctx.acquire(host.id, acquisition, host)
    if (client && ctx.getState(host.id) === 'connected') {
      return { client, deviceToken: host.deviceToken }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error('Could not reach your desktop. Is Orca running?')
}

async function handle(
  request: WatchRequest,
  ctx: RpcClientContextValue,
  acquisition: HostClientAcquisition
): Promise<Record<string, unknown>> {
  const { client, deviceToken } = await readyClient(ctx, acquisition)
  if (request.op === 'dictStart') {
    const id = randomV4Uuid()
    const started = await client.sendRequest('speech.dictation.start', { dictationId: id })
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    return { ok: true, id }
  }
  if (request.op === 'dictChunk') {
    // The watch records 16 kHz mono 16-bit PCM, which is what the desktop's dictation decodes.
    const fed = await client.sendRequest('speech.dictation.chunk', {
      dictationId: request.id,
      audioBase64: request.audio,
      sampleRate: DICTATION_SAMPLE_RATE
    })
    if (!fed.ok) {
      throw new Error(fed.error.message)
    }
    return { ok: true }
  }
  if (request.op === 'dictFinish') {
    const done = await client.sendRequest(
      'speech.dictation.finish',
      { dictationId: request.id },
      { timeoutMs: DICTATION_FINISH_TIMEOUT_MS }
    )
    if (!done.ok) {
      throw new Error(done.error.message)
    }
    return { ok: true, text: str((done.result as { text?: unknown } | null)?.text) ?? '' }
  }
  if (request.op === 'dictCancel') {
    await client.sendRequest('speech.dictation.cancel', { dictationId: request.id })
    return { ok: true }
  }
  if (request.op === 'worktrees') {
    const reply = await client.sendRequest('worktree.ps', {})
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    const rows = (reply.result as { worktrees?: Row[] } | null)?.worktrees ?? []
    const worktrees = rows.flatMap((row) => {
      const id = str(row.worktreeId)
      if (!id || row.isArchived === true) {
        return []
      }
      const name = str(row.displayName) ?? id
      const repo = str(row.repo)
      return [{ id, name: repo ? `${repo} · ${name}` : name }]
    })
    return { ok: true, worktrees }
  }
  if (request.op === 'terminals') {
    const reply = await client.sendRequest('session.tabs.list', {
      worktree: `id:${request.worktreeId}`
    })
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    const tabs = (reply.result as { tabs?: Row[] } | null)?.tabs ?? []
    // Why: Orca's agent chats are `agent-session` tabs with no terminal handle; they take dictated
    // text through agentSession.send, so the watch treats them as targets too.
    const terminals = tabs.flatMap((tab) => {
      const title = str(tab.title) ?? 'Terminal'
      if (tab.type === 'terminal' && str(tab.terminal)) {
        return [{ kind: 'terminal', ref: str(tab.terminal), title }]
      }
      if (tab.type === 'agent-session' && str(tab.sessionId)) {
        return [{ kind: 'agent', ref: str(tab.sessionId), title }]
      }
      return []
    })
    // Why: a worktree with only chats or files would otherwise look empty with no explanation.
    const others = tabs.flatMap((tab) =>
      (tab.type === 'terminal' && str(tab.terminal)) ||
      (tab.type === 'agent-session' && str(tab.sessionId))
        ? []
        : [`${str(tab.type) ?? 'tab'}: ${str(tab.title) ?? ''}`]
    )
    return { ok: true, terminals, others }
  }
  if (request.kind === 'agent') {
    return sendToAgentSession(client, request.ref, request.text)
  }
  const reply = await client.sendRequest(
    'terminal.send',
    buildTerminalSendParams({
      terminal: request.ref,
      text: request.text,
      enter: true,
      deviceToken
    }),
    { ...TERMINAL_INPUT_SEND_OPTIONS, timeoutMs: SEND_TIMEOUT_MS }
  )
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  const accepted = (reply.result as { send?: { accepted?: boolean } } | null)?.send?.accepted
  if (accepted !== true) {
    throw new Error('Terminal input is locked by another client.')
  }
  return { ok: true }
}

// The host rejects a send whose fence is stale, so read the chat's current fence from the first
// frame of its stream, then send with it.
function readAgentSessionFence(client: RpcClient, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let close = (): void => {}
    let done = false
    const finish = (settle: () => void): void => {
      if (!done) {
        done = true
        clearTimeout(timer)
        close()
        settle()
      }
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('Chat did not answer'))),
      FENCE_WAIT_MS
    )
    close = client.subscribe('agentSession.subscribe', { sessionId }, (frame) => {
      const event = frame as { type?: unknown; fence?: unknown }
      if (event.type === 'snapshot' && typeof event.fence === 'number') {
        const fence = event.fence
        finish(() => resolve(fence))
      }
    })
    if (done) {
      close()
    }
  })
}

async function sendToAgentSession(
  client: RpcClient,
  sessionId: string,
  text: string
): Promise<Record<string, unknown>> {
  const expectedRuntimeFence = await readAgentSessionFence(client, sessionId)
  let failure = 'Message not sent'
  const outcome = await sendMobileStructuredAgentSessionMessage({
    client,
    sessionId,
    expectedRuntimeFence,
    text,
    attachments: [],
    clientMessageId: structuredSessionOperationId(),
    onError: (message) => {
      failure = String(message)
    }
  })
  if (outcome === 'accepted') {
    return { ok: true }
  }
  // 'unknown' may still have been delivered, so say so rather than inviting a double send.
  throw new Error(outcome === 'unknown' ? 'Sent, but no confirmation. Check desktop.' : failure)
}

export function useWatchBridge(): void {
  const ctx = useRpcClientContext()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  useEffect(() => {
    if (!nativeWatchBridge) {
      return
    }
    const acquisition: HostClientAcquisition = {}
    const subscription = nativeWatchBridge.addListener('onWatchRequest', ({ id, json }) => {
      void (async () => {
        let body: Record<string, unknown>
        try {
          body = await handle(JSON.parse(json) as WatchRequest, ctxRef.current, acquisition)
        } catch (error) {
          body = { ok: false, error: error instanceof Error ? error.message : 'Request failed' }
        }
        await nativeWatchBridge?.respond(id, JSON.stringify(body))
      })()
    })
    return () => {
      subscription.remove()
      for (const { hostId } of ctxRef.current.getAllClients()) {
        ctxRef.current.release(hostId, acquisition)
      }
    }
  }, [])
}
