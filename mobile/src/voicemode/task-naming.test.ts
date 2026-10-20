import { describe, expect, it } from 'vitest'
import { workspaceNameForTask, workspaceTitleForTask } from './task-naming'

describe('naming a workspace from a spoken task', () => {
  it('makes a short branch-safe slug with the suffix', () => {
    expect(
      workspaceNameForTask('Fix the login page crash when the password is empty', 'a1b2')
    ).toBe('fix-the-login-page-crash-when-a1b2')
  })

  it('drops punctuation and falls back when nothing is left', () => {
    expect(workspaceNameForTask("What's up?!", 'x9')).toBe('what-s-up-x9')
    expect(workspaceNameForTask('???', 'x9')).toBe('voice-task-x9')
  })

  it('keeps a long first word within the limit', () => {
    expect(workspaceNameForTask('a'.repeat(100), 'z').length).toBeLessThanOrEqual(42)
  })

  it('titles with the first words capitalised', () => {
    expect(workspaceTitleForTask('add a readme comment now please thanks bye')).toBe(
      'Add a readme comment now please'
    )
  })
})
