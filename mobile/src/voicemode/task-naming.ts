const NAME_WORDS = 6
const NAME_MAX = 40

/** A branch-friendly name from the first words of a spoken task, e.g. "fix-the-login-page-crash". */
export function workspaceNameForTask(task: string, suffix: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, NAME_WORDS)
  const slug = words.join('-').slice(0, NAME_MAX).replace(/-+$/, '')
  return `${slug || 'voice-task'}-${suffix}`
}

/** A readable title for the workspace list: the first words, capitalised. */
export function workspaceTitleForTask(task: string): string {
  const words = task.trim().split(/\s+/).slice(0, NAME_WORDS).join(' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Voice task'
}
