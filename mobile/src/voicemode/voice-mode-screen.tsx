import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AudioLines, ChevronLeft, ChevronRight, Mic, Plus, Square } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { useRpcClientContext } from '../transport/client-context'
import type { HostClientAcquisition } from '../transport/host-client-acquisition-registry'
import { readyClient } from '../watch/use-watch-bridge'
import {
  createTaskWorkspace,
  listChats,
  listPastSessions,
  listProjects,
  type VoiceChat,
  type VoicePastSession,
  type VoiceProject
} from './voice-targets'
import { formatTimeAgo } from '../worktree/agent-row-display'
import { acquireAudio } from '../handsfree/audio-lease'
import { nativeHandsFree } from '../handsfree/native-hands-free'
import { runTaskIntake } from './task-intake'
import { MemoTriageView } from './memo-triage-view'
import { getBranchPerTask } from './voice-preferences'
import { setVoiceModeActive } from './voice-mode-state'
import { VoiceConversation, type VoiceState } from './voice-conversation'
import { VoiceVisualizer } from './voice-visualizer'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'

type Step = 'projects' | 'chats' | 'live' | 'task' | 'memos'
type Turn = { id: number; who: 'you' | 'agent'; text: string }

const CREATE_CHAT_TIMEOUT_MS = 40_000

const NEW_CHAT_AGENTS: { agent: AgentSessionHandleProvider; label: string }[] = [
  { agent: 'claude', label: 'New Claude chat' },
  { agent: 'codex', label: 'New Codex chat' }
]

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Tap start and talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking. Talk over it to interrupt.'
}

export function VoiceModeScreen({
  onExit,
  autoStartTask = false
}: {
  onExit: () => void
  /** Begin the new-task flow as soon as the projects load, for a Siri or Shortcut launch. */
  autoStartTask?: boolean
}) {
  const insets = useSafeAreaInsets()
  const ctx = useRpcClientContext()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const acquisition = useRef<HostClientAcquisition>({}).current

  const [step, setStep] = useState<Step>('projects')
  const [projects, setProjects] = useState<VoiceProject[]>([])
  const [project, setProject] = useState<VoiceProject | null>(null)
  const [chats, setChats] = useState<VoiceChat[]>([])
  const [chat, setChat] = useState<VoiceChat | null>(null)
  const [pastSessions, setPastSessions] = useState<VoicePastSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [taskState, setTaskState] = useState<VoiceState>('speaking')
  const [taskLines, setTaskLines] = useState<{ label: string; text: string }[]>([])
  const taskAbort = useRef<AbortController | null>(null)

  const conversation = useRef<VoiceConversation | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [running, setRunning] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const nextTurnId = useRef(0)
  const transcriptRef = useRef<ScrollView>(null)

  // Why: the whole conversation stays on screen, so each turn is appended rather than replacing
  // the last one.
  const addTurn = useCallback((who: Turn['who'], text: string) => {
    nextTurnId.current += 1
    const id = nextTurnId.current
    setTurns((previous) => [...previous, { id, who, text }])
  }, [])

  const load = useCallback(
    async (task: (client: Awaited<ReturnType<typeof readyClient>>['client']) => Promise<void>) => {
      setLoading(true)
      setError(null)
      try {
        const { client } = await readyClient(ctxRef.current, acquisition)
        await task(client)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not load.')
      } finally {
        setLoading(false)
      }
    },
    [acquisition]
  )

  useEffect(() => {
    void load(async (client) => setProjects(await listProjects(client)))
  }, [load])

  // Why: a launch from Siri wants to be listening at once, with no tap, so the new-task flow starts
  // itself the first time the project list is ready.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStartTask && !autoStarted.current && projects.length > 0) {
      autoStarted.current = true
      void startTaskRef.current()
    }
  }, [autoStartTask, projects])

  const stopConversation = useCallback(async () => {
    await conversation.current?.stop()
    conversation.current = null
    setRunning(false)
  }, [])

  // Leaving the screen ends the conversation and gives back the connection.
  useEffect(
    () => () => {
      void conversation.current?.stop()
      for (const { hostId } of ctxRef.current.getAllClients()) {
        ctxRef.current.release(hostId, acquisition)
      }
    },
    [acquisition]
  )

  const pickProject = (picked: VoiceProject) => {
    setProject(picked)
    setStep('chats')
    setChats([])
    setPastSessions([])
    void load(async (client) => {
      const [found, past] = await Promise.all([
        listChats(client, picked.id),
        listPastSessions(client, picked)
      ])
      setChats(found)
      setPastSessions(past)
    })
  }

  const pickChat = (picked: VoiceChat) => {
    setChat(picked)
    setTurns([])
    setNotice(null)
    setStep('live')
  }

  // Starts a new chat in the picked project and goes straight into it.
  const startChat = async (agent: AgentSessionHandleProvider, resumeFrom?: string) => {
    if (!project || creating) {
      return
    }
    setCreating(resumeFrom ?? agent)
    setError(null)
    try {
      console.log(`[voice] start ${agent} chat in ${project.id}`)
      const { client } = await readyClient(ctxRef.current, acquisition)
      console.log('[voice] connected, creating')
      // Why: the create call retries internally and can sit for a long time on a bad connection.
      const created = await Promise.race([
        createMobileStructuredAgentSession(client, project.id, agent, resumeFrom),
        new Promise<{ kind: 'failed'; message: string }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                kind: 'failed',
                message: 'Starting the chat took too long. Check the connection to your desktop.'
              }),
            CREATE_CHAT_TIMEOUT_MS
          )
        )
      ])
      console.log(`[voice] create result: ${created.kind}`)
      if (created.kind === 'created') {
        pickChat({
          sessionId: created.sessionId,
          title: resumeFrom ? 'Continued session' : 'New chat',
          isActive: true
        })
      } else if (created.kind === 'unsupported') {
        setError("This project can't host a chat. Open it on the desktop first.")
      } else {
        setError(created.message)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start a chat.')
    } finally {
      setCreating(null)
    }
  }

  // "New task by voice": asks which project and what the task is, starts a Claude chat in that
  // repo with the task as its first message, then carries on as a live conversation.
  const startTask = async () => {
    if (taskAbort.current) {
      return
    }
    const controller = new AbortController()
    taskAbort.current = controller
    setStep('task')
    setTaskLines([])
    setTaskState('speaking')
    setNotice(null)
    let release: () => Promise<void> = async () => {}
    try {
      setVoiceModeActive(true)
      release = await acquireAudio()
      const { client } = await readyClient(ctxRef.current, acquisition)
      const intake = await runTaskIntake(client, projects, {
        onState: setTaskState,
        onHeard: (label, text) => setTaskLines((lines) => [...lines, { label, text }]),
        signal: controller.signal
      })
      if (!intake) {
        setStep('projects')
        return
      }
      let target = intake.target
      if (await getBranchPerTask()) {
        // Opt-in: give the task its own branch so parallel tasks in one repo do not collide.
        setTaskState('speaking')
        await nativeHandsFree?.speak('Creating a branch for it.', false)
        target = await createTaskWorkspace(client, intake.target, intake.task)
      }
      const created = await createMobileStructuredAgentSession(client, target.id, 'claude')
      if (created.kind !== 'created') {
        throw new Error(
          created.kind === 'unsupported'
            ? "That project can't host a chat. Open it on the desktop first."
            : created.message
        )
      }
      setProject(target)
      setChat({ sessionId: created.sessionId, title: 'New task', isActive: true })
      setTurns([])
      setStep('live')
      setRunning(true)
      const next = new VoiceConversation(
        () => ctxRef.current,
        created.sessionId,
        {
          onState: setVoiceState,
          onUserText: (text) => addTurn('you', text),
          onReplyText: (text) => addTurn('agent', text),
          onNotice: setNotice,
          onEnded: () => setRunning(false)
        },
        intake.task
      )
      conversation.current = next
      await next.start()
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Could not start the task.')
      }
      setStep('projects')
    } finally {
      taskAbort.current = null
      await release().catch(() => undefined)
      if (!conversation.current) {
        setVoiceModeActive(false)
      }
    }
  }

  const startTaskRef = useRef(startTask)
  startTaskRef.current = startTask

  const cancelTask = async () => {
    taskAbort.current?.abort()
    await nativeHandsFree?.stopListening().catch(() => undefined)
    await nativeHandsFree?.cancelSpeech().catch(() => undefined)
  }

  const back = async () => {
    if (step === 'memos') {
      setStep('projects')
      return
    }
    if (step === 'task') {
      await cancelTask()
      return
    }
    if (step === 'live') {
      await stopConversation()
      setStep('chats')
    } else if (step === 'chats') {
      setStep('projects')
    } else {
      onExit()
    }
  }

  const start = async () => {
    if (!chat || running) {
      return
    }
    setRunning(true)
    const next = new VoiceConversation(() => ctxRef.current, chat.sessionId, {
      onState: setVoiceState,
      onUserText: (text) => addTurn('you', text),
      onReplyText: (text) => addTurn('agent', text),
      onNotice: setNotice,
      onEnded: () => setRunning(false)
    })
    conversation.current = next
    await next.start()
  }

  const grouped = useMemo(() => {
    const byRepo = new Map<string, VoiceProject[]>()
    for (const entry of projects) {
      byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), entry])
    }
    return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [projects])

  const title =
    step === 'projects'
      ? 'Voice mode'
      : step === 'chats'
        ? (project?.repo ?? 'Chats')
        : step === 'task'
          ? 'New task'
          : step === 'memos'
            ? 'Voice memos'
            : 'Live'

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={() => void back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{title}</Text>
      </View>

      {step === 'memos' ? (
        <MemoTriageView
          key="memos"
          projects={projects}
          getCtx={() => ctxRef.current}
          acquisition={acquisition}
        />
      ) : step === 'task' ? (
        <View style={styles.live}>
          <View style={styles.visual}>
            <VoiceVisualizer state={taskState} />
            <Text style={styles.stateLabel}>
              {taskState === 'speaking' ? 'Speaking…' : 'Listening…'}
            </Text>
          </View>
          <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
            {taskLines.map((line, index) => (
              <View key={index} style={[styles.bubble, styles.youBubble]}>
                <Text style={styles.who}>{line.label}</Text>
                <Text style={styles.line}>{line.text || '(nothing heard)'}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.lg }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => [
                styles.mainButton,
                styles.stopButton,
                pressed && styles.pressed
              ]}
              onPress={() => void cancelTask()}
            >
              <Square size={28} color="#fff" fill="#fff" />
            </Pressable>
            <Text style={styles.hint}>Say "cancel" or tap to stop</Text>
          </View>
        </View>
      ) : step !== 'live' ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.caption}>
            {step === 'projects'
              ? 'Pick a project, then a chat, and talk to it hands-free.'
              : `Pick a chat in ${project?.name ?? 'this project'}.`}
          </Text>
          {loading ? (
            <ActivityIndicator style={styles.spinner} color={colors.textSecondary} />
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {step === 'projects' && projects.length > 0 ? (
            <View style={styles.group}>
              <View style={styles.section}>
                <Row
                  label="New task by voice"
                  first
                  icon={<Mic size={16} color={colors.textSecondary} />}
                  onPress={() => void startTask()}
                />
                <Row
                  label="Process voice memos"
                  first={false}
                  icon={<AudioLines size={16} color={colors.textSecondary} />}
                  onPress={() => setStep('memos')}
                />
              </View>
            </View>
          ) : null}

          {step === 'projects'
            ? grouped.map(([repo, entries]) => (
                <View key={repo} style={styles.group}>
                  <Text style={styles.groupTitle}>{repo}</Text>
                  <View style={styles.section}>
                    {entries.map((entry, index) => (
                      <Row
                        key={entry.id}
                        label={entry.name}
                        first={index === 0}
                        onPress={() => pickProject(entry)}
                      />
                    ))}
                  </View>
                </View>
              ))
            : null}

          {step === 'chats' ? (
            <>
              {chats.length > 0 ? (
                <View style={styles.section}>
                  {chats.map((entry, index) => (
                    <Row
                      key={entry.sessionId}
                      label={entry.title}
                      first={index === 0}
                      onPress={() => pickChat(entry)}
                    />
                  ))}
                </View>
              ) : null}
              {!loading && !error && chats.length === 0 ? (
                <Text style={styles.caption}>No chats in this project yet. Start one below.</Text>
              ) : null}
              <View style={styles.group}>
                <Text style={styles.groupTitle}>Start a new chat</Text>
                <View style={styles.section}>
                  {NEW_CHAT_AGENTS.map((entry, index) => (
                    <Row
                      key={entry.agent}
                      label={creating === entry.agent ? 'Starting…' : entry.label}
                      first={index === 0}
                      icon={<Plus size={16} color={colors.textSecondary} />}
                      onPress={() => void startChat(entry.agent)}
                    />
                  ))}
                </View>
              </View>
              {pastSessions.length > 0 ? (
                <View style={styles.group}>
                  <Text style={styles.groupTitle}>Continue a past session</Text>
                  <View style={styles.section}>
                    {pastSessions.map((entry, index) => {
                      const ago = entry.updatedAt ? formatTimeAgo(entry.updatedAt, Date.now()) : ''
                      return (
                        <Row
                          key={entry.sessionId}
                          label={creating === entry.sessionId ? 'Continuing…' : entry.title}
                          detail={`${entry.agent === 'claude' ? 'Claude' : 'Codex'}${ago ? ` · ${ago === 'just now' ? ago : `${ago} ago`}` : ''}`}
                          first={index === 0}
                          onPress={() => void startChat(entry.agent, entry.sessionId)}
                        />
                      )
                    })}
                  </View>
                </View>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      ) : (
        <View style={styles.live}>
          <Text style={styles.target} numberOfLines={1}>
            {project?.name} · {chat?.title}
          </Text>
          <View style={styles.visual}>
            <VoiceVisualizer state={running ? voiceState : 'idle'} />
            <Text style={styles.stateLabel}>
              {running ? STATE_LABEL[voiceState] : STATE_LABEL.idle}
            </Text>
          </View>
          <ScrollView
            ref={transcriptRef}
            style={styles.transcript}
            contentContainerStyle={styles.transcriptContent}
            onContentSizeChange={() => transcriptRef.current?.scrollToEnd({ animated: true })}
          >
            {turns.map((turn) => (
              <View
                key={turn.id}
                style={[styles.bubble, turn.who === 'you' ? styles.youBubble : styles.agentBubble]}
              >
                <Text style={styles.who}>{turn.who === 'you' ? 'You' : 'Agent'}</Text>
                <Text style={styles.line}>{turn.text}</Text>
              </View>
            ))}
            {notice ? <Text style={styles.error}>{notice}</Text> : null}
          </ScrollView>
          <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.lg }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={running ? 'Stop' : 'Start'}
              style={({ pressed }) => [
                styles.mainButton,
                running ? styles.stopButton : styles.startButton,
                pressed && styles.pressed
              ]}
              onPress={() => (running ? void stopConversation() : void start())}
            >
              {running ? (
                <Square size={28} color="#fff" fill="#fff" />
              ) : (
                <Mic size={30} color="#fff" />
              )}
            </Pressable>
            <Text style={styles.hint}>
              {running ? 'Say "goodbye" or tap to stop' : 'Tap to start the conversation'}
            </Text>
          </View>
        </View>
      )}
    </View>
  )
}

function Row({
  label,
  first,
  onPress,
  icon,
  detail
}: {
  label: string
  first: boolean
  onPress: () => void
  icon?: ReactNode
  detail?: string
}) {
  return (
    <View>
      {first ? null : <View style={styles.separator} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={onPress}
      >
        {icon}
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {icon ? null : <ChevronRight size={16} color={colors.textMuted} />}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingHorizontal: spacing.lg },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
  caption: { color: colors.textMuted, fontSize: typography.metaSize, marginBottom: spacing.md },
  spinner: { marginVertical: spacing.lg },
  error: { color: '#f87171', fontSize: typography.bodySize, marginVertical: spacing.sm },
  group: { marginBottom: spacing.md },
  groupTitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    marginBottom: spacing.xs,
    marginLeft: spacing.sm
  },
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
  detail: { color: colors.textMuted, fontSize: typography.metaSize },
  empty: { color: colors.textMuted, padding: spacing.md },
  live: { flex: 1 },
  target: { color: colors.textSecondary, fontSize: typography.bodySize, textAlign: 'center' },
  visual: { alignItems: 'center', marginTop: spacing.xl * 2, gap: spacing.lg },
  stateLabel: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '500' },
  transcript: { flex: 1, marginTop: spacing.xl },
  transcriptContent: { gap: spacing.sm, paddingBottom: spacing.md },
  bubble: { borderRadius: 12, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, gap: 2 },
  youBubble: { backgroundColor: colors.bgRaised, alignSelf: 'flex-end', maxWidth: '85%' },
  agentBubble: { backgroundColor: colors.bgPanel, alignSelf: 'flex-start', maxWidth: '92%' },
  line: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 21 },
  who: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600' },
  controls: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.md },
  mainButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center'
  },
  startButton: { backgroundColor: '#2563eb' },
  stopButton: { backgroundColor: '#dc2626' },
  pressed: { opacity: 0.8 },
  hint: { color: colors.textMuted, fontSize: typography.metaSize }
})
