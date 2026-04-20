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

type SeatRelation = 'self' | 'partner' | 'opponent'

type ParsedAIResponse =
  | { ok: true; result: AIPlayResult }
  | { ok: false; message: string }

class AIRequestError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'AIRequestError'
    this.retryable = retryable
  }
}

/** Partner mapping */
const PARTNER_SEAT: Record<Seat, Seat> = {
  south: 'north',
  north: 'south',
  east: 'west',
  west: 'east',
}

function getSeatRelation(viewer: Seat, actor: Seat): SeatRelation {
  if (viewer === actor) return 'self'
  if (PARTNER_SEAT[viewer] === actor) return 'partner'
  return 'opponent'
}

function describeSeat(viewer: Seat, actor: Seat) {
  return {
    seat: actor,
    label: SEAT_LABELS[actor],
    relation: getSeatRelation(viewer, actor),
  }
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
- relation 字段含义：self=你，partner=搭档，opponent=对手；判断敌我时必须优先看 relation，不要把搭档当作对手去压
- 领出时优先走独立散牌、边张或低位完整牌型，先试探再升级；若手里有完整顺子、连对、钢板或三同张，不要为了打一张单牌随意拆开
- 结构保护优先级：天王炸/炸弹/同花顺 > 钢板/连对/顺子 > 三同张 > 对子 > 单张；除非抢关键牌权、喂搭档、或拆后能明显加快自己走完，否则不要拆高结构去凑低结构
- 特别注意：小三同张、小连对、小顺子若还有别的合法单张/对子可出，优先不拆；不要把小三张拆成单牌去送节奏
- 跟牌时能小压就小压，避免无谓抬高；若当前领先者是搭档且局面安全，通常不要压搭档，除非你是在送搭档、能顺势连续出牌、或必须阻止对手夺权
- 对手剩 1 到 2 手、报单或明显即将走完时，优先保留或使用控制牌阻断对手，必要时果断用炸弹抢回牌权
- 搭档接近走完时，优先送搭档易接的牌型，不要只顾自己最小化出牌而破坏队友节奏
- 逢人配优先用于补强关键组合（顺子、连对、钢板、夯、炸弹边缘位），不要轻易当普通小单牌浪费
- 只有在没有其他合法选择，或拆牌后能显著优化整体出完路线时，才允许拆三张、连对、顺子、钢板或炸弹

请严格以JSON格式回复，不要添加任何其他文字或markdown标记。
出牌: {"cards": ["1a", "1d"], "reason": "简短理由"}
过牌: {"cards": [], "pass": true, "reason": "简短理由"}`
}

function buildStructuredHistory(viewer: Seat, actions: ReplayAction[]) {
  const history = new Map<number, {
    trickNumber: number
    leader: ReturnType<typeof describeSeat>
    winnerSoFar: ReturnType<typeof describeSeat> | null
    actions: Array<{
      order: number
      seat: Seat
      relation: SeatRelation
      action: 'play' | 'pass'
      cards: string[]
      pattern: string
      note: string
      handCountAfter: number
    }>
  }>()

  for (const action of actions) {
    const existing = history.get(action.trickIndex)
    const trick = existing ?? {
      trickNumber: action.trickIndex + 1,
      leader: describeSeat(viewer, action.seat),
      winnerSoFar: action.winningSeat ? describeSeat(viewer, action.winningSeat) : null,
      actions: [],
    }

    trick.winnerSoFar = action.winningSeat ? describeSeat(viewer, action.winningSeat) : trick.winnerSoFar
    trick.actions.push({
      order: trick.actions.length + 1,
      seat: action.seat,
      relation: getSeatRelation(viewer, action.seat),
      action: action.action,
      cards: action.play?.cards.map(cardToCode) ?? [],
      pattern: action.play?.label ?? 'pass',
      note: action.note,
      handCountAfter: action.handCountAfter,
    })

    history.set(action.trickIndex, trick)
  }

  return [...history.values()]
}

function buildTurnPrompt(
  seat: Seat,
  hand: Card[],
  actions: ReplayAction[],
  currentPlay: PatternPlay | null,
  isLeading: boolean,
  levelRank: number,
  remainingCounts: Record<Seat, number>,
): string {
  const levelText = rankToText(levelRank)
  const handCodes = hand.map(cardToCode)
  const lastAction = actions[actions.length - 1] ?? null
  const payload = {
    perspective: {
      you: describeSeat(seat, seat),
      partner: describeSeat(seat, PARTNER_SEAT[seat]),
      opponents: (['south', 'east', 'north', 'west'] as Seat[])
        .filter((actor) => actor !== seat && actor !== PARTNER_SEAT[seat])
        .map((actor) => describeSeat(seat, actor)),
    },
    level: {
      rank: levelText,
      wildCard: `红桃${levelText}`,
    },
    hand: {
      count: hand.length,
      cards: handCodes,
    },
    remainingCounts: (['south', 'east', 'north', 'west'] as Seat[]).map((actor) => ({
      ...describeSeat(seat, actor),
      remaining: remainingCounts[actor],
    })),
    currentTurn: {
      isLeading,
      instruction: isLeading ? '你是本轮领出方，可以主动选择牌型。' : '你是跟牌方，只能压过当前领先牌型，否则过牌。',
      currentWinningSeat: lastAction?.winningSeat ? describeSeat(seat, lastAction.winningSeat) : null,
      targetPlay: currentPlay
        ? {
            type: currentPlay.type,
            label: currentPlay.label,
            detail: currentPlay.detail,
            cards: currentPlay.cards.map(cardToCode),
            wildCount: currentPlay.wildCount,
          }
        : null,
    },
    trickHistory: buildStructuredHistory(seat, actions),
  }

  return `请依据下面的结构化局面做出当前回合决策。队伍关系请优先查看 relation 字段。

局面数据(JSON):
${JSON.stringify(payload, null, 2)}

决策要求:
- 优先保持手牌结构完整，不要为打一张单牌无意义拆三张、连对、顺子、钢板或炸弹
- 仅当你明确选择过牌时，才返回 {"cards": [], "pass": true, "reason": "..."}
- 若选择出牌，cards 必须是你当前手牌中的实际编码，并给出一句简短理由
- 只输出严格 JSON，不要输出 markdown、解释或额外文本`
}

function parseAIResponse(text: string): ParsedAIResponse {
  // Try to extract JSON from the response (might be wrapped in markdown)
  const jsonMatch = text.match(/\{[\s\S]*?\}/)
  if (!jsonMatch) {
    return { ok: false, message: '未找到 JSON 对象' }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    const cards = Array.isArray(parsed.cards) ? parsed.cards.map(String) : []
    if (parsed.pass === true) {
      return {
        ok: true,
        result: {
          cards: [],
          pass: true,
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        },
      }
    }
    if (cards.length === 0) {
      return { ok: false, message: 'cards 为空且未明确声明 pass=true' }
    }
    return {
      ok: true,
      result: {
        cards,
        pass: false,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      },
    }
  } catch {
    return { ok: false, message: 'JSON 解析失败' }
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
    if (response.status === 401) throw new AIRequestError('API密钥无效，请检查设置。', false)
    if (response.status === 429) throw new AIRequestError('请求过于频繁，请稍后再试。', false)
    throw new AIRequestError(`AI请求失败 (${response.status}): ${errBody.slice(0, 120)}`, true)
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

    const MAX_RETRIES = 3
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const isLastAttempt = attempt === MAX_RETRIES
      try {
        const responseText = await callOpenRouter(this.config, messages, signal)
        const parsed = parseAIResponse(responseText)

        if (parsed.ok) {
          return parsed.result
        }

        if (isLastAttempt) {
          throw new AIRequestError(`已自动重试3次，AI仍未返回有效出牌信息：${parsed.message}`, false)
        }

        messages.push({ role: 'assistant', content: responseText })
        messages.push({
          role: 'user',
          content: `你上一条回复无效，原因：${parsed.message}。请重新决策，并且只回复严格 JSON，不要添加其他文字。`,
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err
        }

        const retryable = err instanceof AIRequestError ? err.retryable : true
        if (!retryable || isLastAttempt) {
          throw err
        }

        await new Promise((r) => setTimeout(r, 800))
      }
    }

    throw new Error('已自动重试3次，仍未取得有效出牌信息。')
  }
}
