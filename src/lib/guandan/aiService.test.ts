import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIPlayerSession, requestOpeningGuide, type AILegalActionOption } from './aiService'
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

function buildLegalActions(cards: string[]): AILegalActionOption[] {
  return cards.map((card, index) => ({
    actionId: `A${String(index + 1).padStart(2, '0')}`,
    action: 'play',
    label: `候选 ${index + 1}`,
    detail: `候选 ${index + 1}`,
    cards: [card],
  }))
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
      choices: [{ message: { content: '{"actionId":"A01","reason":"先出最小单张"}' } }],
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
      buildLegalActions(['3a']),
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const prompt = body.messages[1].content

    expect(prompt).toContain('leader=')
    expect(prompt).toContain('"seatId": "north"')
    expect(prompt).toContain('"team": "ns"')
    expect(prompt).toContain('"relationToYou": "partner"')
    expect(prompt).toContain('"shouldUsuallyYieldToPartner": true')
    expect(prompt).toContain('"legalActionLines"')
    expect(prompt).toContain('A01 | play | 候选 1 | 3a')
  })

  it('parses actionId responses from structured output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"actionId":"A02","reason":"选择第二个合法动作"}' } }],
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
      buildLegalActions(['3a', '4b']),
    )

    expect(result.actionId).toBe('A02')
    expect(result.cards).toEqual([])
    expect(result.reason).toBe('选择第二个合法动作')
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

  it('switches to a structured-output fallback model after invalid minimax output', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: null,
            reasoning: '我先分析局面，再决定出牌。',
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"actionId":"A01","reason":"备用模型返回合法动作"}' } }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const session = new AIPlayerSession(buildConfig(), 'south', 7)
    const result = await session.requestPlay(
      [makeCard('3a-1', 3, 'spades')],
      [],
      null,
      true,
      { south: 1, east: 3, north: 2, west: 4 },
      buildLegalActions(['3a']),
    )

    const secondCall = fetchMock.mock.calls[1] as [string, RequestInit]
    const secondBody = JSON.parse(String(secondCall[1].body)) as { model: string }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(secondBody.model).toBe('google/gemini-2.0-flash-001')
    expect(result.actionId).toBe('A01')
    expect(result.reason).toBe('备用模型返回合法动作')
  })

  it('switches to the fallback model when the primary model is rate-limited', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: {
            raw: 'temporarily rate-limited upstream',
          },
        },
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '{"actionId":"A01","reason":"限流后切备用模型"}' } }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const session = new AIPlayerSession(buildConfig(), 'south', 7)
    const result = await session.requestPlay(
      [makeCard('3a-1', 3, 'spades')],
      [],
      null,
      true,
      { south: 1, east: 3, north: 2, west: 4 },
      buildLegalActions(['3a']),
    )

    const secondCall = fetchMock.mock.calls[1] as [string, RequestInit]
    const secondBody = JSON.parse(String(secondCall[1].body)) as { model: string }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(secondBody.model).toBe('google/gemini-2.0-flash-001')
    expect(result.actionId).toBe('A01')
    expect(result.reason).toBe('限流后切备用模型')
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

  it('parses function_call arguments when content is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: '',
          function_call: {
            name: 'play_cards',
            arguments: '{"cards":["3a"],"reason":"通过 function_call 返回"}',
          },
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
    expect(result.reason).toBe('通过 function_call 返回')
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