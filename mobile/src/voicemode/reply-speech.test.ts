import { describe, expect, it } from 'vitest'
import { isReadMore, moreOfReply, spokenReply } from './reply-speech'

const sentence = (n: number): string => `This is sentence number ${n} of the reply.`

describe('speaking a reply', () => {
  it('reads a short reply whole', () => {
    expect(spokenReply('All done. The tests pass.')).toEqual({
      spoken: 'All done. The tests pass.',
      rest: []
    })
  })

  it('cuts a long reply, keeps the rest, and says how to hear it', () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i + 1)).join(' ')
    const { spoken, rest } = spokenReply(text)
    expect(spoken).toContain('Say read more')
    expect(spoken.length).toBeLessThan(400)
    expect(rest.length).toBeGreaterThan(0)
  })

  it('drops code and markdown, and points to the chat for the code', () => {
    const { spoken } = spokenReply('I fixed it.\n```ts\nconst x = 1\n```\nCheck **the diff**.')
    expect(spoken).toBe('I fixed it. Check the diff. I left the code in the chat.')
  })

  it('works through the rest in order and then says it is finished', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join(' ')
    let { rest } = spokenReply(text)
    let rounds = 0
    while (rest.length > 0) {
      rest = moreOfReply(rest).rest
      rounds += 1
      expect(rounds).toBeLessThan(20)
    }
    expect(moreOfReply([]).spoken).toBe("That's everything.")
  })
})

describe('asking for more', () => {
  it('recognises the phrases', () => {
    for (const phrase of ['read more', 'read the rest', 'Tell me more', 'keep going', 'go on']) {
      expect(isReadMore(phrase)).toBe(true)
    }
    expect(isReadMore('run the tests')).toBe(false)
  })
})
