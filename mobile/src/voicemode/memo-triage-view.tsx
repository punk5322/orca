import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronRight } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { readyClient, sendToAgentSession } from '../watch/use-watch-bridge'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import { listenAndTranscribe } from '../handsfree/hands-free-session'
import { acquireAudio } from '../handsfree/audio-lease'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import { ChatTracker } from './chat-tracker'
import { rankRepos, repoChoices } from './repo-match'
import { createTaskWorkspace, type VoiceProject } from './voice-targets'
import {
  buildTriagePrompt,
  parseTriageReply,
  saysStartAll,
  triageSummary,
  type TriageTask
} from './memo-triage'
import {
  getBranchPerTask,
  getMemosProcessedAt,
  getTriageProjectId,
  setMemosProcessedAt,
  setTriageProjectId
} from './voice-preferences'
import { setVoiceModeActive } from './voice-mode-state'

const MATCH_SCORE = 0.8

type Phase = 'choose' | 'working' | 'review' | 'starting' | 'finished'
type Item = {
  task: TriageTask
  target: VoiceProject | null
  selected: boolean
  state: 'idle' | 'started' | 'failed'
  note: string | null
}

// Reads the voice memos Minutes transcribed on the desktop, by asking a Claude chat to find the
// tasks in them, and turns the ones you approve into a chat each in the right project.
export function MemoTriageView(props: {
  projects: VoiceProject[]
  getCtx: () => RpcClientContextValue
  acquisition: HostClientAcquisition
}) {
  const { projects, getCtx, acquisition } = props
  const insets = useSafeAreaInsets()
  const choices = useMemo(() => repoChoices(projects), [projects])
  const [phase, setPhase] = useState<Phase>('working')
  const [message, setMessage] = useState(
    'Asking Claude to find and read your new memos. If there are several, transcribing them can take a few minutes…'
  )
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const itemsRef = useRef<Item[]>([])
  const clientRef = useRef<RpcClient | null>(null)
  const abort = useRef(new AbortController())
  const started = useRef(false)

  const setAllItems = useCallback((next: Item[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  useEffect(() => {
    const controller = abort.current
    return () => controller.abort()
  }, [])

  const startSelected = useCallback(async () => {
    if (started.current || !clientRef.current) {
      return
    }
    started.current = true
    const client = clientRef.current
    setPhase('starting')
    const branchPerTask = await getBranchPerTask()
    const next = [...itemsRef.current]
    for (let index = 0; index < next.length; index += 1) {
      const item = next[index]
      if (!item?.selected || !item.target) {
        continue
      }
      try {
        let target = item.target
        if (branchPerTask) {
          target = await createTaskWorkspace(client, target, item.task.task)
        }
        const created = await createMobileStructuredAgentSession(client, target.id, 'claude')
        if (created.kind !== 'created') {
          throw new Error(
            created.kind === 'unsupported' ? "That project can't host a chat." : created.message
          )
        }
        await sendToAgentSession(client, created.sessionId, item.task.task)
        next[index] = { ...item, state: 'started', note: null }
      } catch (failure) {
        next[index] = {
          ...item,
          state: 'failed',
          note: failure instanceof Error ? failure.message : 'Could not start it.'
        }
      }
      setAllItems([...next])
    }
    if (next.some((item) => item.state === 'started')) {
      await setMemosProcessedAt(Date.now())
    }
    setPhase('finished')
  }, [setAllItems])

  // Reads the findings aloud and listens once for "start all"; tapping works either way.
  const confirmByVoice = useCallback(
    async (client: RpcClient, found: Item[]) => {
      const native = nativeHandsFree
      if (!native || found.length === 0) {
        return
      }
      let release: (() => Promise<void>) | null = null
      try {
        setVoiceModeActive(true)
        release = await acquireAudio()
        await native.speak(
          triageSummary(
            found.map((item) => ({
              repo: item.target ? item.task.repo : 'unknown',
              title: item.task.title
            }))
          ),
          false
        )
        if (abort.current.signal.aborted || started.current) {
          return
        }
        const heard = await listenAndTranscribe(client)
        if (!abort.current.signal.aborted && saysStartAll(heard)) {
          await startSelected()
        }
      } catch {
        // Voice is a convenience here; the list on screen still works.
      } finally {
        await release?.().catch(() => undefined)
        setVoiceModeActive(false)
      }
    },
    [startSelected]
  )

  const run = useCallback(
    async (project: VoiceProject) => {
      setPhase('working')
      setError(null)
      setMessage(
        'Asking Claude to find and read your new memos. If there are several, transcribing them can take a few minutes…'
      )
      try {
        const { client } = await readyClient(getCtx(), acquisition)
        clientRef.current = client
        const since = await getMemosProcessedAt()
        const prompt = buildTriagePrompt(
          choices.map((choice) => choice.repo),
          since,
          Date.now()
        )
        const created = await createMobileStructuredAgentSession(client, project.id, 'claude')
        if (created.kind !== 'created') {
          throw new Error(
            created.kind === 'unsupported'
              ? "That project can't host a chat. Pick another one."
              : created.message
          )
        }
        const tracker = new ChatTracker(client, created.sessionId)
        let reply
        try {
          await tracker.ready
          const after = tracker.mark()
          await sendToAgentSession(client, created.sessionId, prompt)
          reply = await tracker.reply(after, abort.current.signal)
        } finally {
          tracker.close()
        }
        if (reply.kind === 'approval' || reply.kind === 'question') {
          throw new Error('The memo chat needs you. Open it on the desktop and answer it.')
        }
        if (reply.kind !== 'text') {
          throw new Error('Claude did not answer.')
        }
        const tasks = parseTriageReply(reply.text)
        if (tasks === null) {
          throw new Error(`Claude's answer was not a task list: ${reply.text.slice(0, 300)}`)
        }
        if (tasks.length === 0) {
          await setMemosProcessedAt(Date.now())
        }
        const found: Item[] = tasks.map((task) => {
          const best = rankRepos(task.repo, choices)[0]
          const target = best && best.score >= MATCH_SCORE ? best.choice.target : null
          return { task, target, selected: target !== null, state: 'idle', note: null }
        })
        setAllItems(found)
        setPhase('review')
        void confirmByVoice(client, found)
      } catch (failure) {
        if (!abort.current.signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'Could not read your memos.')
          setPhase('finished')
        }
      }
    },
    [acquisition, choices, confirmByVoice, getCtx, setAllItems]
  )

  useEffect(() => {
    if (started.current || phase !== 'working') {
      return
    }
    void (async () => {
      const saved = await getTriageProjectId()
      const project = projects.find((candidate) => candidate.id === saved)
      if (project) {
        void run(project)
      } else {
        setPhase('choose')
      }
    })()
    // Once, on open: later phase changes must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chosen = items.filter((item) => item.selected).length

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
      showsVerticalScrollIndicator={false}
    >
      {phase === 'choose' ? (
        <>
          <Text style={styles.caption}>
            Pick a project to run the memo reading in. It only reads your memos and does not change
            anything. This is remembered.
          </Text>
          <View style={styles.section}>
            {choices.map((choice, index) => (
              <View key={choice.repo}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={choice.repo}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => {
                    void setTriageProjectId(choice.target.id)
                    void run(choice.target)
                  }}
                >
                  <Text style={styles.rowLabel}>{choice.repo}</Text>
                  <ChevronRight size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {phase === 'working' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.caption}>{message}</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {phase === 'review' || phase === 'starting' || phase === 'finished' ? (
        <>
          {items.length === 0 && !error ? (
            <Text style={styles.caption}>No new tasks found in your voice memos.</Text>
          ) : null}
          {items.map((item, index) => (
            <View key={index} style={styles.card}>
              <View style={styles.cardHead}>
                <View style={styles.cardText}>
                  <Text style={styles.cardTitle}>{item.task.title}</Text>
                  <Text style={styles.cardRepo}>
                    {item.target ? item.target.repo : `Unknown project (${item.task.repo})`}
                  </Text>
                </View>
                {phase === 'review' ? (
                  <Switch
                    disabled={!item.target}
                    value={item.selected}
                    onValueChange={(on) =>
                      setAllItems(
                        itemsRef.current.map((entry, at) =>
                          at === index ? { ...entry, selected: on } : entry
                        )
                      )
                    }
                  />
                ) : (
                  <Text style={styles.state}>
                    {item.state === 'started' ? 'Started' : item.state === 'failed' ? 'Failed' : ''}
                  </Text>
                )}
              </View>
              <Text style={styles.cardBody} numberOfLines={4}>
                {item.note ?? item.task.task}
              </Text>
            </View>
          ))}
          {phase === 'review' && items.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start selected"
              disabled={chosen === 0}
              style={({ pressed }) => [
                styles.start,
                chosen === 0 && styles.startOff,
                pressed && styles.rowPressed
              ]}
              onPress={() => void startSelected()}
            >
              <Text style={styles.startText}>
                {chosen === 0
                  ? 'Nothing selected'
                  : `Start ${chosen} ${chosen === 1 ? 'task' : 'tasks'}`}
              </Text>
            </Pressable>
          ) : null}
          {phase === 'starting' ? (
            <ActivityIndicator style={styles.center} color={colors.textSecondary} />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  caption: { color: colors.textMuted, fontSize: typography.metaSize, marginBottom: spacing.md },
  center: { alignItems: 'center', gap: spacing.md, marginTop: spacing.xl },
  error: { color: '#f87171', fontSize: typography.bodySize, marginVertical: spacing.sm },
  section: { backgroundColor: colors.bgPanel, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardText: { flex: 1, gap: 2 },
  cardTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  cardRepo: { color: colors.textMuted, fontSize: typography.metaSize },
  cardBody: { color: colors.textSecondary, fontSize: typography.bodySize },
  state: { color: colors.textMuted, fontSize: typography.metaSize },
  start: {
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md
  },
  startOff: { opacity: 0.4 },
  startText: { color: '#fff', fontSize: typography.bodySize, fontWeight: '600' }
})
