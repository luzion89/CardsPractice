import { describe, expect, it, vi } from 'vitest'
import { GameManager } from './gameManager'
import { AIRequestError, type AIPlayResult } from './aiService'
import type { Card, PatternPlay, ReplayAction, Seat } from './types'

function buildConfig() {
  return {
    apiKey: 'test-key',
    model: 'minimax/minimax-m2.7',
    baseUrl: 'https://openrouter.ai/api/v1',
  }
}

function makeCard(id: string, rank: number, suit: Card['suit'], deck: 1 | 2 = 1): Card {
  return { id, rank, suit, deck }
}

function makeSinglePlay(card: Card): PatternPlay {
  return {
    type: 'single',
    cards: [card],
    label: `单张 ${card.rank}`,
    detail: `单张 ${card.rank}`,
    shortLabel: '单张',
    primaryValue: card.rank,
    sequenceIndex: null,
    sameRankCount: null,
    bombTier: 0,
    wildCount: 0,
    assignments: {},
  }
}

describe('GameManager', () => {
  it('applies a legal action selected by actionId', async () => {
    const manager = new GameManager(buildConfig(), 7)
    const state = manager.getState()
    const currentSeat = state.currentSeat
    expect(currentSeat).not.toBeNull()

    const sessions = (manager as unknown as {
      aiSessions: Record<string, { requestPlay: () => Promise<AIPlayResult> }>
    }).aiSessions

    sessions[currentSeat!].requestPlay = vi.fn().mockResolvedValue({
      actionId: 'A01',
      cards: [],
      pass: false,
      reason: '选择第一个合法动作',
    })

    const action = await manager.playNextMove()

    expect(action.play).not.toBeNull()
    expect(action.action).toBe('play')
    expect(manager.getState().lastAIReason).toBe('选择第一个合法动作')
  })

  it('falls back to a legal lead when AI incorrectly passes on lead', async () => {
    const manager = new GameManager(buildConfig(), 7)
    const state = manager.getState()
    const currentSeat = state.currentSeat
    expect(currentSeat).not.toBeNull()

    const sessions = (manager as unknown as {
      aiSessions: Record<string, { requestPlay: () => Promise<AIPlayResult> }>
    }).aiSessions

    sessions[currentSeat!].requestPlay = vi.fn().mockResolvedValue({
      cards: [],
      pass: true,
      reason: 'test-pass-on-lead',
    })

    const action = await manager.playNextMove()

    expect(action.play).not.toBeNull()
    expect(action.action).toBe('play')
    expect(action.handCountAfter).toBe(26)
    expect(manager.getState().game.actions).toHaveLength(1)
    expect(manager.getState().lastAIReason).toBe('AI未给出合法领出，已改用本地最小合法牌')
  })

  it('falls back to a legal lead when AI returns invalid card codes', async () => {
    const manager = new GameManager(buildConfig(), 13)
    const state = manager.getState()
    const currentSeat = state.currentSeat
    expect(currentSeat).not.toBeNull()

    const sessions = (manager as unknown as {
      aiSessions: Record<string, { requestPlay: () => Promise<AIPlayResult> }>
    }).aiSessions

    sessions[currentSeat!].requestPlay = vi.fn().mockResolvedValue({
      cards: ['99z'],
      pass: false,
      reason: 'invalid-cards',
    })

    const action = await manager.playNextMove()

    expect(action.play).not.toBeNull()
    expect(action.action).toBe('play')
    expect(manager.getState().phase).toBe('playing')
    expect(manager.getState().lastAIReason).toBe('AI返回的牌面无法匹配当前手牌，已改用本地最小合法牌')
  })

  it('falls back to a legal lead when AI keeps returning unparsable content', async () => {
    const manager = new GameManager(buildConfig(), 17)
    const state = manager.getState()
    const currentSeat = state.currentSeat
    expect(currentSeat).not.toBeNull()

    const sessions = (manager as unknown as {
      aiSessions: Record<string, { requestPlay: () => Promise<AIPlayResult> }>
    }).aiSessions

    sessions[currentSeat!].requestPlay = vi.fn().mockRejectedValue(
      new AIRequestError('已自动重试3次，AI仍未返回有效出牌信息：未找到有效 JSON 对象', false, 'response-format'),
    )

    const action = await manager.playNextMove()

    expect(action.play).not.toBeNull()
    expect(action.action).toBe('play')
    expect(manager.getState().phase).toBe('playing')
    expect(manager.getState().lastAIReason).toBe('AI连续返回不可解析内容：未找到有效 JSON 对象，已改用本地最小合法牌')
  })

  it('does not expose natural four-of-a-kind singles as normal response options', async () => {
    const manager = new GameManager(buildConfig(), 23)
    const internal = manager as unknown as {
      levelRank: number
      currentSeat: Seat | null
      hands: Record<Seat, Card[]>
      actions: ReplayAction[]
      trickState: {
        leader: Seat
        trickIndex: number
        actionIndexes: number[]
        lastWinningSeat: Seat
        lastWinningPlay: PatternPlay
      } | null
      aiSessions: Record<Seat, { requestPlay: (...args: unknown[]) => Promise<AIPlayResult> }>
    }

    internal.levelRank = 3
    internal.currentSeat = 'south'
    internal.actions = []
    internal.hands = {
      south: [
        makeCard('8-s', 8, 'spades'),
        makeCard('8-h', 8, 'hearts'),
        makeCard('8-c', 8, 'clubs'),
        makeCard('8-d', 8, 'diamonds'),
        makeCard('9-s', 9, 'spades'),
        makeCard('9-h', 9, 'hearts'),
        makeCard('9-c', 9, 'clubs'),
        makeCard('9-d', 9, 'diamonds'),
        makeCard('j-c', 11, 'clubs'),
      ],
      east: [makeCard('e-1', 5, 'clubs')],
      north: [makeCard('n-1', 7, 'clubs')],
      west: [makeCard('w-1', 12, 'clubs')],
    }
    internal.trickState = {
      leader: 'east',
      trickIndex: 0,
      actionIndexes: [],
      lastWinningSeat: 'east',
      lastWinningPlay: makeSinglePlay(makeCard('target-6', 6, 'spades')),
    }

    const requestPlay = vi.fn().mockResolvedValue({
      cards: [],
      pass: true,
      reason: 'capture-legal-actions',
    })
    internal.aiSessions.south.requestPlay = requestPlay

    await manager.playNextMove()

    const legalActions = requestPlay.mock.calls[0][5] as Array<{ label: string; action: string }>
    const playLabels = legalActions.filter((action) => action.action === 'play').map((action) => action.label)

    expect(playLabels).toContain('单张 J')
    expect(playLabels).not.toContain('单张 8')
    expect(playLabels).not.toContain('单张 9')
  })
})