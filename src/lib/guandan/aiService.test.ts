import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIPlayerSession, requestOpeningGuide } from './aiService'
import type { Card, PatternPlay, ReplayAction, Seat } from './types'

function buildConfig() {
  return {
    apiKey: 'test-key',
    model: 'minimax/minimax-m2.7',
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

  it('sends absolute seat, team, and partner-awareness data in the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"cards":["3a"],"reason":"先出最小单张"}' } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const card3 = makeCard('3a-1', 3, 'spades')
    const card4 = makeCard('4b-1', 4, 'hearts')
    const actions: ReplayAction[] = [
      makeAction(0, 0, 'north', makeSinglePlay(card4), 'north'),
    ]

    const session = new AIPlayerSession(buildConfig(), 'south', 7)
    await session.requestPlay(
      [card3, card4],
      actions,
      makeSinglePlay(card4),
      false,
      { south: 25, east: 27, north: 26, west: 27 },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const prompt = body.messages[1].content

    expect(prompt).toContain('"leader"')
    expect(prompt).toContain('"seatId": "north"')
    expect(prompt).toContain('"team": "ns"')
    expect(prompt).toContain('"relationToYou": "partner"')
    expect(prompt).toContain('"shouldUsuallyYieldToPartner": true')
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

  it('extracts the first valid JSON object even with leading blank lines and content parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            {
              type: 'text',
              text: '\n\n\n先看局面，再出牌。\n```json\n{"cards":["3a"],"reason":"保留结构先出最小单张"}\n```',
            },
          ],
        },
      }],
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

    expect(result.pass).toBe(false)
    expect(result.cards).toEqual(['3a'])
    expect(result.reason).toBe('保留结构先出最小单张')
  })

  it('parses stringified JSON from non-chat text responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ text: '"{\\"cards\\":[\\"3a\\"],\\"reason\\":\\"外层仍是字符串JSON\\"}"' }],
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

    expect(result.pass).toBe(false)
    expect(result.cards).toEqual(['3a'])
    expect(result.reason).toBe('外层仍是字符串JSON')
  })

  it('parses starter opening guide responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '\n\n{"headline":"牌面引导","items":[{"label":"大王","outsideCount":2},{"label":"级牌 9","outsideCount":5}]}' } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const guide = await requestOpeningGuide(buildConfig(), [makeCard('HA-1', 14, 'hearts')], 9)

    expect(guide.headline).toBe('牌面引导')
    expect(guide.items).toEqual([
      { label: '大王', outsideCount: 2 },
      { label: '级牌 9', outsideCount: 5 },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})