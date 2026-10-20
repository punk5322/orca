import { describe, expect, it } from 'vitest'
import { rankRepos, repoChoices, scoreRepo } from './repo-match'
import type { VoiceProject } from './voice-targets'

function project(repo: string, name: string, isMain: boolean): VoiceProject {
  return { id: `${repo}:${name}`, repo, name, path: `/code/${repo}`, isMain }
}

describe('matching a spoken project name', () => {
  const choices = repoChoices([
    project('cali-lawyer-cms', 'feat/deals', false),
    project('cali-lawyer-cms', 'main', true),
    project('catalog-analyses', 'main', true),
    project('orca', 'main', true)
  ])

  it('aims each repo at its main workspace', () => {
    expect(choices.map((choice) => [choice.repo, choice.target.name])).toEqual([
      ['cali-lawyer-cms', 'main'],
      ['catalog-analyses', 'main'],
      ['orca', 'main']
    ])
  })

  it('ignores spacing and hyphens in speech', () => {
    expect(scoreRepo('cali lawyer CMS', 'cali-lawyer-cms')).toBe(1)
  })

  it('finds a repo name inside a longer phrase', () => {
    const [top] = rankRepos('the cali lawyer cms project please', choices)
    expect(top?.choice.repo).toBe('cali-lawyer-cms')
    expect(top?.score).toBeGreaterThanOrEqual(0.8)
  })

  it('tolerates a mis-heard word', () => {
    const [top] = rankRepos('catalogue analyses', choices)
    expect(top?.choice.repo).toBe('catalog-analyses')
  })

  it('scores an unrelated phrase low', () => {
    expect(scoreRepo('banana bread recipe', 'cali-lawyer-cms')).toBeLessThan(0.4)
  })
})
