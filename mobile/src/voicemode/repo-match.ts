import type { VoiceProject } from './voice-targets'

export type RepoChoice = { repo: string; target: VoiceProject }

/** One entry per repo, aimed at its main workspace (or the first one if none is marked). */
export function repoChoices(projects: VoiceProject[]): RepoChoice[] {
  const byRepo = new Map<string, VoiceProject[]>()
  for (const project of projects) {
    byRepo.set(project.repo, [...(byRepo.get(project.repo) ?? []), project])
  }
  return [...byRepo.entries()].flatMap(([repo, list]) => {
    const target = list.find((entry) => entry.isMain) ?? list[0]
    return target ? [{ repo, target }] : []
  })
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

// Spoken names arrive with different spacing and hyphens ("cali lawyer cms" for cali-lawyer-cms),
// so compare with everything but letters and digits removed; a repo name inside a longer phrase
// ("the cali lawyer project") also counts.
export function scoreRepo(spoken: string, repo: string): number {
  const said = normalize(spoken)
  const name = normalize(repo)
  if (!said || !name) {
    return 0
  }
  if (said === name) {
    return 1
  }
  if (said.includes(name) || (said.length >= 4 && name.includes(said))) {
    return 0.9
  }
  return Math.max(0, 1 - distance(said, name) / Math.max(said.length, name.length))
}

export function rankRepos(
  spoken: string,
  choices: RepoChoice[]
): { choice: RepoChoice; score: number }[] {
  return choices
    .map((choice) => ({ choice, score: scoreRepo(spoken, choice.repo) }))
    .sort((a, b) => b.score - a.score)
}

export function listOut(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
