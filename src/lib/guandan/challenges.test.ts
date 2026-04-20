import { describe, expect, it } from 'vitest'
import { getChallengeForAdvance } from './challenges'
import { generateGame } from './engine'

describe('starter challenges', () => {
  it('only asks high-card count questions after trick checkpoints', () => {
    const allowedTags = new Set(['focus-count', 'big-card-count', 'wild-count'])
    const seeds = [11, 29, 57]
    let totalQuestions = 0

    for (const seed of seeds) {
      const game = generateGame(seed)

      for (let step = 1; step <= game.actions.length; step += 1) {
        const planned = getChallengeForAdvance(game, step - 1, step, 'starter')
        if (!planned) {
          continue
        }

        totalQuestions += 1
        expect(allowedTags.has(planned.question.tag)).toBe(true)
        expect(planned.question.prompt).not.toMatch(/收轮|牌型|队友是谁/)
      }
    }

    expect(totalQuestions).toBeGreaterThan(0)
  })
})