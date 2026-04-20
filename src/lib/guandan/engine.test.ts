import { describe, expect, it } from 'vitest'
import { buildReplaySnapshot, sortHandForDisplay } from './engine'
import type { Card, GuandanGame, Seat } from './types'

function makeCard(id: string, rank: number, suit: Card['suit'], deck: 1 | 2 = 1): Card {
  return { id, rank, suit, deck }
}

function makeEmptyGame(startingSeat: Seat = 'south'): GuandanGame {
  return {
    seed: 1,
    levelRank: 3,
    startingSeat,
    players: {
      south: [],
      east: [],
      north: [],
      west: [],
    },
    actions: [],
    tricks: [],
    finishOrder: [],
    createdAt: '2026-04-20T00:00:00.000Z',
  }
}

describe('sortHandForDisplay', () => {
  it('orders jokers first, then level cards, then remaining cards descending', () => {
    const hand = [
      makeCard('a1', 14, 'spades'),
      makeCard('rj', 17, 'red'),
      makeCard('lv-heart', 3, 'hearts'),
      makeCard('sj', 16, 'black'),
      makeCard('k1', 13, 'clubs'),
      makeCard('lv-spade', 3, 'spades'),
      makeCard('q1', 12, 'diamonds'),
    ]

    const sortedIds = sortHandForDisplay(hand, 3).map((card) => card.id)
    expect(sortedIds).toEqual(['rj', 'sj', 'lv-heart', 'lv-spade', 'a1', 'k1', 'q1'])
  })
})

describe('buildReplaySnapshot', () => {
  it('does not treat an empty action list as a completed game', () => {
    const game = makeEmptyGame('east')
    const snapshot = buildReplaySnapshot(game, 0)

    expect(snapshot.isComplete).toBe(false)
    expect(snapshot.nextSeat).toBe('east')
    expect(snapshot.currentTrick).toBeNull()
    expect(snapshot.visibleActions).toHaveLength(0)
  })

  it('clamps over-large stepIndex values and preserves completion semantics', () => {
    const card = makeCard('s-4', 4, 'spades')
    const game: GuandanGame = {
      ...makeEmptyGame('south'),
      players: {
        south: [card],
        east: [],
        north: [],
        west: [],
      },
      actions: [
        {
          index: 0,
          trickIndex: 0,
          seat: 'south',
          action: 'play',
          play: {
            type: 'single',
            cards: [card],
            label: '单张 4',
            detail: '单张 4',
            shortLabel: '单张',
            primaryValue: 4,
            sequenceIndex: null,
            sameRankCount: null,
            bombTier: 0,
            wildCount: 0,
            assignments: {},
          },
          handCountAfter: 0,
          remainingCounts: { south: 0, east: 0, north: 0, west: 0 },
          winningSeat: 'south',
          note: '单张 4',
        },
      ],
      tricks: [{ index: 0, leader: 'south', winningSeat: 'south', actionIndexes: [0] }],
      finishOrder: [{ seat: 'south', place: 1 }],
    }

    const snapshot = buildReplaySnapshot(game, 99)
    expect(snapshot.stepIndex).toBe(1)
    expect(snapshot.isComplete).toBe(true)
    expect(snapshot.nextSeat).toBeNull()
    expect(snapshot.completedTricks).toHaveLength(1)
    expect(snapshot.currentTrick).toBeNull()
  })

  it('clears currentTrick at the boundary after a trick is fully completed', () => {
    const card = makeCard('s-4', 4, 'spades')
    const game: GuandanGame = {
      ...makeEmptyGame('south'),
      players: {
        south: [card],
        east: [],
        north: [],
        west: [],
      },
      actions: [
        {
          index: 0,
          trickIndex: 0,
          seat: 'south',
          action: 'play',
          play: {
            type: 'single',
            cards: [card],
            label: '单张 4',
            detail: '单张 4',
            shortLabel: '单张',
            primaryValue: 4,
            sequenceIndex: null,
            sameRankCount: null,
            bombTier: 0,
            wildCount: 0,
            assignments: {},
          },
          handCountAfter: 0,
          remainingCounts: { south: 0, east: 0, north: 0, west: 0 },
          winningSeat: 'south',
          note: '单张 4',
        },
      ],
      tricks: [{ index: 0, leader: 'south', winningSeat: 'south', actionIndexes: [0] }],
      finishOrder: [{ seat: 'south', place: 1 }],
    }

    const snapshot = buildReplaySnapshot(game, 1)

    expect(snapshot.visibleTricks).toHaveLength(1)
    expect(snapshot.visibleTricks[0].complete).toBe(true)
    expect(snapshot.currentTrick).toBeNull()
  })
})