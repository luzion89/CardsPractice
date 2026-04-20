import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIPlayerSession } from './aiService'
import type { Card, PatternPlay, ReplayAction, Seat } from './types'

function buildConfig() {
  return {
    apiKey: 'test-key',
    model: 'google/gemini-2.0-flash-001',
    baseUrl: 'https://openrouter.ai/api/v1',
  }
}

function makeCard(id: string, rank: number, suit: Card['suit']): Card {
  return { id, rank, suit, deck: 1 }
}

function makeSinglePlay(card: Card): PatternPlay {
  return {
    type: 'single',
    cards: [card],
    label: '单张',
    detail: `单张${card.rank}`,
    shortLabel: `单${card.rank}`,
    primaryValue: card.rank,
    sequenceIndex: null,
    sameRankCount: null,
    bombTier: 0,
    wildCount: 0,
    assignments: {},
  }
}

function makeAction(
  index: number,
  trickIndex: number,
  seat: Seat,
  play: PatternPlay | null,
  winningSeat: Seat | null,
): ReplayAction {
  return {
    index,
    trickIndex,
    seat,
    action: play ? 'play' : 'pass',
    play,
    handCountAfter: 27 - index,
    remainingCounts: {
      south: 27,
      east: 27,
      north: 27,
      west: 27,
    },
    winningSeat,
    note: play ? play.detail : '过牌',
  }
}

describe('AIPlayerSession', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:4173' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends structured trick leader and relation data in the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"cards":["3a"],"reason":"先出最小单张"}' } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const card3 = makeCard('3a-1', 3, 'spades')
    const card4 = makeCard('4b-1', 4, 'hearts')
    const actions: ReplayAction[] = [
      makeAction(0, 0, 'north', makeSinglePlay(card4), 'north'),
      makeAction(1, 0, 'east', null, 'north'),
      makeAction(2, 1, 'south', makeSinglePlay(card3), 'south'),
    ]

    const session = new AIPlayerSession(buildConfig(), 'south', 7)
    await session.requestPlay(
      [card3, card4],
      actions,
      null,
      true,
      { south: 25, east: 27, north: 26, west: 27 },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const prompt = body.messages[1].content

    expect(prompt).toContain('"leader"')
    expect(prompt).toContain('"seat": "north"')
    expect(prompt).toContain('"relation": "partner"')
    expect(prompt).toContain('"relation": "opponent"')
  })

  it('retries request failures three times before succeeding', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network-1'))
      .mockRejectedValueOnce(new Error('network-2'))
      .mockRejectedValueOnce(new Error('network-3'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"cards":["3a"],"reason":"第四次获取成功"}' } }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const card3 = makeCard('3a-1', 3, 'spades')
    const session = new AIPlayerSession(buildConfig(), 'south', 7)
    const result = await session.requestPlay(
      [card3],
      [],
      null,
      true,
      { south: 1, east: 3, north: 2, west: 4 },
    )

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.pass).toBe(false)
    expect(result.cards).toEqual(['3a'])
  })
})