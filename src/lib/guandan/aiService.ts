/**
 * OpenRouter AI service for Guandan card game.
 * Each player gets an independent session (separate API calls with full context).
 */

import type { Card, PatternPlay, ReplayAction, Seat } from './types'
import { cardToCode } from './cardCode'
import { rankToText, SEAT_LABELS, totalFaceCount } from './engine'

export interface AIConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export const DEFAULT_AI_CONFIG: Omit<AIConfig, 'apiKey'> = {
  model: 'minimax/minimax-m2.7',
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

export interface OpeningGuideItem {
  label: string
  outsideCount: number
}

export interface OpeningGuideResult {
  headline: string
  items: OpeningGuideItem[]
}

type SeatRelation = 'self' | 'partner' | 'opponent'
type SeatTeam = 'ns' | 'ew'

type ParsedAIResponse =
  | { ok: true; result: AIPlayResult }
  | { ok: false; message: string }

export type AIRequestErrorKind = 'auth' | 'rate-limit' | 'request' | 'response-format'

export class AIRequestError extends Error {
  kind: AIRequestErrorKind
  retryable: boolean
  details?: string

  constructor(message: string, retryable: boolean, kind: AIRequestErrorKind = 'request', details?: string) {
    super(message)
    this.name = 'AIRequestError'
    this.kind = kind
    this.retryable = retryable
    this.details = details
  }
}

/** Partner mapping */
const PARTNER_SEAT: Record<Seat, Seat> = {
  south: 'north',
  north: 'south',
  east: 'west',
  west: 'east',
}

const AI_SEAT_NAMES: Record<Seat, string> = {
  south: '南家',
  east: '东家',
  north: '北家',
  west: '西家',
}

const SEAT_TEAMS: Record<Seat, SeatTeam> = {
  south: 'ns',
  north: 'ns',
  east: 'ew',
  west: 'ew',
}

function getSeatRelation(viewer: Seat, actor: Seat): SeatRelation {
  if (viewer === actor) return 'self'
  if (PARTNER_SEAT[viewer] === actor) return 'partner'
  return 'opponent'
}

function describeSeat(viewer: Seat, actor: Seat) {
  return {
    seatId: actor,
    absoluteName: AI_SEAT_NAMES[actor],
    uiLabel: SEAT_LABELS[actor],
    team: SEAT_TEAMS[actor],
    relationToYou: getSeatRelation(viewer, actor),
  }
}

function countRank(hand: Card[], rank: number) {
  return hand.filter((card) => card.rank === rank).length
}

export function buildOpeningGuideItems(hand: Card[], levelRank: number): OpeningGuideItem[] {
  const items: OpeningGuideItem[] = [
    {
      label: '大王',
      outsideCount: Math.max(0, totalFaceCount(17) - countRank(hand, 17)),
    },
    {
      label: '小王',
      outsideCount: Math.max(0, totalFaceCount(16) - countRank(hand, 16)),
    },
    {
      label: `级牌 ${rankToText(levelRank)}`,
      outsideCount: Math.max(0, totalFaceCount(levelRank) - countRank(hand, levelRank)),
    },
    {
      label: `逢人配 红桃${rankToText(levelRank)}`,
      outsideCount: Math.max(0, 2 - hand.filter((card) => card.rank === levelRank && card.suit === 'hearts').length),
    },
  ]

  if (levelRank !== 14) {
    items.push({
      label: 'A',
      outsideCount: Math.max(0, totalFaceCount(14) - countRank(hand, 14)),
    })
  }

  if (levelRank !== 13) {
    items.push({
      label: 'K',
      outsideCount: Math.max(0, totalFaceCount(13) - countRank(hand, 13)),
    })
  }

  return items
}

function buildOpeningGuidePayload(hand: Card[], levelRank: number) {
  return {
    levelRank: rankToText(levelRank),
    handCount: hand.length,
    handCards: hand.map(cardToCode),
    outsideFocusCounts: buildOpeningGuideItems(hand, levelRank),
  }
}

function normalizeResponseContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map((part) => normalizeResponseContent(part)).join('')
  }

  if (content && typeof content === 'object') {
    const maybeText = content as {
      text?: unknown
      content?: unknown
      value?: unknown
      arguments?: unknown
      parsed?: unknown
    }
    if (typeof maybeText.text === 'string') {
      return maybeText.text
    }
    if (maybeText.parsed !== undefined) {
      return JSON.stringify(maybeText.parsed)
    }
    if (maybeText.arguments !== undefined) {
      return normalizeResponseContent(maybeText.arguments)
    }
    if (maybeText.value !== undefined) {
      return normalizeResponseContent(maybeText.value)
    }
    if (maybeText.content !== undefined) {
      return normalizeResponseContent(maybeText.content)
    }
  }

  return ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type JsonValidator<T> = (value: unknown) => value is T

function extractBalancedJsonSegments(text: string, opening: '{' | '[', closing: '}' | ']') {
  const segments: string[] = []
  const source = text.replace(/^\uFEFF/, '')

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== opening) {
      continue
    }

    let depth = 0
    let inString = false
    let isEscaped = false

    for (let index = start; index < source.length; index += 1) {
      const char = source[index]

      if (inString) {
        if (isEscaped) {
          isEscaped = false
          continue
        }
        if (char === '\\') {
          isEscaped = true
          continue
        }
        if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }

      if (char === opening) {
        depth += 1
        continue
      }

      if (char === closing) {
        depth -= 1
        if (depth === 0) {
          segments.push(source.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }

  return segments
}

function collectJsonCandidates(text: string) {
  const candidates: string[] = []
  const seen = new Set<string>()
  const source = text.replace(/^\uFEFF/, '')

  const push = (value: string | null | undefined) => {
    const normalized = value?.trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    candidates.push(normalized)
  }

  push(source)

  const codeFencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = codeFencePattern.exec(source)) !== null) {
    push(match[1])
  }

  for (const segment of extractBalancedJsonSegments(source, '{', '}')) {
    push(segment)
  }

  for (const segment of extractBalancedJsonSegments(source, '[', ']')) {
    push(segment)
  }

  return candidates
}

function walkParsedJson<T>(
  value: unknown,
  validator: JsonValidator<T>,
  seenTexts: Set<string>,
  depth: number,
): T | null {
  if (validator(value)) {
    return value
  }

  if (depth >= 6) {
    return null
  }

  if (typeof value === 'string') {
    return findJsonValue(value, validator, seenTexts, depth + 1)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walkParsedJson(item, validator, seenTexts, depth + 1)
      if (found) {
        return found
      }
    }
    return null
  }

  if (!isPlainObject(value)) {
    return null
  }

  const preferredKeys = ['result', 'response', 'output', 'answer', 'data', 'json', 'content', 'message', 'arguments', 'function_call', 'tool_calls', 'parsed', 'value', 'args']
  for (const key of preferredKeys) {
    if (!(key in value)) {
      continue
    }
    const found = walkParsedJson(value[key], validator, seenTexts, depth + 1)
    if (found) {
      return found
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = walkParsedJson(nestedValue, validator, seenTexts, depth + 1)
    if (found) {
      return found
    }
  }

  return null
}

function findJsonValue<T>(
  text: string,
  validator: JsonValidator<T>,
  seenTexts = new Set<string>(),
  depth = 0,
): T | null {
  if (depth >= 6) {
    return null
  }

  for (const candidate of collectJsonCandidates(text)) {
    if (seenTexts.has(candidate)) {
      continue
    }
    seenTexts.add(candidate)

    try {
      const parsed = JSON.parse(candidate)
      const found = walkParsedJson(parsed, validator, seenTexts, depth + 1)
      if (found) {
        return found
      }
    } catch {
      continue
    }
  }

  return null
}

type AIResponsePayload = {
  cards?: unknown
  card?: unknown
  pass?: unknown
  reason?: unknown
}

function isAIResponsePayload(value: unknown): value is AIResponsePayload {
  return isPlainObject(value) && ('cards' in value || 'card' in value || 'pass' in value || 'reason' in value)
}

type OpeningGuidePayload = {
  headline?: unknown
  items?: unknown
}

function isOpeningGuidePayload(value: unknown): value is OpeningGuidePayload {
  return isPlainObject(value) && ('headline' in value || 'items' in value)
}

function splitCardCodes(value: string) {
  return value
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

type OpenRouterResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      jsonSchema: {
        name: string
        strict?: boolean
        schema: Record<string, unknown>
      }
    }

type OpenRouterRequestOptions = {
  responseFormat?: OpenRouterResponseFormat
  enableResponseHealing?: boolean
  maxTokens?: number
}

type OpenRouterCallResult = {
  text: string
  finishReason: string | null
}

type OpenRouterChoice = {
  finish_reason?: unknown
  text?: unknown
  output_text?: unknown
  message?: {
    content?: unknown
    parsed?: unknown
    output_text?: unknown
    function_call?: {
      arguments?: unknown
    }
    tool_calls?: Array<{
      function?: {
        arguments?: unknown
      }
    }>
  }
}

type OpenRouterChatResponse = {
  choices?: OpenRouterChoice[]
}

function buildPlayResponseFormat(): OpenRouterResponseFormat {
  return {
    type: 'json_schema',
    jsonSchema: {
      name: 'guandan_play',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          cards: {
            type: 'array',
            items: { type: 'string' },
            description: '当前回合选择打出的牌面编码；过牌时返回空数组。',
          },
          pass: {
            type: 'boolean',
            description: '只有在明确选择过牌时才为 true。',
          },
          reason: {
            type: 'string',
            description: '一句简短中文理由。',
          },
        },
        required: ['cards', 'reason'],
        additionalProperties: false,
      },
    },
  }
}

function buildOpeningGuideResponseFormat(): OpenRouterResponseFormat {
  return {
    type: 'json_schema',
    jsonSchema: {
      name: 'opening_guide',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                outsideCount: { type: 'number' },
              },
              required: ['label', 'outsideCount'],
              additionalProperties: false,
            },
          },
        },
        required: ['headline', 'items'],
        additionalProperties: false,
      },
    },
  }
}

function compactText(text: string, limit = 180) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function shouldRetryWithoutResponseFormat(error: unknown) {
  if (!(error instanceof AIRequestError) || error.kind !== 'request') {
    return false
  }

  const source = `${error.message}\n${error.details ?? ''}`.toLowerCase()
  return (
    source.includes('response_format')
    || source.includes('json_schema')
    || source.includes('json_object')
    || source.includes('structured output')
    || source.includes('structured_output')
    || source.includes('response-healing')
  )
}

function serializeFallbackPayload(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function extractResponseText(data: OpenRouterChatResponse): OpenRouterCallResult {
  const choice = data?.choices?.[0]
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  const primaryText = normalizeResponseContent(
    choice?.message?.content
      ?? choice?.text
      ?? choice?.message?.tool_calls?.[0]?.function?.arguments
      ?? choice?.message?.function_call?.arguments
      ?? choice?.message?.parsed
      ?? choice?.message?.output_text
      ?? choice?.output_text
      ?? '',
  )

  if (primaryText.trim()) {
    return { text: primaryText, finishReason }
  }

  return {
    text: serializeFallbackPayload(choice?.message ?? choice ?? data),
    finishReason,
  }
}

function buildSystemPrompt(seat: Seat, levelRank: number): string {
  const levelText = rankToText(levelRank)
  return `你是一个掼蛋(Guandan)高手，你的固定座位是 ${seat}（${AI_SEAT_NAMES[seat]}），固定搭档是 ${PARTNER_SEAT[seat]}（${AI_SEAT_NAMES[PARTNER_SEAT[seat]]}）。南北为一队，东西为一队。

重要说明：
- user interface 里的“自己/下家/对家/上家”只是从南家视角生成的界面称呼，不是你判断敌我的依据。
- 你判断敌我时，必须只看结构化数据中的 seatId、team、relationToYou。
- 如果 relationToYou = partner，默认那就是你的搭档；除非明确有抢权、送牌或拦对手的理由，否则不要去压搭档。

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
- relationToYou 字段含义：self=你，partner=搭档，opponent=对手；判断敌我时必须优先看 relationToYou，不要被 uiLabel 干扰
- 领出时优先走独立散牌、边张或低位完整牌型，先试探再升级；若手里有完整顺子、连对、钢板或三同张，不要为了打一张单牌随意拆开
- 结构保护优先级：天王炸/炸弹/同花顺 > 钢板/连对/顺子 > 三同张 > 对子 > 单张；除非抢关键牌权、喂搭档、或拆后能明显加快自己走完，否则不要拆高结构去凑低结构
- 特别注意：小三同张、小连对、小顺子若还有别的合法单张/对子可出，优先不拆；不要把小三张拆成单牌去送节奏
- 跟牌前先做三步检查：1. 当前领先者是谁；2. 该领先者 relationToYou 是 partner 还是 opponent；3. 这一手是否真的有必要抢走牌权
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
      seatId: Seat
      absoluteName: string
      uiLabel: string
      team: SeatTeam
      relationToYou: SeatRelation
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
      seatId: action.seat,
      absoluteName: AI_SEAT_NAMES[action.seat],
      uiLabel: SEAT_LABELS[action.seat],
      team: SEAT_TEAMS[action.seat],
      relationToYou: getSeatRelation(viewer, action.seat),
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
  const partnerSeat = PARTNER_SEAT[seat]
  const currentWinningSeat = lastAction?.winningSeat ?? null
  const currentWinningRelation = currentWinningSeat ? getSeatRelation(seat, currentWinningSeat) : null
  const dangerousOpponents = (['south', 'east', 'north', 'west'] as Seat[])
    .filter((actor) => getSeatRelation(seat, actor) === 'opponent' && remainingCounts[actor] <= 2)
    .map((actor) => describeSeat(seat, actor))
  const payload = {
    perspective: {
      selfSeat: describeSeat(seat, seat),
      partnerSeat: describeSeat(seat, partnerSeat),
      opponents: (['south', 'east', 'north', 'west'] as Seat[])
        .filter((actor) => actor !== seat && actor !== partnerSeat)
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
      currentWinningSeat: currentWinningSeat ? describeSeat(seat, currentWinningSeat) : null,
      currentWinningRelation,
      dangerousOpponents,
      partnerRemaining: remainingCounts[partnerSeat],
      shouldUsuallyYieldToPartner: currentWinningRelation === 'partner' && currentWinningSeat !== null && remainingCounts[currentWinningSeat] > 1,
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

  return `请依据下面的结构化局面做出当前回合决策。判断敌我时，请优先查看 seatId / team / relationToYou，不要依赖 uiLabel。

局面数据(JSON):
${JSON.stringify(payload, null, 2)}

决策要求:
- 如果 currentWinningRelation = partner 且 shouldUsuallyYieldToPartner = true，默认不要压这手牌；只有在阻止对手、给搭档送更顺的牌路、或自己能顺势快速走牌时才允许改写牌权
- 优先保持手牌结构完整，不要为打一张单牌无意义拆三张、连对、顺子、钢板或炸弹
- 仅当你明确选择过牌时，才返回 {"cards": [], "pass": true, "reason": "..."}
- 若选择出牌，cards 必须是你当前手牌中的实际编码，并给出一句简短理由
- 只输出严格 JSON，不要输出 markdown、解释或额外文本`
}

function parseOpeningGuideResponse(text: string): OpeningGuideResult | null {
  const parsed = findJsonValue(text, isOpeningGuidePayload)
  if (!parsed) return null

  try {
    const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : ''
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => {
            if (!item || typeof item !== 'object') return null
            const candidate = item as { label?: unknown; outsideCount?: unknown }
            const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
            const outsideCount = typeof candidate.outsideCount === 'number'
              ? candidate.outsideCount
              : Number(candidate.outsideCount)
            if (!label || Number.isNaN(outsideCount)) return null
            return { label, outsideCount }
          })
          .filter((item): item is OpeningGuideItem => item !== null)
          .slice(0, 6)
      : []

    if (!headline || items.length === 0) {
      return null
    }

    return { headline, items }
  } catch {
    return null
  }
}

function parseAIResponse(text: string): ParsedAIResponse {
  const parsed = findJsonValue(text, isAIResponsePayload)
  if (!parsed) {
    return { ok: false, message: '未找到有效 JSON 对象' }
  }

  try {
    const cards = Array.isArray(parsed.cards)
      ? parsed.cards.map(String)
      : typeof parsed.cards === 'string'
        ? splitCardCodes(parsed.cards)
        : typeof parsed.card === 'string'
          ? splitCardCodes(parsed.card)
          : []
    const pass = parsed.pass === true || (typeof parsed.pass === 'string' && parsed.pass.trim().toLowerCase() === 'true')

    if (pass) {
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
  options: OpenRouterRequestOptions = {},
  signal?: AbortSignal,
): Promise<OpenRouterCallResult> {
  const executeRequest = async (requestOptions: OpenRouterRequestOptions): Promise<OpenRouterCallResult> => {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0.3,
      max_tokens: requestOptions.maxTokens ?? 512,
    }

    if (requestOptions.responseFormat) {
      body.response_format = requestOptions.responseFormat.type === 'json_schema'
        ? {
            type: 'json_schema',
            json_schema: {
              name: requestOptions.responseFormat.jsonSchema.name,
              strict: requestOptions.responseFormat.jsonSchema.strict ?? true,
              schema: requestOptions.responseFormat.jsonSchema.schema,
            },
          }
        : { type: 'json_object' }
    }

    if (requestOptions.enableResponseHealing && requestOptions.responseFormat) {
      body.plugins = [{ id: 'response-healing' }]
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Guandan Memory Lab',
    },
      body: JSON.stringify(body),
    signal,
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      if (response.status === 401) throw new AIRequestError('API密钥无效，请检查设置。', false, 'auth', errBody)
      if (response.status === 429) throw new AIRequestError('请求过于频繁，请稍后再试。', false, 'rate-limit', errBody)
      throw new AIRequestError(`AI请求失败 (${response.status}): ${compactText(errBody, 120)}`, true, 'request', errBody)
    }

    const data = await response.json()
    return extractResponseText(data)
  }

  try {
    return await executeRequest(options)
  } catch (error) {
    if (options.responseFormat && shouldRetryWithoutResponseFormat(error)) {
      return executeRequest({
        ...options,
        responseFormat: undefined,
        enableResponseHealing: false,
      })
    }
    throw error
  }
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

export async function requestOpeningGuide(
  config: AIConfig,
  hand: Card[],
  levelRank: number,
  signal?: AbortSignal,
): Promise<OpeningGuideResult> {
  const payload = buildOpeningGuidePayload(hand, levelRank)
  const messages: AIMessage[] = [
    {
      role: 'system',
      content: '你是掼蛋记牌训练助手，不是出牌代理。你的任务是把关键牌场外余量转写成极简牌面引导。只允许复述 outsideFocusCounts 中已经给出的 label 和 outsideCount，不要分析原因，不要补充策略，不要输出 markdown。严格返回 JSON：{"headline":"牌面引导","items":[{"label":"大王","outsideCount":2}]}。',
    },
    {
      role: 'user',
      content: `请根据这份开局牌面数据，直接列出 outsideFocusCounts 中每种关键牌在场外还剩多少张。\n\n${JSON.stringify(payload, null, 2)}`,
    },
  ]

  const response = await callOpenRouter(config, messages, {
    responseFormat: buildOpeningGuideResponseFormat(),
    enableResponseHealing: true,
    maxTokens: 320,
  }, signal)
  const parsed = parseOpeningGuideResponse(response.text)
  if (!parsed) {
    throw new Error('AI 开局引导回复格式无效')
  }
  return parsed
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
        const response = await callOpenRouter(this.config, messages, {
          responseFormat: buildPlayResponseFormat(),
          enableResponseHealing: true,
          maxTokens: 512,
        }, signal)
        const responseText = response.text
        const parsed = parseAIResponse(responseText)

        if (parsed.ok) {
          return parsed.result
        }

        if (isLastAttempt) {
          const responseSnippet = compactText(responseText, 220)
          const finishReasonNote = response.finishReason === 'length'
            ? '；finish_reason=length，响应可能在完整 JSON 前被截断'
            : ''
          const snippetNote = responseSnippet ? `；最近一次返回片段：${responseSnippet}` : ''
          throw new AIRequestError(
            `已自动重试3次，AI仍未返回有效出牌信息：${parsed.message}${finishReasonNote}${snippetNote}`,
            false,
            'response-format',
            responseText,
          )
        }

        messages.push({ role: 'assistant', content: responseText.slice(0, 1200) })
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
