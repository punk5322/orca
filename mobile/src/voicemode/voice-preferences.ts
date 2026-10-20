import AsyncStorage from '@react-native-async-storage/async-storage'

const BRANCH_PER_TASK_KEY = 'orca.voice.branchPerTask'
const TRIAGE_PROJECT_KEY = 'orca.voice.triageProject'
const MEMOS_PROCESSED_KEY = 'orca.voice.memosProcessedAt'

// Off by default: a dictated task lands in the repo's main workspace until the user opts in.
export async function getBranchPerTask(): Promise<boolean> {
  return (await AsyncStorage.getItem(BRANCH_PER_TASK_KEY)) === 'true'
}

export async function setBranchPerTask(on: boolean): Promise<void> {
  await AsyncStorage.setItem(BRANCH_PER_TASK_KEY, on ? 'true' : 'false')
}

/** The workspace where voice-memo triage chats run, once the user has picked one. */
export async function getTriageProjectId(): Promise<string | null> {
  return AsyncStorage.getItem(TRIAGE_PROJECT_KEY)
}

export async function setTriageProjectId(id: string): Promise<void> {
  await AsyncStorage.setItem(TRIAGE_PROJECT_KEY, id)
}

/** When memos were last turned into tasks, so the next run only reads newer ones. */
export async function getMemosProcessedAt(): Promise<number | null> {
  const stored = await AsyncStorage.getItem(MEMOS_PROCESSED_KEY)
  const parsed = stored ? Number(stored) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export async function setMemosProcessedAt(at: number): Promise<void> {
  await AsyncStorage.setItem(MEMOS_PROCESSED_KEY, String(at))
}
