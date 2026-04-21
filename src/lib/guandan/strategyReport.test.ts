import { describe, expect, it } from 'vitest'
import { analyzeGameStrategy, simulateStrategyGames } from './strategyReport'
import type { Card, GuandanGame } from './types'

function makeCard(id: string, rank: number, suit: Card['suit'], deck: 1 | 2 = 1): Card {
  return { id, rank, suit, deck }
}

describe('strategyReport', () => {
  it('flags obvious bomb overuse when a smaller response exists', () => {
    const three = makeCard('e-3', 3, 'spades')
    const game: GuandanGame = {
      seed: 99,
      levelRank: 2,
      startingSeat: 'east',
      players: {
        south: [
          makeCard('s-4s', 4, 'spades'),
          makeCard('s-4h', 4, 'hearts'),
          makeCard('s-4c', 4, 'clubs'),
          makeCard('s-4d', 4, 'diamonds'),
          makeCard('s-6', 6, 'spades'),
        ],
        east: [
          three,
          makeCard('e-5', 5, 'clubs'),
          makeCard('e-6', 6, 'clubs'),
          makeCard('e-7', 7, 'clubs'),
          makeCard('e-8', 8, 'clubs'),
          makeCard('e-9', 9, 'clubs'),
          makeCard('e-j', 11, 'clubs'),
        ],
        north: [makeCard('n-j', 11, 'spades')],
        west: [makeCard('w-q', 12, 'spades')],
      },
      actions: [
        {
          index: 0,
          trickIndex: 0,
          seat: 'east',
          action: 'play',
          play: {
            type: 'single',
            cards: [three],
            label: '单张 3',
            detail: '单张 3',
            shortLabel: '单张',
            primaryValue: 3,
            sequenceIndex: null,
            sameRankCount: null,
            bombTier: 0,
            wildCount: 0,
            assignments: {},
          },
          handCountAfter: 6,
          remainingCounts: { south: 5, east: 6, north: 1, west: 1 },
          winningSeat: 'east',
          note: '单张 3',
        },
        {
          index: 1,
          trickIndex: 0,
          seat: 'north',
          action: 'pass',
          play: null,
          handCountAfter: 1,
          remainingCounts: { south: 5, east: 6, north: 1, west: 1 },
          winningSeat: 'east',
          note: '过牌',
        },
        {
          index: 2,
          trickIndex: 0,
          seat: 'west',
          action: 'pass',
          play: null,
          handCountAfter: 1,
          remainingCounts: { south: 5, east: 6, north: 1, west: 1 },
          winningSeat: 'east',
          note: '过牌',
        },
        {
          index: 3,
          trickIndex: 0,
          seat: 'south',
          action: 'play',
          play: {
            type: 'bomb',
            cards: [
              makeCard('s-4s', 4, 'spades'),
              makeCard('s-4h', 4, 'hearts'),
              makeCard('s-4c', 4, 'clubs'),
              makeCard('s-4d', 4, 'diamonds'),
            ],
            label: '炸弹 4',
            detail: '炸弹 4',
            shortLabel: '炸弹',
            primaryValue: 4,
            sequenceIndex: null,
            sameRankCount: 4,
            bombTier: 4,
            wildCount: 0,
            assignments: {},
          },
          handCountAfter: 1,
          remainingCounts: { south: 1, east: 6, north: 1, west: 1 },
          winningSeat: 'south',
          note: '炸弹 4',
        },
      ],
      tricks: [{ index: 0, leader: 'east', winningSeat: 'south', actionIndexes: [0, 1, 2, 3] }],
      finishOrder: [],
      createdAt: '2026-04-21T00:00:00.000Z',
    }

    const report = analyzeGameStrategy(game)

    expect(report.diagnostics.some((diagnostic) => diagnostic.tag === 'bomb-overuse')).toBe(true)
  })

  it('simulates 20 games into structured reports', () => {
    const seeds = Array.from({ length: 20 }, (_, index) => index + 1)
    const report = simulateStrategyGames(seeds)

    expect(report.games).toHaveLength(20)
    expect(report.summary.totalGames).toBe(20)
    expect(report.games.every((game) => game.game.actions.length > 0)).toBe(true)
    expect(report.summary.byTag['partner-block'] ?? 0).toBe(0)
  })
})