/**
 * OpenRouter AI service for Guandan card game.
 * Each player gets an independent session (separate API calls with full context).
 */

import type { Card, PatternPlay, ReplayAction, Seat } from './types'
import { cardToCode } from './cardCode'
import { rankToText, SEAT_LABELS } from './engine'

export interface AIConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export const DEFAULT_AI_CONFIG: Omit<AIConfig, 'apiKey'> = {
  model: 'google/gemini-2.0-flash-001',
  baseUrl: 'https://openrouter.ai/api/v1',
}

interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIPlayResult {
  cards: string[]
  pass: boolean
  reason: string
}

export interface AIConnectivityResult {
  ok: boolean
  message: string
}

/** Partner mapping */
const PARTNER_SEAT: Record<Seat, Seat> = {
  south: 'north',
  north: 'south',
  east: 'west',
  west: 'east',
}

function buildSystemPrompt(seat: Seat, levelRank: number): string {
  const levelText = rankToText(levelRank)
  return `你是一个掼蛋(Guandan)高手，坐在${SEAT_LABELS[seat]}位置。你的搭档是${SEAT_LABELS[PARTNER_SEAT[seat]]}。

掼蛋规则：
- 两副标准扑克牌（共108张），四人游戏，南北为一队，东西为一队
- 本局级牌：${levelText}，红桃${levelText}是"逢人配"（万能牌，可替代除大小王外的任何牌）
- 牌力大小：2 < 3 < ... < K < A < 级牌(${levelText}) < 小王 < 大王
- 牌型：单张、对子、三同张、三带二(夯)、顺子(5+连续)、连对(3+连续对)、钢板(2+连续三同张)、炸弹(4+同点数)、同花顺(5+同花色连续)、天王炸(4张王)
- 炸弹大小：4张 < 5张 < 同花顺 < 6张 < 7张 < 8张 < 天王炸
- 跟牌必须压过上家出的牌，否则过牌
- 炸弹可以压任何非炸弹牌型

牌面编码：
- 1=A, 2=2, 3=3, ..., 10=10, 11=J, 12=Q, 13=K
- 花色: a=♠黑桃, b=♥红桃, c=♣梅花, d=♦方块
- 例: 1a=A♠, 13b=K♥, 11c=J♣, 5d=5♦
- SJ=小王, BJ=大王

策略要点：
- 优先出小牌和散牌，保留大牌和炸弹
- 搭档快要打完时主动喂牌
- 对手剩余牌少时果断用炸弹抢权
- 保持手牌结构完整，避免拆散炸弹或连对

请严格以JSON格式回复，不要添加任何其他文字或markdown标记。
出牌: {"cards": ["1a", "1d"], "reason": "简短理由"}
过牌: {"cards": [], "pass": true, "reason": "简短理由"}`
}

function formatPlayHistory(actions: ReplayAction[]): string {
  if (actions.length === 0) return '暂无出牌历史。'

  const lines: string[] = []
  let currentTrickIdx = -1

  for (const action of actions) {
    if (action.trickIndex !== currentTrickIdx) {
      currentTrickIdx = action.trickIndex
      lines.push(`\n第${currentTrickIdx + 1}轮:`)
    }

    if (action.play) {
      const codes = action.play.cards.map(cardToCode).join(',')
      const wildNote = action.play.wildCount > 0 ? ' (含逢人配)' : ''
      lines.push(`  ${SEAT_LABELS[action.seat]}出 [${codes}] ${action.play.label}${wildNote}`)
    } else {
      lines.push(`  ${SEAT_LABELS[action.seat]}过牌`)
    }
  }

  return lines.join('\n')
}

function buildTurnPrompt(
  _seat: Seat,
  hand: Card[],
  actions: ReplayAction[],
  currentPlay: PatternPlay | null,
  isLeading: boolean,
  _levelRank: number,
  remainingCounts: Record<Seat, number>,
): string {
  const handCodes = hand.map(cardToCode).join(', ')
  const history = formatPlayHistory(actions)

  const remainingInfo = (['south', 'east', 'north', 'west'] as Seat[])
    .map((s) => `${SEAT_LABELS[s]}:${remainingCounts[s]}张`)
    .join('  ')

  let turnInstruction: string
  if (isLeading) {
    turnInstruction = '轮到你领出，可以出任意牌型。'
  } else if (currentPlay) {
    const wildNote = currentPlay.wildCount > 0 ? '（含逢人配）' : ''
    turnInstruction = `当前需要压过: ${currentPlay.detail}${wildNote}（${currentPlay.type}）\n压不过则过牌。`
  } else {
    turnInstruction = '轮到你出牌。'
  }

  return `你的手牌（${hand.length}张）: [${handCodes}]

各家剩余: ${remainingInfo}

出牌记录:
${history}

${turnInstruction}

请以JSON回复。`
}

function parseAIResponse(text: string): AIPlayResult {
  // Try to extract JSON from the response (might be wrapped in markdown)
  const jsonMatch = text.match(/\{[\s\S]*?\}/)
  if (!jsonMatch) {
    return { cards: [], pass: true, reason: 'AI回复格式错误' }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    const cards = Array.isArray(parsed.cards) ? parsed.cards.map(String) : []
    return {
      cards,
      pass: parsed.pass === true || cards.length === 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    }
  } catch {
    return { cards: [], pass: true, reason: 'AI回复解析失败' }
  }
}

async function callOpenRouter(
  config: AIConfig,
  messages: AIMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Guandan Memory Lab',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.6,
      max_tokens: 256,
    }),
    signal,
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    if (response.status === 401) throw new Error('API密钥无效，请检查设置。')
    if (response.status === 429) throw new Error('请求过于频繁，请稍后再试。')
    throw new Error(`AI请求失败 (${response.status}): ${errBody.slice(0, 120)}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

export async function testOpenRouterConnection(
  config: AIConfig,
  signal?: AbortSignal,
): Promise<AIConnectivityResult> {
  const response = await fetch(`${config.baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Guandan Memory Lab',
    },
    signal,
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    if (response.status === 401) {
      return { ok: false, message: '连接失败：API Key 无效或已过期。' }
    }
    if (response.status === 429) {
      return { ok: false, message: '连接失败：请求频率受限，请稍后重试。' }
    }
    return {
      ok: false,
      message: `连接失败 (${response.status})：${errBody.slice(0, 120)}`,
    }
  }

  const data = (await response.json().catch(() => ({}))) as {
    data?: Array<{ id?: string }>
  }
  const modelIds = Array.isArray(data.data) ? data.data.map((m) => m?.id ?? '') : []
  const modelFound = modelIds.includes(config.model)

  if (modelFound) {
    return { ok: true, message: `连接成功：模型 ${config.model} 可用。` }
  }

  const fallback = modelIds.slice(0, 3).filter(Boolean).join(' / ')
  return {
    ok: true,
    message: fallback
      ? `连接成功：未检出模型 ${config.model}，可用示例：${fallback}`
      : `连接成功：未检出模型 ${config.model}，请确认模型名。`,
  }
}

/**
 * Independent AI player session.
 * Each session is stateless — full game context is sent with each request.
 */
export class AIPlayerSession {
  private systemPrompt: string
  private config: AIConfig
  readonly seat: Seat
  readonly levelRank: number

  constructor(config: AIConfig, seat: Seat, levelRank: number) {
    this.config = config
    this.seat = seat
    this.levelRank = levelRank
    this.systemPrompt = buildSystemPrompt(seat, levelRank)
  }

  /**
   * Request a play decision from the AI.
   * Returns the AI's parsed response with card codes and reasoning.
   */
  async requestPlay(
    hand: Card[],
    actions: ReplayAction[],
    currentPlay: PatternPlay | null,
    isLeading: boolean,
    remainingCounts: Record<Seat, number>,
    signal?: AbortSignal,
  ): Promise<AIPlayResult> {
    const userMessage = buildTurnPrompt(
      this.seat,
      hand,
      actions,
      currentPlay,
      isLeading,
      this.levelRank,
      remainingCounts,
    )

    const messages: AIMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userMessage },
    ]

    const MAX_RETRIES = 2
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const responseText = await callOpenRouter(this.config, messages, signal)
        const result = parseAIResponse(responseText)

        // If AI returned cards, it's a real play attempt
        if (result.cards.length > 0 || result.pass) {
          return result
        }

        // Empty cards without explicit pass — treat as pass on last attempt
        if (attempt === MAX_RETRIES) {
          return { cards: [], pass: true, reason: 'AI未返回有效出牌' }
        }

        // Retry with clarification
        messages.push({ role: 'assistant', content: responseText })
        messages.push({
          role: 'user',
          content: '请直接回复JSON格式的出牌决定，不要添加其他文字。',
        })
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err
        // Brief delay before retry
        await new Promise((r) => setTimeout(r, 800))
      }
    }

    return { cards: [], pass: true, reason: '请求失败' }
  }
}
