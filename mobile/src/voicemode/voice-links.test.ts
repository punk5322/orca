import { describe, expect, it } from 'vitest'
import { voiceLinkRoute } from './voice-links'

describe('voice links', () => {
  it('maps the new-task and voice-mode links', () => {
    expect(voiceLinkRoute('orca://new-task')).toBe('/new-task')
    expect(voiceLinkRoute('orca://voice-mode')).toBe('/voice-mode')
  })

  it('answers to the fork scheme as well as the original', () => {
    expect(voiceLinkRoute('orca-cc://new-task')).toBe('/new-task')
    expect(voiceLinkRoute('orca-cc://voice-mode')).toBe('/voice-mode')
  })

  it('tolerates a triple slash, trailing slash, query and case', () => {
    expect(voiceLinkRoute('orca:///new-task')).toBe('/new-task')
    expect(voiceLinkRoute('orca://new-task/')).toBe('/new-task')
    expect(voiceLinkRoute('orca://New-Task?from=siri')).toBe('/new-task')
    expect(voiceLinkRoute('  orca://voice-mode  ')).toBe('/voice-mode')
  })

  it('leaves other links alone', () => {
    expect(voiceLinkRoute('orca://pair?code=abc')).toBeNull()
    expect(voiceLinkRoute('orca://new-task-extra')).toBeNull()
    expect(voiceLinkRoute('https://example.com/new-task')).toBeNull()
  })
})
