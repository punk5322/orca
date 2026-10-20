import type { RpcClient } from '../transport/rpc-client'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { workspaceNameForTask, workspaceTitleForTask } from './task-naming'

export type VoiceProject = {
  id: string
  repo: string
  name: string
  path: string | null
  isMain: boolean
  repoId: string | null
}
export type VoicePastSession = {
  sessionId: string
  agent: 'claude' | 'codex'
  title: string
  updatedAt: number
}
export type VoiceChat = { sessionId: string; title: string; isActive: boolean }

type Row = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The workspaces on the desktop, for picking where to talk. Archived ones are left out. */
export async function listProjects(client: RpcClient): Promise<VoiceProject[]> {
  const reply = await client.sendRequest('worktree.ps', {})
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  const rows = (reply.result as { worktrees?: Row[] } | null)?.worktrees ?? []
  return rows.flatMap((row) => {
    const id = str(row.worktreeId)
    if (!id || row.isArchived === true) {
      return []
    }
    return [
      {
        id,
        repo: str(row.repo) ?? 'Other',
        name: str(row.displayName) ?? id,
        path: str(row.path),
        isMain: row.isMainWorktree === true,
        repoId: str(row.repoId)
      }
    ]
  })
}

/** The agent chats open in one workspace. */
export async function listChats(client: RpcClient, worktreeId: string): Promise<VoiceChat[]> {
  const reply = await client.sendRequest('session.tabs.list', { worktree: `id:${worktreeId}` })
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  const tabs = (reply.result as { tabs?: Row[] } | null)?.tabs ?? []
  return tabs.flatMap((tab) => {
    const sessionId = tab.type === 'agent-session' ? str(tab.sessionId) : null
    return sessionId
      ? [{ sessionId, title: str(tab.title) ?? 'Chat', isActive: tab.isActive === true }]
      : []
  })
}

const PAST_SESSION_SCAN_LIMIT = 80
const PAST_SESSION_SHOWN = 8

function insideProject(cwd: string, path: string): boolean {
  return cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`)
}

/**
 * Recent Claude and Codex sessions that ran in this project's folder, newest first. Only those two
 * agents have a chat that can adopt a past conversation. Best effort: any failure is an empty list,
 * since continuing a session is an extra and must not block starting a new chat.
 */
export async function listPastSessions(
  client: RpcClient,
  project: VoiceProject
): Promise<VoicePastSession[]> {
  if (!project.path) {
    return []
  }
  try {
    const reply = await client.sendRequest('aiVault.listSessions', {
      scopePaths: [project.path],
      limit: PAST_SESSION_SCAN_LIMIT
    })
    if (!reply.ok) {
      return []
    }
    const rows = (reply.result as { sessions?: Row[] } | null)?.sessions ?? []
    return rows
      .flatMap((row): VoicePastSession[] => {
        const sessionId = str(row.sessionId)
        const cwd = str(row.cwd)
        const agent = row.agent
        if (!sessionId || !cwd || (agent !== 'claude' && agent !== 'codex')) {
          return []
        }
        // The scan widens discovery rather than narrowing it, so keep only this project's own.
        if (!insideProject(cwd, project.path as string)) {
          return []
        }
        const updated = Date.parse(str(row.updatedAt) ?? str(row.modifiedAt) ?? '')
        return [
          {
            sessionId,
            agent,
            title: str(row.title) ?? 'Untitled session',
            updatedAt: Number.isNaN(updated) ? 0 : updated
          }
        ]
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PAST_SESSION_SHOWN)
  } catch {
    return []
  }
}

const CREATE_WORKSPACE_TIMEOUT_MS = 90_000

/** A new branch and workspace for one dictated task, in the same repo as `project`. */
export async function createTaskWorkspace(
  client: RpcClient,
  project: VoiceProject,
  task: string
): Promise<VoiceProject> {
  if (!project.repoId) {
    throw new Error('Could not tell which repo to branch in.')
  }
  const suffix = randomV4Uuid().slice(0, 4)
  const reply = await client.sendRequest(
    'worktree.create',
    {
      repo: `id:${project.repoId}`,
      name: workspaceNameForTask(task, suffix),
      displayName: workspaceTitleForTask(task),
      nameWasGenerated: false,
      // Why: a retry after a lost reply must not make a second branch.
      clientMutationId: randomV4Uuid()
    },
    { timeoutMs: CREATE_WORKSPACE_TIMEOUT_MS }
  )
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  const created = (reply.result as { worktree?: Row } | null)?.worktree
  const id = str(created?.id)
  if (!id) {
    throw new Error('The desktop did not say which workspace it created.')
  }
  return {
    id,
    repo: project.repo,
    name: str(created?.displayName) ?? workspaceTitleForTask(task),
    path: null,
    isMain: false,
    repoId: project.repoId
  }
}
