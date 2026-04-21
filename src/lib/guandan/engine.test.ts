import { describe, expect, it } from 'vitest'
import { buildReplaySnapshot, chooseResponsePlay, estimateHandCount, sortHandForDisplay } from './engine'
import type { Card, GuandanGame, PatternPlay, Seat } from './types'

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

describe('estimateHandCount', () => {
  it('treats straights and grouped leftovers as fewer moves', () => {
    const hand = [
      makeCard('3', 3, 'clubs'),
      makeCard('4', 4, 'clubs'),
      makeCard('5', 5, 'clubs'),
      makeCard('6', 6, 'clubs'),
      makeCard('7', 7, 'clubs'),
      makeCard('8a', 8, 'spades'),
      makeCard('8b', 8, 'hearts'),
      makeCard('j', 11, 'clubs'),
    ]

    expect(estimateHandCount(hand, 2)).toBe(3)
  })
})

describe('chooseResponsePlay', () => {
  it('uses a bomb to stop repeated enemy combo pressure', () => {
    const hand = [
      makeCard('9a', 9, 'spades'),
      makeCard('9b', 9, 'hearts'),
      makeCard('9c', 9, 'clubs'),
      makeCard('9d', 9, 'diamonds'),
      makeCard('k', 13, 'clubs'),
      makeCard('a', 14, 'clubs'),
      makeCard('2a', 2, 'clubs'),
      makeCard('2b', 2, 'diamonds'),
    ]

    const currentPlay: PatternPlay = {
      type: 'straight',
      cards: [
        makeCard('5', 5, 'spades'),
        makeCard('6', 6, 'spades'),
        makeCard('7', 7, 'spades'),
        makeCard('8', 8, 'spades'),
        makeCard('10', 10, 'spades'),
      ],
      label: '顺子 6-10',
      detail: '顺子 6-10',
      shortLabel: '顺子',
      primaryValue: 10,
      sequenceIndex: 6,
      sameRankCount: null,
      bombTier: 0,
      wildCount: 0,
      assignments: {},
    }

    const remainingCounts = {
      south: 8,
      east: 6,
      north: 11,
      west: 9,
    }

    const withoutPressure = chooseResponsePlay(hand, 3, currentPlay, 'south', 'east', remainingCounts)
    const withPressure = chooseResponsePlay(hand, 3, currentPlay, 'south', 'east', remainingCounts, {
      recentTricks: [],
      enemyWinningStreak: 2,
      partnerWinningStreak: 0,
      enemyComboPressure: 2,
    })

    expect(withoutPressure).toBeNull()
    expect(withPressure?.type).toBe('bomb')
  })
})