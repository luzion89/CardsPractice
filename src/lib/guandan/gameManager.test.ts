import { describe, expect, it, vi } from 'vitest'
import { GameManager } from './gameManager'
import { AIRequestError, type AIPlayResult } from './aiService'

function buildConfig() {
  return {
    apiKey: 'test-key',
    model: 'minimax/minimax-m2.7',
    baseUrl: 'https://openrouter.ai/api/v1',
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
})