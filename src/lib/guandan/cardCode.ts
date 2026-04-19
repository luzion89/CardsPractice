/**
 * Card encoding/decoding for AI communication.
 *
 * Encoding: rank-number + suit-letter
 *   rank: 1=A, 2-10, 11=J, 12=Q, 13=K
 *   suit: a=♠, b=♥, c=♣, d=♦
 *   jokers: SJ=小王, BJ=大王
 *
 * Examples: "1a"=A♠  "13b"=K♥  "11c"=J♣  "SJ"=小王  "BJ"=大王
 */

import type { Card, Suit } from './types'

const CODE_SUIT_MAP: Record<string, Suit> = {
  a: 'spades',
  b: 'hearts',
  c: 'clubs',
  d: 'diamonds',
}

const SUIT_CODE_MAP: Record<string, string> = {
  spades: 'a',
  hearts: 'b',
  clubs: 'c',
  diamonds: 'd',
}

const SUIT_SYMBOL: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  clubs: '♣',
  diamonds: '♦',
  black: '🃏',
  red: '🃏',
}

const RANK_LABEL: Record<number, string> = {
  14: 'A',
  11: 'J',
  12: 'Q',
  13: 'K',
  16: '小王',
  17: '大王',
}

/** Convert internal Card to AI-readable code string. */
export function cardToCode(card: Card): string {
  if (card.rank === 16) return 'SJ'
  if (card.rank === 17) return 'BJ'
  const suitLetter = SUIT_CODE_MAP[card.suit]
  if (!suitLetter) return '??'
  const rankNum = card.rank === 14 ? 1 : card.rank
  return `${rankNum}${suitLetter}`
}

/** Parse AI code string to { rank, suit } spec. Returns null for invalid codes. */
export function codeToSpec(code: string): { rank: number; suit: Suit } | null {
  const trimmed = code.trim().toUpperCase()
  if (trimmed === 'SJ') return { rank: 16, suit: 'black' }
  if (trimmed === 'BJ') return { rank: 17, suit: 'red' }

  const match = code.trim().match(/^(\d{1,2})([abcd])$/i)
  if (!match) return null

  const rankCode = parseInt(match[1])
  const suitLetter = match[2].toLowerCase()

  if (rankCode < 1 || rankCode > 13) return null
  const suit = CODE_SUIT_MAP[suitLetter]
  if (!suit) return null

  const rank = rankCode === 1 ? 14 : rankCode
  return { rank, suit }
}

/**
 * Resolve an array of AI card codes to specific Card objects from a hand.
 * Handles duplicates (two-deck game) by consuming cards one at a time.
 * Returns null if any code is invalid or the hand doesn't contain the card.
 */
export function resolveCardsFromCodes(codes: string[], hand: Card[]): Card[] | null {
  const available = [...hand]
  const resolved: Card[] = []

  for (const code of codes) {
    const spec = codeToSpec(code)
    if (!spec) return null

    const idx = available.findIndex((c) => c.rank === spec.rank && c.suit === spec.suit)
    if (idx === -1) return null

    resolved.push(available[idx])
    available.splice(idx, 1)
  }

  return resolved
}

/** Convert a hand of cards to code strings. */
export function handToCodes(hand: Card[]): string[] {
  return hand.map(cardToCode)
}

/** Human-readable label for a code string. */
export function codeToReadable(code: string): string {
  const spec = codeToSpec(code)
  if (!spec) return code
  if (spec.rank >= 16) return RANK_LABEL[spec.rank] ?? code
  const rankStr = RANK_LABEL[spec.rank] ?? String(spec.rank === 14 ? 'A' : spec.rank)
  return `${SUIT_SYMBOL[spec.suit] ?? ''}${rankStr}`
}

/** Format a hand for display in AI prompts. */
export function formatHandForAI(hand: Card[]): string {
  return hand.map(cardToCode).join(', ')
}
