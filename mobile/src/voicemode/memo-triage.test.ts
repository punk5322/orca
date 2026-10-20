import { describe, expect, it } from 'vitest'
import { buildTriagePrompt, parseTriageReply, saysStartAll, triageSummary } from './memo-triage'

const NOW = new Date(2026, 9, 19, 22, 30).getTime()

describe('the triage prompt', () => {
  it('lists the projects and bounds the recordings by local date and time', () => {
    const first = buildTriagePrompt(['cali-lawyer-cms', 'orca'], null, NOW)
    expect(first).toContain('cali-lawyer-cms, orca')
    expect(first).toContain('after 2026-10-16 22:30')
    const later = buildTriagePrompt(['orca'], new Date(2026, 9, 17, 8, 5).getTime(), NOW)
    expect(later).toContain('after 2026-10-17 08:05')
  })

  it('points at the Voice Memos folder and transcribes only what it needs', () => {
    const prompt = buildTriagePrompt(['orca'], null, NOW)
    expect(prompt).toContain('com.apple.VoiceMemos.shared/Recordings')
    expect(prompt).toContain('~/.minutes/inbox')
    expect(prompt).toContain('minutes process')
    expect(prompt).toContain('ignore every older file')
  })

  it('allows writing nothing but transcripts and a temporary conversion', () => {
    const prompt = buildTriagePrompt(['orca'], null, NOW)
    expect(prompt).toContain('Do not change, create or delete')
    expect(prompt).toContain('.qta')
    expect(prompt).toContain('ffmpeg')
  })
})

describe('reading the triage reply', () => {
  const item = '{"repo":"orca","title":"Fix login","task":"Fix the login crash","source":"a.md"}'

  it('reads a fenced block', () => {
    expect(parseTriageReply(`Here you go:\n\`\`\`json\n[${item}]\n\`\`\``)).toEqual([
      { repo: 'orca', title: 'Fix login', task: 'Fix the login crash', source: 'a.md' }
    ])
  })

  it('reads a bare array and fills in a missing repo and title', () => {
    expect(parseTriageReply('[{"task":"Do the thing please"}]')).toEqual([
      { repo: 'unknown', title: 'Do the thing please', task: 'Do the thing please', source: null }
    ])
  })

  it('reads an empty list and drops entries with no task', () => {
    expect(parseTriageReply('```json\n[]\n```')).toEqual([])
    expect(parseTriageReply('[{"repo":"orca"}]')).toEqual([])
  })

  it('says so when there is no JSON, and caps the count', () => {
    expect(parseTriageReply('I could not find any memos.')).toBeNull()
    const many = `[${Array.from({ length: 30 }, () => item).join(',')}]`
    expect(parseTriageReply(many)?.length).toBe(12)
  })
})

describe('confirming by voice', () => {
  it('starts only on a clear phrase, and never with a refusal in it', () => {
    expect(saysStartAll('start all')).toBe(true)
    expect(saysStartAll('go ahead')).toBe(true)
    expect(saysStartAll("don't start all of them")).toBe(false)
    expect(saysStartAll('hold off')).toBe(false)
    expect(saysStartAll('maybe')).toBe(false)
  })

  it('summarises what it found', () => {
    expect(triageSummary([])).toContain('no new tasks')
    const said = triageSummary(
      Array.from({ length: 6 }, (_, i) => ({ repo: 'orca', title: `Task ${i + 1}` }))
    )
    expect(said).toContain('I found 6 tasks.')
    expect(said).toContain('And 2 more.')
    expect(said).toContain('Say start all')
  })
})
