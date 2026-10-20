import { describe, expect, it } from 'vitest'
import { approvalSpeech, classifyDecision, pickApprovalOptions } from './voice-approvals'

describe('spoken decisions', () => {
  it('allows only on a clear go ahead or confirm', () => {
    expect(classifyDecision('go ahead')).toBe('allow')
    expect(classifyDecision('okay, go ahead')).toBe('allow')
    expect(classifyDecision('Confirm')).toBe('allow')
  })

  it('treats any refusal as a refusal, even beside a go ahead', () => {
    expect(classifyDecision('hold off')).toBe('deny')
    expect(classifyDecision('no')).toBe('deny')
    expect(classifyDecision("don't go ahead")).toBe('deny')
    expect(classifyDecision('go ahead, no wait')).toBe('deny')
  })

  it('does nothing on anything else', () => {
    expect(classifyDecision('')).toBe('unclear')
    expect(classifyDecision('yeah sure')).toBe('unclear')
    expect(classifyDecision('approve')).toBe('unclear')
  })
})

describe('choosing an option to act on', () => {
  it('picks the plain allow and deny, never a standing permission', () => {
    const picked = pickApprovalOptions([
      { id: 'allow', label: 'Allow' },
      { id: 'allowForSession', label: 'Allow for this session' },
      { id: 'deny', label: 'Deny' }
    ])
    expect(picked.allow?.id).toBe('allow')
    expect(picked.deny?.id).toBe('deny')
  })

  it('finds Codex-style decisions and refuses to guess otherwise', () => {
    const codex = pickApprovalOptions([
      { id: 'accept', label: 'Accept' },
      { id: 'acceptForSession', label: 'Accept for session' },
      { id: 'decline', label: 'Decline' }
    ])
    expect(codex.allow?.id).toBe('accept')
    expect(codex.deny?.id).toBe('decline')
    expect(pickApprovalOptions([{ id: 'maybe', label: 'Maybe' }])).toEqual({
      allow: null,
      deny: null
    })
  })
})

describe('what is read aloud', () => {
  it('names the request, clips a long command, and gives the answer words', () => {
    const spoken = approvalSpeech({
      itemId: 'i',
      revision: 1,
      title: 'Allow Bash?',
      detail: `rm -rf ${'x'.repeat(400)}`,
      options: []
    })
    expect(spoken).toContain('Allow Bash?')
    expect(spoken).toContain('go ahead')
    expect(spoken.length).toBeLessThan(260)
  })
})
