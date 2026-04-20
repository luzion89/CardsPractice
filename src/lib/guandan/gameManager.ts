/**
 * Real-time game manager that orchestrates AI-driven Guandan gameplay.
 * Replaces the old pre-generated `generateGame()` approach.
 *
 * Each "next step" triggers an AI call and produces one ReplayAction.
 * The resulting GuandanGame object is compatible with buildReplaySnapshot
 * and the existing challenge system.
 */

import type {
  Card,
  FinishRecord,
  GuandanGame,
  PatternPlay,
  ReplayAction,
  Seat,
  TrickRecord,
} from './types'
import {
  arrangeHandCards,
  canBeat,
  chooseLeadPlay,
  chooseResponsePlay,
  createSeededRng,
  enumerateLeadPatterns,
  nextSeatOf,
  partnerOf,
  SEATS,
  shouldKeepCandidate,
} from './engine'
import { cardToCode, resolveCardsFromCodes } from './cardCode'
import { AIPlayerSession, AIRequestError, type AIConfig, type AIPlayResult, type AILegalActionOption } from './aiService'

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

interface MutableTrickState {
  leader: Seat
  trickIndex: number
  actionIndexes: number[]
  lastWinningSeat: Seat
  lastWinningPlay: PatternPlay
}

/* ------------------------------------------------------------------ */
/*  Helpers (mirrored from engine internals)                           */
/* ------------------------------------------------------------------ */

function randomInt(rng: () => number, max: number) {
  return Math.floor(rng() * max)
}

function shuffle<T>(items: T[], rng: () => number) {
  const clone = [...items]
  for (let i = clone.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = clone[i]
    clone[i] = clone[j]
    clone[j] = t
  }
  return clone
}

const NORMAL_SUITS = ['spades', 'hearts', 'clubs', 'diamonds'] as const
const FACE_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const

function buildDeck(): Card[] {
  const cards: Card[] = []
  for (const deck of [1, 2] as const) {
    for (const suit of NORMAL_SUITS) {
      for (const rank of FACE_RANKS) {
        cards.push({ id: `${deck}-${suit}-${rank}`, rank, suit, deck })
      }
    }
    cards.push({ id: `${deck}-joker-black`, rank: 16, suit: 'black', deck })
    cards.push({ id: `${deck}-joker-red`, rank: 17, suit: 'red', deck })
  }
  return cards
}

function cloneHands(hands: Record<Seat, Card[]>, levelRank: number): Record<Seat, Card[]> {
  return {
    south: arrangeHandCards(hands.south, levelRank),
    east: arrangeHandCards(hands.east, levelRank),
    north: arrangeHandCards(hands.north, levelRank),
    west: arrangeHandCards(hands.west, levelRank),
  }
}

function buildRemainingCounts(hands: Record<Seat, Card[]>): Record<Seat, number> {
  return {
    south: hands.south.length,
    east: hands.east.length,
    north: hands.north.length,
    west: hands.west.length,
  }
}

function removePlayedCards(hand: Card[], play: PatternPlay): Card[] {
  const ids = new Set(play.cards.map((c) => c.id))
  return hand.filter((c) => !ids.has(c.id))
}

function countActiveSeats(hands: Record<Seat, Card[]>): Seat[] {
  return SEATS.filter((s) => hands[s].length > 0)
}

function nextActiveSeat(current: Seat, hands: Record<Seat, Card[]>): Seat | null {
  const active = countActiveSeats(hands)
  if (active.length <= 1) return null
  let cursor = nextSeatOf(current)
  for (let i = 0; i < SEATS.length; i++) {
    if (hands[cursor].length > 0) return cursor
    cursor = nextSeatOf(cursor)
  }
  return null
}

function nextLeaderAfterTrick(winner: Seat, hands: Record<Seat, Card[]>): Seat | null {
  if (countActiveSeats(hands).length <= 1) return null
  if (hands[winner].length > 0) return winner
  const partner = partnerOf(winner)
  if (hands[partner].length > 0) return partner
  return nextActiveSeat(winner, hands)
}

function rankSuitMultiset(cards: Card[]) {
  const counts = new Map<string, number>()
  for (const card of cards) {
    const key = `${card.rank}:${card.suit}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function sameRankSuitMultiset(left: Card[], right: Card[]) {
  if (left.length !== right.length) return false
  const leftCounts = rankSuitMultiset(left)
  const rightCounts = rankSuitMultiset(right)
  if (leftCounts.size !== rightCounts.size) return false

  for (const [key, count] of leftCounts) {
    if ((rightCounts.get(key) ?? 0) !== count) return false
  }
  return true
}

function samePatternCards(left: PatternPlay, right: PatternPlay) {
  if (left.cards.length !== right.cards.length) {
    return false
  }

  const ids = new Set(left.cards.map((card) => card.id))
  return right.cards.every((card) => ids.has(card.id))
}

/**
 * Find a legal PatternPlay from specific card objects.
 * Enumerates patterns over the subset of cards and returns one that
 * uses all of them (and optionally beats the current play).
 */
function findPatternForCards(
  cards: Card[],
  fullHand: Card[],
  levelRank: number,
  currentPlay: PatternPlay | null,
): PatternPlay | null {
  if (cards.length === 0) return null

  // Enumerate all patterns from the FULL hand
  const allPatterns = enumerateLeadPatterns(fullHand, levelRank)
  const cardIds = new Set(cards.map((c) => c.id))

  // Find a pattern that uses exactly our cards
  for (const pat of allPatterns) {
    if (pat.cards.length !== cards.length) continue
    const patIds = new Set(pat.cards.map((c) => c.id))
    if (cardIds.size === patIds.size && [...cardIds].every((id) => patIds.has(id))) {
      if (!currentPlay || canBeat(pat, currentPlay)) return pat
    }
  }

  // If exact ID match fails, try matching by rank+suit multiset (different deck copy)
  for (const pat of allPatterns) {
    if (pat.cards.length !== cards.length) continue
    if (sameRankSuitMultiset(cards, pat.cards)) {
      if (!currentPlay || canBeat(pat, currentPlay)) return pat
    }
  }

  return null
}

function summarizeResponseFormatError(message: string) {
  const normalized = message
    .replace(/^已自动重试3次，AI仍未返回有效出牌信息[:：]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return 'AI连续返回不可解析内容'
  }

  const summary = normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized
  return `AI连续返回不可解析内容：${summary}`
}

const LEAD_OPTION_TYPE_PRIORITY: Record<PatternPlay['type'], number> = {
  single: 0,
  pair: 1,
  triple: 2,
  fullHouse: 3,
  straight: 4,
  tube: 5,
  plate: 6,
  bomb: 7,
  straightFlush: 8,
  jokerBomb: 9,
}

const MAX_AI_ACTION_OPTIONS = 16

function comparePatternsForAiOptions(left: PatternPlay, right: PatternPlay, currentPlay: PatternPlay | null) {
  if (currentPlay) {
    const leftTypePenalty = left.type === currentPlay.type ? 0 : 10000
    const rightTypePenalty = right.type === currentPlay.type ? 0 : 10000

    return leftTypePenalty - rightTypePenalty
      || left.bombTier - right.bombTier
      || left.cards.length - right.cards.length
      || left.primaryValue - right.primaryValue
      || left.wildCount - right.wildCount
      || left.detail.localeCompare(right.detail, 'zh-CN')
  }

  return LEAD_OPTION_TYPE_PRIORITY[left.type] - LEAD_OPTION_TYPE_PRIORITY[right.type]
    || left.bombTier - right.bombTier
    || left.cards.length - right.cards.length
    || left.primaryValue - right.primaryValue
    || left.wildCount - right.wildCount
    || left.detail.localeCompare(right.detail, 'zh-CN')
}

type ResolvedAILegalAction = {
  option: AILegalActionOption
  pattern: PatternPlay | null
}

/* ------------------------------------------------------------------ */
/*  GameManager                                                        */
/* ------------------------------------------------------------------ */

export type GamePhase = 'waiting' | 'playing' | 'thinking' | 'finished'

export interface GameManagerState {
  game: GuandanGame
  phase: GamePhase
  currentSeat: Seat | null
  trickInProgress: boolean
  lastAIReason: string
}

export class GameManager {
  /* Fixed game properties */
  private seed: number
  private levelRank: number
  private startingSeat: Seat
  private initialHands: Record<Seat, Card[]>

  /* Mutable game state */
  private hands: Record<Seat, Card[]>
  private actions: ReplayAction[] = []
  private tricks: TrickRecord[] = []
  private finishOrder: FinishRecord[] = []
  private currentSeat: Seat | null
  private trickState: MutableTrickState | null = null
  private trickIndex = 0
  private phase: GamePhase = 'waiting'
  private lastAIReason = ''

  /* AI sessions */
  private aiSessions: Record<Seat, AIPlayerSession>
  private abortController: AbortController | null = null

  constructor(config: AIConfig, seed = Date.now()) {
    this.seed = seed
    const rng = createSeededRng(seed)
    this.levelRank = FACE_RANKS[randomInt(rng, FACE_RANKS.length)]
    this.startingSeat = SEATS[randomInt(rng, SEATS.length)]

    const deck = shuffle(buildDeck(), rng)
    const rawHands: Record<Seat, Card[]> = {
      south: deck.slice(0, 27),
      east: deck.slice(27, 54),
      north: deck.slice(54, 81),
      west: deck.slice(81, 108),
    }
    this.hands = cloneHands(rawHands, this.levelRank)
    this.initialHands = cloneHands(rawHands, this.levelRank)
    this.currentSeat = this.startingSeat
    this.phase = 'playing'

    // Create independent AI sessions for each player
    this.aiSessions = {
      south: new AIPlayerSession(config, 'south', this.levelRank),
      east: new AIPlayerSession(config, 'east', this.levelRank),
      north: new AIPlayerSession(config, 'north', this.levelRank),
      west: new AIPlayerSession(config, 'west', this.levelRank),
    }
  }

  /* ---- Public API ---- */

  getState(): GameManagerState {
    return {
      game: this.getGame(),
      phase: this.phase,
      currentSeat: this.currentSeat,
      trickInProgress: this.trickState !== null,
      lastAIReason: this.lastAIReason,
    }
  }

  getGame(): GuandanGame {
    return {
      seed: this.seed,
      levelRank: this.levelRank,
      startingSeat: this.startingSeat,
      players: this.initialHands,
      actions: [...this.actions],
      tricks: [...this.tricks],
      finishOrder: [...this.finishOrder],
      createdAt: new Date().toISOString(),
    }
  }

  getCurrentHands(): Record<Seat, Card[]> {
    return {
      south: [...this.hands.south],
      east: [...this.hands.east],
      north: [...this.hands.north],
      west: [...this.hands.west],
    }
  }

  abort(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  isFinished(): boolean {
    return this.phase === 'finished'
  }

  private buildAiLegalActions(
    seat: Seat,
    hand: Card[],
    currentPlay: PatternPlay | null,
    remainingCounts: Record<Seat, number>,
  ) {
    const currentWinningSeat = this.trickState?.lastWinningSeat ?? null
    const urgent = currentPlay && currentWinningSeat
      ? remainingCounts[currentWinningSeat] <= 5 || remainingCounts[partnerOf(seat)] <= 3 || hand.length <= 6
      : false

    const allPatterns = enumerateLeadPatterns(hand, this.levelRank)
      .filter((pattern) => !currentPlay || canBeat(pattern, currentPlay))

    let candidatePatterns = allPatterns.filter((pattern) => shouldKeepCandidate(pattern, hand, this.levelRank, urgent))

    const preferredPattern = !currentPlay
      ? chooseLeadPlay(hand, this.levelRank, seat, remainingCounts) ?? null
      : currentWinningSeat
        ? chooseResponsePlay(hand, this.levelRank, currentPlay, seat, currentWinningSeat, remainingCounts)
        : null

    if (currentPlay && currentWinningSeat && partnerOf(seat) === currentWinningSeat && !preferredPattern) {
      candidatePatterns = []
    } else if (candidatePatterns.length === 0 && !currentPlay) {
      candidatePatterns = allPatterns
    }

    let rankedPatterns = candidatePatterns.toSorted((left, right) => comparePatternsForAiOptions(left, right, currentPlay))

    if (preferredPattern) {
      const preferredIndex = rankedPatterns.findIndex((pattern) => samePatternCards(pattern, preferredPattern))
      if (preferredIndex >= 0) {
        const [preferred] = rankedPatterns.splice(preferredIndex, 1)
        rankedPatterns.unshift(preferred)
      } else {
        rankedPatterns.unshift(preferredPattern)
      }
    }

    if (rankedPatterns.length > MAX_AI_ACTION_OPTIONS) {
      rankedPatterns = rankedPatterns.slice(0, MAX_AI_ACTION_OPTIONS)
    }

    const resolved = new Map<string, ResolvedAILegalAction>()
    const legalActions: AILegalActionOption[] = rankedPatterns.map((pattern, index) => {
      const actionId = `A${String(index + 1).padStart(2, '0')}`
      const option: AILegalActionOption = {
        actionId,
        action: 'play',
        label: pattern.label,
        detail: pattern.detail,
        cards: pattern.cards.map(cardToCode),
      }
      resolved.set(actionId, { option, pattern })
      return option
    })

    if (currentPlay) {
      const passOption: AILegalActionOption = {
        actionId: 'P00',
        action: 'pass',
        label: '过牌',
        detail: '不压当前领先牌型',
        cards: [],
      }
      resolved.set(passOption.actionId, { option: passOption, pattern: null })
      legalActions.push(passOption)
    }

    return { legalActions, resolved }
  }

  /**
   * Advance the game by one step: call the current player's AI,
   * validate the move, and apply it. Returns the new ReplayAction.
   */
  async playNextMove(): Promise<ReplayAction> {
    if (this.phase === 'finished' || !this.currentSeat) {
      throw new Error('游戏已结束')
    }

    const seat = this.currentSeat
    const hand = this.hands[seat]

    if (hand.length === 0) {
      // Seat already finished → skip
      const next = nextActiveSeat(seat, this.hands)
      this.currentSeat = next
      if (!next) {
        this.finalize()
        throw new Error('游戏已结束')
      }
      return this.playNextMove()
    }

    const isLeading = !this.trickState
    const currentPlay = this.trickState?.lastWinningPlay ?? null
    const remaining = buildRemainingCounts(this.hands)
    const { legalActions, resolved } = this.buildAiLegalActions(seat, hand, currentPlay, remaining)

    // Call AI
    this.phase = 'thinking'
    this.abortController = new AbortController()

    let aiResult: AIPlayResult
    try {
      aiResult = await this.aiSessions[seat].requestPlay(
        hand,
        this.actions,
        currentPlay,
        isLeading,
        remaining,
        legalActions,
        this.abortController.signal,
      )
    } catch (err) {
      this.phase = 'playing'
      if (err instanceof AIRequestError && err.kind === 'response-format') {
        return this.applyFallbackDecision(seat, hand, currentPlay, summarizeResponseFormatError(err.message))
      }
      throw err
    }

    this.lastAIReason = aiResult.reason
    this.phase = 'playing'

    const normalizedActionId = aiResult.actionId?.trim()
    if (normalizedActionId && resolved.has(normalizedActionId)) {
      const selected = resolved.get(normalizedActionId)
      if (selected?.pattern) {
        this.lastAIReason = aiResult.reason || `AI选择 ${selected.option.label}`
        return this.applyPlay(seat, selected.pattern)
      }

      this.lastAIReason = aiResult.reason || 'AI选择过牌'
      return this.applyPass(seat)
    }

    if (normalizedActionId && aiResult.cards.length === 0 && !aiResult.pass) {
      return this.applyFallbackDecision(seat, hand, currentPlay, `AI返回了未知 actionId ${normalizedActionId}`)
    }

    // Process the AI's decision
    if (aiResult.pass || aiResult.cards.length === 0) {
      if (isLeading) {
        // Leading player MUST play — fallback to smallest single
        this.lastAIReason = 'AI未给出合法领出，已改用本地最小合法牌'
        return this.applyFallbackLead(seat, hand)
      }
      this.lastAIReason = aiResult.reason || 'AI选择过牌'
      return this.applyPass(seat)
    }

    // Resolve card codes to actual Card objects
    const resolvedCards = resolveCardsFromCodes(aiResult.cards, hand)
    if (!resolvedCards) {
      return this.applyFallbackDecision(seat, hand, currentPlay, 'AI返回的牌面无法匹配当前手牌')
    }

    // Find a matching legal pattern
    const pattern = findPatternForCards(resolvedCards, hand, this.levelRank, currentPlay)
    if (!pattern) {
      return this.applyFallbackDecision(seat, hand, currentPlay, 'AI给出的牌型不合法')
    }

    return this.applyPlay(seat, pattern)
  }

  /* ---- Internal mechanics ---- */

  private applyPlay(seat: Seat, play: PatternPlay): ReplayAction {
    this.hands[seat] = removePlayedCards(this.hands[seat], play)
    this.addFinishIfNeeded(seat)

    if (!this.trickState) {
      // Starting a new trick
      this.trickState = {
        leader: seat,
        trickIndex: this.trickIndex,
        actionIndexes: [],
        lastWinningSeat: seat,
        lastWinningPlay: play,
      }
    } else {
      this.trickState.lastWinningSeat = seat
      this.trickState.lastWinningPlay = play
    }

    const action = this.pushAction(seat, play)
    this.advanceSeat(seat)
    return action
  }

  private applyPass(seat: Seat): ReplayAction {
    const action = this.pushAction(seat, null)
    this.advanceSeat(seat)
    return action
  }

  private applyFallbackLead(seat: Seat, hand: Card[]): ReplayAction {
    // Play the smallest single card
    const patterns = enumerateLeadPatterns(hand, this.levelRank)
    const singles = patterns.filter((p) => p.type === 'single')
    const play = singles.length > 0
      ? singles.sort((a, b) => a.primaryValue - b.primaryValue)[0]
      : patterns[0]

    if (!play) {
      throw new Error(`${seat} 无法出牌，手牌可能为空`)
    }

    return this.applyPlay(seat, play)
  }

  private pickFallbackResponse(hand: Card[], currentPlay: PatternPlay): PatternPlay | null {
    const candidates = enumerateLeadPatterns(hand, this.levelRank)
      .filter((pattern) => canBeat(pattern, currentPlay))

    if (candidates.length === 0) {
      return null
    }

    return candidates.toSorted((left, right) => {
      const leftTypePenalty = left.type === currentPlay.type ? 0 : 10000
      const rightTypePenalty = right.type === currentPlay.type ? 0 : 10000

      return leftTypePenalty - rightTypePenalty
        || left.bombTier - right.bombTier
        || left.cards.length - right.cards.length
        || left.primaryValue - right.primaryValue
        || left.wildCount - right.wildCount
    })[0]
  }

  private applyFallbackDecision(
    seat: Seat,
    hand: Card[],
    currentPlay: PatternPlay | null,
    reason: string,
  ): ReplayAction {
    if (!currentPlay) {
      this.lastAIReason = `${reason}，已改用本地最小合法牌`
      return this.applyFallbackLead(seat, hand)
    }

    const response = this.pickFallbackResponse(hand, currentPlay)
    if (response) {
      this.lastAIReason = `${reason}，已改用本地最小合法应对`
      return this.applyPlay(seat, response)
    }

    this.lastAIReason = `${reason}，本地判断本手无合法可压，按规则过牌`
    return this.applyPass(seat)
  }

  private pushAction(seat: Seat, play: PatternPlay | null): ReplayAction {
    const action: ReplayAction = {
      index: this.actions.length,
      trickIndex: this.trickState?.trickIndex ?? this.trickIndex,
      seat,
      action: play ? 'play' : 'pass',
      play,
      handCountAfter: this.hands[seat].length,
      remainingCounts: buildRemainingCounts(this.hands),
      winningSeat: this.trickState?.lastWinningSeat ?? null,
      note: play ? play.detail : '过牌',
    }

    this.actions.push(action)
    if (this.trickState) {
      this.trickState.actionIndexes.push(action.index)
    }
    return action
  }

  private advanceSeat(seat: Seat): void {
    if (!this.trickState) return

    const next = nextActiveSeat(seat, this.hands)
    const winner = this.trickState.lastWinningSeat
    const winnerGone = this.hands[winner].length === 0
    const firstAfterWinner = winnerGone ? nextActiveSeat(winner, this.hands) : null

    // Trick ends when we circle back to the winner (or all others passed)
    if (!next || next === winner || (winnerGone && next === firstAfterWinner)) {
      // End trick
      this.tricks.push({
        index: this.trickState.trickIndex,
        leader: this.trickState.leader,
        winningSeat: this.trickState.lastWinningSeat,
        actionIndexes: [...this.trickState.actionIndexes],
      })

      const nextLeader = nextLeaderAfterTrick(winner, this.hands)
      this.trickState = null
      this.trickIndex += 1

      if (!nextLeader || countActiveSeats(this.hands).length <= 1) {
        this.finalize()
        this.currentSeat = null
      } else {
        this.currentSeat = nextLeader
      }
    } else {
      this.currentSeat = next
    }
  }

  private addFinishIfNeeded(seat: Seat): void {
    if (this.hands[seat].length > 0) return
    if (this.finishOrder.some((r) => r.seat === seat)) return
    this.finishOrder.push({ seat, place: this.finishOrder.length + 1 })
  }

  private finalize(): void {
    // Add any remaining seats to finish order
    for (const seat of SEATS) {
      if (!this.finishOrder.some((r) => r.seat === seat)) {
        this.finishOrder.push({ seat, place: this.finishOrder.length + 1 })
      }
    }
    this.phase = 'finished'
  }
}
