import { describe, expect, it } from 'vitest'
import { chooseLeadPlay, chooseResponsePlay } from './engine'
import type { Card, PatternPlay } from './types'

function makeCard(id: string, rank: number, suit: Card['suit'], deck: 1 | 2 = 1): Card {
  return { id, rank, suit, deck }
}

describe('strategy scenarios', () => {
  it('feeds partner with a low single when partner is close to going out', () => {
    const hand = [
      makeCard('s-3', 3, 'clubs'),
      makeCard('s-8', 8, 'spades'),
      makeCard('s-9', 9, 'spades'),
      makeCard('s-10', 10, 'spades'),
      makeCard('s-j', 11, 'spades'),
      makeCard('s-q', 12, 'spades'),
      makeCard('s-a', 14, 'hearts'),
    ]

    const play = chooseLeadPlay(hand, 2, 'south', {
      south: 7,
      east: 9,
      north: 2,
      west: 11,
    })

    expect(play?.type).toBe('single')
    expect(play?.primaryValue).toBe(3)
  })

  it('does not overtake partner unless it can finish immediately', () => {
    const hand = [
      makeCard('s-8', 8, 'clubs'),
      makeCard('s-9', 9, 'clubs'),
      makeCard('s-j', 11, 'clubs'),
      makeCard('s-q', 12, 'clubs'),
    ]

    const currentPlay: PatternPlay = {
      type: 'single',
      cards: [makeCard('n-7', 7, 'spades')],
      label: '单张 7',
      detail: '单张 7',
      shortLabel: '单张',
      primaryValue: 7,
      sequenceIndex: null,
      sameRankCount: null,
      bombTier: 0,
      wildCount: 0,
      assignments: {},
    }

    const response = chooseResponsePlay(hand, 2, currentPlay, 'south', 'north', {
      south: 4,
      east: 8,
      north: 2,
      west: 10,
    })

    expect(response).toBeNull()
  })

  it('passes on oversized single responses when there is no immediate pressure', () => {
    const hand = [
      makeCard('s-j', 11, 'clubs'),
      makeCard('s-a', 14, 'clubs'),
      makeCard('s-k', 13, 'hearts'),
      makeCard('s-2', 2, 'spades'),
    ]

    const currentPlay: PatternPlay = {
      type: 'single',
      cards: [makeCard('e-6', 6, 'spades')],
      label: '单张 6',
      detail: '单张 6',
      shortLabel: '单张',
      primaryValue: 6,
      sequenceIndex: null,
      sameRankCount: null,
      bombTier: 0,
      wildCount: 0,
      assignments: {},
    }

    const response = chooseResponsePlay(hand, 3, currentPlay, 'south', 'east', {
      south: 4,
      east: 9,
      north: 8,
      west: 10,
    })

    expect(response).toBeNull()
  })

  it('avoids leading a joker when a safe low single exists', () => {
    const hand = [
      makeCard('s-joker', 16, 'black'),
      makeCard('s-4', 4, 'clubs'),
      makeCard('s-5', 5, 'diamonds'),
      makeCard('s-7a', 7, 'spades'),
      makeCard('s-7b', 7, 'hearts'),
      makeCard('s-9', 9, 'clubs'),
      makeCard('s-q', 12, 'clubs'),
      makeCard('s-k', 13, 'clubs'),
    ]

    const play = chooseLeadPlay(hand, 2, 'south', {
      south: 8,
      east: 9,
      north: 7,
      west: 10,
    })

    expect(play?.type).toBe('single')
    expect(play?.primaryValue).toBe(4)
  })
})