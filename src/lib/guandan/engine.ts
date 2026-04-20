import type {
  Card,
  Difficulty,
  DifficultyMeta,
  FinishRecord,
  GuandanGame,
  PatternAssignment,
  PatternPlay,
  PatternType,
  ReplayAction,
  ReplaySnapshot,
  Seat,
  Suit,
  TrickRecord,
  VisibleTrick,
} from './types'

interface HandAnalysis {
  allByRank: Map<number, Card[]>
  naturalByRank: Map<number, Card[]>
  sequenceByRank: Map<number, Card[]>
  flushBySuit: Map<Suit, Map<number, Card[]>>
  wilds: Card[]
}

interface MutableTrickState {
  leader: Seat
  trickIndex: number
  actionIndexes: number[]
  lastWinningSeat: Seat
  lastWinningPlay: PatternPlay
}

const NORMAL_SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const FACE_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const
const ORDER_RING = [14, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

export const SEATS: Seat[] = ['south', 'east', 'north', 'west']

export const SEAT_LABELS: Record<Seat, string> = {
  south: '自己',
  east: '下家',
  north: '对家',
  west: '上家',
}

export const TEAM_LABELS: Record<Seat, string> = {
  south: '自己与对家',
  east: '上家与下家',
  north: '自己与对家',
  west: '上家与下家',
}

export const PARTNERS: Record<Seat, Seat> = {
  south: 'north',
  east: 'west',
  north: 'south',
  west: 'east',
}

export const DIFFICULTY_META: Record<Difficulty, DifficultyMeta> = {
  starter: {
    label: '入门',
    reviewDepth: 1,
    summary: '每轮只问王、级牌、A、K与逢人配等大牌计数题。',
  },
  standard: {
    label: '基础',
    reviewDepth: 2,
    summary: '每轮必答，轮换上一轮回忆、大牌计数与最近两轮回忆。',
  },
  expert: {
    label: '进阶',
    reviewDepth: 4,
    summary: '每轮必答，混合延迟回忆、全局计数与搭档局势判断。',
  },
}

export type HandGroupKind = 'straight' | 'tube' | 'plate' | 'triple' | 'pair' | 'single' | 'bomb' | 'wild' | 'joker' | 'jokerBomb'

export interface ArrangedHandGroup {
  key: string
  kind: HandGroupKind
  cards: Card[]
  anchorValue: number
}

const SUIT_SYMBOLS: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
  black: '小王',
  red: '大王',
}

const TYPE_LABELS: Record<PatternType, string> = {
  single: '单张',
  pair: '对子',
  triple: '三同张',
  fullHouse: '三带二',
  straight: '顺子',
  tube: '三连对',
  plate: '钢板',
  bomb: '炸弹',
  straightFlush: '同花顺',
  jokerBomb: '天王炸',
}

const SUIT_ORDER: Record<Suit, number> = {
  clubs: 0,
  diamonds: 1,
  spades: 2,
  hearts: 3,
  black: 4,
  red: 5,
}

const HAND_GROUP_ORDER: Record<HandGroupKind, number> = {
  straight: 10,
  tube: 12,
  plate: 14,
  triple: 20,
  pair: 30,
  single: 40,
  bomb: 50,
  wild: 60,
  joker: 70,
  jokerBomb: 80,
}

export function partnerOf(seat: Seat) {
  return PARTNERS[seat]
}

export function nextSeatOf(seat: Seat) {
  const index = SEATS.indexOf(seat)
  return SEATS[(index + 1) % SEATS.length]
}

export function rankToText(rank: number) {
  if (rank === 11) {
    return 'J'
  }
  if (rank === 12) {
    return 'Q'
  }
  if (rank === 13) {
    return 'K'
  }
  if (rank === 14) {
    return 'A'
  }
  if (rank === 16) {
    return '小王'
  }
  if (rank === 17) {
    return '大王'
  }
  return String(rank)
}

export function rankToCompact(rank: number) {
  if (rank === 10) {
    return '10'
  }
  return rankToText(rank)
}

export function powerValue(rank: number, levelRank: number) {
  if (rank === 16) {
    return 16
  }
  if (rank === 17) {
    return 17
  }
  if (rank === levelRank) {
    return 15
  }
  return rank
}

export function isWildCard(card: Card, levelRank: number) {
  return card.rank === levelRank && card.suit === 'hearts'
}

export function formatCard(card: Card, levelRank: number) {
  if (card.rank === 16 || card.rank === 17) {
    return SUIT_SYMBOLS[card.suit]
  }

  const face = `${SUIT_SYMBOLS[card.suit]}${rankToText(card.rank)}`
  if (isWildCard(card, levelRank)) {
    return `${face}(配)`
  }
  return face
}

export function totalFaceCount(rank: number) {
  if (rank === 16 || rank === 17) {
    return 2
  }
  return 8
}

export function createSeededRng(seed: number) {
  let state = seed % 2147483647
  if (state <= 0) {
    state += 2147483646
  }

  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

function randomInt(rng: () => number, max: number) {
  return Math.floor(rng() * max)
}

function shuffle<T>(items: T[], rng: () => number) {
  const clone = [...items]
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, index + 1)
    const temp = clone[index]
    clone[index] = clone[swapIndex]
    clone[swapIndex] = temp
  }
  return clone
}

function sortCards(cards: Card[], levelRank: number) {
  return [...cards].sort((left, right) => {
    const powerGap = powerValue(left.rank, levelRank) - powerValue(right.rank, levelRank)
    if (powerGap !== 0) {
      return powerGap
    }

    const suitGap = SUIT_ORDER[left.suit] - SUIT_ORDER[right.suit]
    if (suitGap !== 0) {
      return suitGap
    }

    return left.deck - right.deck
  })
}

function extractLongestRun(
  available: Map<number, Card[]>,
  levelRank: number,
  needPerRank: number,
  minLength: number,
) {
  let bestRun: number[] = []
  let currentRun: number[] = []

  for (const rank of FACE_RANKS) {
    if (rank === levelRank) {
      if (currentRun.length >= minLength && currentRun.length > bestRun.length) {
        bestRun = [...currentRun]
      }
      currentRun = []
      continue
    }

    const count = available.get(rank)?.length ?? 0
    if (count >= needPerRank) {
      currentRun.push(rank)
      continue
    }

    if (currentRun.length >= minLength && currentRun.length > bestRun.length) {
      bestRun = [...currentRun]
    }
    currentRun = []
  }

  if (currentRun.length >= minLength && currentRun.length > bestRun.length) {
    bestRun = [...currentRun]
  }

  return bestRun.length >= minLength ? bestRun : null
}

function takeCardsFromRun(available: Map<number, Card[]>, ranks: number[], countPerRank: number) {
  const cards: Card[] = []

  for (const rank of ranks) {
    const bucket = available.get(rank)
    if (!bucket || bucket.length < countPerRank) {
      return null
    }

    const taken = bucket.splice(0, countPerRank)
    cards.push(...taken)
    if (bucket.length === 0) {
      available.delete(rank)
    }
  }

  return cards
}

function pushRunGroups(
  groups: ArrangedHandGroup[],
  available: Map<number, Card[]>,
  levelRank: number,
  kind: 'straight' | 'tube' | 'plate',
  needPerRank: number,
  minLength: number,
) {
  while (true) {
    const run = extractLongestRun(available, levelRank, needPerRank, minLength)
    if (!run) {
      return
    }

    const cards = takeCardsFromRun(available, run, needPerRank)
    if (!cards) {
      return
    }

    groups.push({
      key: `${kind}-${run[0]}-${run.at(-1)}`,
      kind,
      cards: sortCards(cards, levelRank),
      anchorValue: powerValue(run[0], levelRank),
    })
  }
}

export function arrangeHandGroups(hand: Card[], levelRank: number) {
  const available = new Map<number, Card[]>()
  const wilds: Card[] = []
  const jokers: Card[] = []
  const groups: ArrangedHandGroup[] = []

  for (const card of sortCards(hand, levelRank)) {
    if (isWildCard(card, levelRank)) {
      wilds.push(card)
      continue
    }

    if (card.rank >= 16) {
      jokers.push(card)
      continue
    }

    available.set(card.rank, [...(available.get(card.rank) ?? []), card])
  }

  const blackJokers = jokers.filter((card) => card.rank === 16)
  const redJokers = jokers.filter((card) => card.rank === 17)

  if (blackJokers.length === 2 && redJokers.length === 2) {
    groups.push({
      key: 'joker-bomb',
      kind: 'jokerBomb',
      cards: sortCards([...blackJokers, ...redJokers], levelRank),
      anchorValue: 99,
    })
  } else if (jokers.length > 0) {
    groups.push({
      key: 'joker',
      kind: 'joker',
      cards: sortCards(jokers, levelRank),
      anchorValue: 90,
    })
  }

  const bombEntries = [...available.entries()]
    .filter(([, cards]) => cards.length >= 4)
    .toSorted((left, right) => powerValue(left[0], levelRank) - powerValue(right[0], levelRank))

  for (const [rank, cards] of bombEntries) {
    available.delete(rank)
    groups.push({
      key: `bomb-${rank}`,
      kind: 'bomb',
      cards: sortCards(cards, levelRank),
      anchorValue: powerValue(rank, levelRank),
    })
  }

  pushRunGroups(groups, available, levelRank, 'plate', 3, 2)
  pushRunGroups(groups, available, levelRank, 'tube', 2, 3)
  pushRunGroups(groups, available, levelRank, 'straight', 1, 5)

  const leftovers = [...available.entries()].toSorted((left, right) => powerValue(left[0], levelRank) - powerValue(right[0], levelRank))

  for (const [rank, cards] of leftovers) {
    const kind = cards.length === 3 ? 'triple' : cards.length === 2 ? 'pair' : 'single'
    groups.push({
      key: `${kind}-${rank}`,
      kind,
      cards: sortCards(cards, levelRank),
      anchorValue: powerValue(rank, levelRank),
    })
  }

  if (wilds.length > 0) {
    groups.push({
      key: 'wild',
      kind: 'wild',
      cards: sortCards(wilds, levelRank),
      anchorValue: 95,
    })
  }

  return groups.toSorted((left, right) => {
    const orderGap = HAND_GROUP_ORDER[left.kind] - HAND_GROUP_ORDER[right.kind]
    if (orderGap !== 0) {
      return orderGap
    }

    return left.anchorValue - right.anchorValue
  })
}

export function arrangeHandCards(hand: Card[], levelRank: number) {
  return arrangeHandGroups(hand, levelRank).flatMap((group) => group.cards)
}

function displayCategory(card: Card, levelRank: number) {
  if (card.rank >= 16) {
    return 3
  }
  if (card.rank === levelRank) {
    return 2
  }
  return 1
}

function displaySuitPriority(card: Card) {
  switch (card.suit) {
    case 'red':
      return 6
    case 'black':
      return 5
    case 'hearts':
      return 4
    case 'spades':
      return 3
    case 'diamonds':
      return 2
    case 'clubs':
      return 1
    default:
      return 0
  }
}

/**
 * Display-only sorting for visible hand cards.
 * Left-to-right order: jokers -> level cards -> remaining cards (all descending).
 */
export function sortHandForDisplay(hand: Card[], levelRank: number) {
  return [...hand].sort((left, right) => {
    const categoryGap = displayCategory(right, levelRank) - displayCategory(left, levelRank)
    if (categoryGap !== 0) {
      return categoryGap
    }

    const rankGap = right.rank - left.rank
    if (rankGap !== 0) {
      return rankGap
    }

    const suitGap = displaySuitPriority(right) - displaySuitPriority(left)
    if (suitGap !== 0) {
      return suitGap
    }

    return right.deck - left.deck
  })
}

function buildDeck() {
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

function buildWindows(length: number) {
  const windows: number[][] = []
  for (let start = 0; start + length <= ORDER_RING.length; start += 1) {
    windows.push(ORDER_RING.slice(start, start + length))
  }
  return windows
}

const STRAIGHT_WINDOWS = buildWindows(5)
const TUBE_WINDOWS = buildWindows(3)
const PLATE_WINDOWS = buildWindows(2)

function analyzeHand(hand: Card[], levelRank: number): HandAnalysis {
  const allByRank = new Map<number, Card[]>()
  const naturalByRank = new Map<number, Card[]>()
  const sequenceByRank = new Map<number, Card[]>()
  const flushBySuit = new Map<Suit, Map<number, Card[]>>()
  const wilds: Card[] = []

  for (const suit of NORMAL_SUITS) {
    flushBySuit.set(suit, new Map<number, Card[]>())
  }

  for (const card of hand) {
    allByRank.set(card.rank, [...(allByRank.get(card.rank) ?? []), card])

    if (isWildCard(card, levelRank)) {
      wilds.push(card)
      continue
    }

    naturalByRank.set(card.rank, [...(naturalByRank.get(card.rank) ?? []), card])

    if (card.rank <= 14 && card.rank !== levelRank) {
      sequenceByRank.set(card.rank, [...(sequenceByRank.get(card.rank) ?? []), card])

      if (card.suit !== 'black' && card.suit !== 'red') {
        const suitBucket = flushBySuit.get(card.suit)
        suitBucket?.set(card.rank, [...(suitBucket.get(card.rank) ?? []), card])
      }
    }
  }

  return {
    allByRank,
    naturalByRank,
    sequenceByRank,
    flushBySuit,
    wilds: sortCards(wilds, levelRank),
  }
}

function makeAssignmentSummary(assignments: Record<string, PatternAssignment>, levelRank: number) {
  const parts = Object.entries(assignments).map(([, assignment]) => `红桃${rankToText(levelRank)}作${rankToText(assignment.rank)}`)
  return parts.join('，')
}

function createPattern(
  type: PatternType,
  cards: Card[],
  levelRank: number,
  options: {
    label: string
    primaryValue: number
    sequenceIndex?: number | null
    sameRankCount?: number | null
    bombTier?: number
    assignments?: Record<string, PatternAssignment>
    shortLabel?: string
    wildCount?: number
  },
): PatternPlay {
  const assignments = options.assignments ?? {}
  const wildCount = options.wildCount ?? Object.keys(assignments).length
  const detail = wildCount > 0 ? `${options.label} · ${makeAssignmentSummary(assignments, levelRank)}` : options.label

  return {
    type,
    cards: sortCards(cards, levelRank),
    label: options.label,
    detail,
    shortLabel: options.shortLabel ?? TYPE_LABELS[type],
    primaryValue: options.primaryValue,
    sequenceIndex: options.sequenceIndex ?? null,
    sameRankCount: options.sameRankCount ?? null,
    bombTier: options.bombTier ?? 0,
    wildCount,
    assignments,
  }
}

function pickRankCards(
  analysis: HandAnalysis,
  targetRank: number,
  count: number,
  wildOffset = 0,
) {
  if (targetRank === 16 || targetRank === 17) {
    const natural = analysis.naturalByRank.get(targetRank) ?? []
    if (natural.length < count) {
      return null
    }

    return {
      cards: natural.slice(0, count),
      assignments: {} as Record<string, PatternAssignment>,
      wildUsed: 0,
    }
  }

  const natural = analysis.naturalByRank.get(targetRank) ?? []
  const naturalCards = natural.slice(0, Math.min(count, natural.length))
  const neededWilds = count - naturalCards.length

  if (neededWilds < 0 || wildOffset + neededWilds > analysis.wilds.length) {
    return null
  }

  const wildCards = analysis.wilds.slice(wildOffset, wildOffset + neededWilds)
  const assignments: Record<string, PatternAssignment> = {}
  for (const wildCard of wildCards) {
    assignments[wildCard.id] = { rank: targetRank }
  }

  return {
    cards: [...naturalCards, ...wildCards],
    assignments,
    wildUsed: neededWilds,
  }
}

function createSinglePatterns(analysis: HandAnalysis, levelRank: number) {
  const patterns: PatternPlay[] = []

  for (const rank of FACE_RANKS) {
    const cards = analysis.allByRank.get(rank)
    if (!cards || cards.length === 0) {
      continue
    }

    patterns.push(
      createPattern('single', [cards[0]], levelRank, {
        label: `${TYPE_LABELS.single} ${rankToText(rank)}`,
        primaryValue: powerValue(rank, levelRank),
      }),
    )
  }

  for (const jokerRank of [16, 17]) {
    const cards = analysis.allByRank.get(jokerRank)
    if (!cards || cards.length === 0) {
      continue
    }

    patterns.push(
      createPattern('single', [cards[0]], levelRank, {
        label: `${TYPE_LABELS.single} ${rankToText(jokerRank)}`,
        primaryValue: powerValue(jokerRank, levelRank),
      }),
    )
  }

  return patterns
}

function createSameRankPatterns(analysis: HandAnalysis, levelRank: number, count: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10) {
  const patterns: PatternPlay[] = []
  const type: PatternType = count >= 4 ? 'bomb' : count === 3 ? 'triple' : 'pair'

  for (const rank of FACE_RANKS) {
    const naturalCount = analysis.naturalByRank.get(rank)?.length ?? 0
    if (naturalCount + analysis.wilds.length < count) {
      continue
    }

    const pick = pickRankCards(analysis, rank, count)
    if (!pick) {
      continue
    }

    const label =
      type === 'pair'
        ? `${TYPE_LABELS.pair} ${rankToText(rank)}`
        : type === 'triple'
          ? `${TYPE_LABELS.triple} ${rankToText(rank)}`
          : `${TYPE_LABELS.bomb} ${count}张${rankToText(rank)}`

    patterns.push(
      createPattern(type, pick.cards, levelRank, {
        label,
        primaryValue: powerValue(rank, levelRank),
        sameRankCount: count,
        bombTier: count >= 6 ? 3 : 1,
        assignments: pick.assignments,
      }),
    )
  }

  if (count === 2) {
    for (const jokerRank of [16, 17]) {
      const pick = pickRankCards(analysis, jokerRank, count)
      if (!pick) {
        continue
      }

      patterns.push(
        createPattern('pair', pick.cards, levelRank, {
          label: `${TYPE_LABELS.pair} ${rankToText(jokerRank)}`,
          primaryValue: powerValue(jokerRank, levelRank),
        }),
      )
    }
  }

  return patterns
}

function createFullHousePatterns(analysis: HandAnalysis, levelRank: number) {
  const patterns: PatternPlay[] = []
  const pairTargets = [...FACE_RANKS, 16, 17]

  for (const tripleRank of FACE_RANKS) {
    const tripleNatural = analysis.naturalByRank.get(tripleRank)?.length ?? 0
    if (tripleNatural + analysis.wilds.length < 3) {
      continue
    }

    for (const pairRank of pairTargets) {
      if (pairRank === tripleRank) {
        continue
      }

      const tripleNeed = Math.max(0, 3 - tripleNatural)
      const pairNatural = analysis.naturalByRank.get(pairRank)?.length ?? 0
      const pairNeed = Math.max(0, 2 - pairNatural)

      if (pairRank >= 16 && pairNeed > 0) {
        continue
      }

      if (tripleNeed + pairNeed > analysis.wilds.length) {
        continue
      }

      const triplePick = pickRankCards(analysis, tripleRank, 3, 0)
      if (!triplePick) {
        continue
      }

      const pairPick = pickRankCards(analysis, pairRank, 2, triplePick.wildUsed)
      if (!pairPick) {
        continue
      }

      patterns.push(
        createPattern('fullHouse', [...triplePick.cards, ...pairPick.cards], levelRank, {
          label: `${TYPE_LABELS.fullHouse} ${rankToText(tripleRank)}带${rankToText(pairRank)}`,
          primaryValue: powerValue(tripleRank, levelRank),
          assignments: {
            ...triplePick.assignments,
            ...pairPick.assignments,
          },
        }),
      )
    }
  }

  return patterns
}

function createWindowPatterns(
  analysis: HandAnalysis,
  levelRank: number,
  type: 'straight' | 'tube' | 'plate',
  windows: number[][],
  needPerRank: number,
) {
  const patterns: PatternPlay[] = []

  windows.forEach((windowRanks, sequenceIndex) => {
    let wildOffset = 0
    const cards: Card[] = []
    const assignments: Record<string, PatternAssignment> = {}
    let valid = true

    for (const rank of windowRanks) {
      const naturalCards = analysis.sequenceByRank.get(rank) ?? []
      const takenNatural = naturalCards.slice(0, Math.min(needPerRank, naturalCards.length))
      cards.push(...takenNatural)

      const missing = needPerRank - takenNatural.length
      if (missing === 0) {
        continue
      }

      const wildCards = analysis.wilds.slice(wildOffset, wildOffset + missing)
      if (wildCards.length < missing) {
        valid = false
        break
      }

      for (const wildCard of wildCards) {
        assignments[wildCard.id] = { rank }
      }

      cards.push(...wildCards)
      wildOffset += missing
    }

    if (!valid) {
      return
    }

    const sequenceText = windowRanks.map((rank) => rankToCompact(rank)).join('')
    patterns.push(
      createPattern(type, cards, levelRank, {
        label: `${TYPE_LABELS[type]} ${sequenceText}`,
        primaryValue: sequenceIndex,
        sequenceIndex,
        assignments,
      }),
    )
  })

  return patterns
}

function createStraightFlushPatterns(analysis: HandAnalysis, levelRank: number) {
  const patterns: PatternPlay[] = []

  for (const suit of NORMAL_SUITS) {
    const suitBucket = analysis.flushBySuit.get(suit)
    if (!suitBucket) {
      continue
    }

    STRAIGHT_WINDOWS.forEach((windowRanks, sequenceIndex) => {
      const cards = windowRanks.map((rank) => suitBucket.get(rank)?.[0]).filter(Boolean) as Card[]
      if (cards.length !== windowRanks.length) {
        return
      }

      const sequenceText = windowRanks.map((rank) => rankToCompact(rank)).join('')
      patterns.push(
        createPattern('straightFlush', cards, levelRank, {
          label: `${TYPE_LABELS.straightFlush} ${SUIT_SYMBOLS[suit]}${sequenceText}`,
          primaryValue: sequenceIndex,
          sequenceIndex,
          bombTier: 2,
          wildCount: 0,
        }),
      )
    })
  }

  return patterns
}

function createJokerBombPattern(analysis: HandAnalysis, levelRank: number) {
  const blackJokers = analysis.naturalByRank.get(16) ?? []
  const redJokers = analysis.naturalByRank.get(17) ?? []
  if (blackJokers.length < 2 || redJokers.length < 2) {
    return []
  }

  return [
    createPattern('jokerBomb', [...blackJokers.slice(0, 2), ...redJokers.slice(0, 2)], levelRank, {
      label: TYPE_LABELS.jokerBomb,
      primaryValue: 99,
      sameRankCount: 4,
      bombTier: 4,
      wildCount: 0,
    }),
  ]
}

function dedupePatterns(patterns: PatternPlay[]) {
  const seen = new Set<string>()
  return patterns.filter((pattern) => {
    const signature = [
      pattern.type,
      pattern.primaryValue,
      pattern.sequenceIndex ?? 'n',
      pattern.sameRankCount ?? 'n',
      pattern.cards.length,
      pattern.bombTier,
    ].join(':')
    if (seen.has(signature)) {
      return false
    }
    seen.add(signature)
    return true
  })
}

export function enumerateLeadPatterns(hand: Card[], levelRank: number) {
  const analysis = analyzeHand(hand, levelRank)
  const patterns = [
    ...createSinglePatterns(analysis, levelRank),
    ...createSameRankPatterns(analysis, levelRank, 2),
    ...createSameRankPatterns(analysis, levelRank, 3),
    ...createFullHousePatterns(analysis, levelRank),
    ...createWindowPatterns(analysis, levelRank, 'straight', STRAIGHT_WINDOWS, 1),
    ...createWindowPatterns(analysis, levelRank, 'tube', TUBE_WINDOWS, 2),
    ...createWindowPatterns(analysis, levelRank, 'plate', PLATE_WINDOWS, 3),
    ...createSameRankPatterns(analysis, levelRank, 4),
    ...createSameRankPatterns(analysis, levelRank, 5),
    ...createStraightFlushPatterns(analysis, levelRank),
    ...createSameRankPatterns(analysis, levelRank, 6),
    ...createSameRankPatterns(analysis, levelRank, 7),
    ...createSameRankPatterns(analysis, levelRank, 8),
    ...createSameRankPatterns(analysis, levelRank, 9),
    ...createSameRankPatterns(analysis, levelRank, 10),
    ...createJokerBombPattern(analysis, levelRank),
  ]

  return dedupePatterns(patterns)
}

export function isBombPattern(pattern: PatternPlay) {
  return pattern.type === 'bomb' || pattern.type === 'straightFlush' || pattern.type === 'jokerBomb'
}

function compareBombs(left: PatternPlay, right: PatternPlay) {
  if (left.bombTier !== right.bombTier) {
    return left.bombTier - right.bombTier
  }

  if (left.type === 'bomb' && right.type === 'bomb') {
    const countGap = (left.sameRankCount ?? 0) - (right.sameRankCount ?? 0)
    if (countGap !== 0) {
      return countGap
    }
  }

  if (left.sequenceIndex !== null && right.sequenceIndex !== null && left.sequenceIndex !== right.sequenceIndex) {
    return left.sequenceIndex - right.sequenceIndex
  }

  return left.primaryValue - right.primaryValue
}

export function canBeat(candidate: PatternPlay, target: PatternPlay) {
  const candidateBomb = isBombPattern(candidate)
  const targetBomb = isBombPattern(target)

  if (!targetBomb && candidateBomb) {
    return true
  }

  if (targetBomb && !candidateBomb) {
    return false
  }

  if (candidateBomb && targetBomb) {
    return compareBombs(candidate, target) > 0
  }

  if (candidate.type !== target.type) {
    return false
  }

  if (candidate.sequenceIndex !== null && target.sequenceIndex !== null) {
    return candidate.sequenceIndex > target.sequenceIndex
  }

  return candidate.primaryValue > target.primaryValue
}

function removePlayedCards(hand: Card[], play: PatternPlay) {
  const removeIds = new Set(play.cards.map((card) => card.id))
  return hand.filter((card) => !removeIds.has(card.id))
}

function countActiveSeats(hands: Record<Seat, Card[]>) {
  return SEATS.filter((seat) => hands[seat].length > 0)
}

function nextActiveSeat(current: Seat, hands: Record<Seat, Card[]>) {
  const activeSeats = countActiveSeats(hands)
  if (activeSeats.length <= 1) {
    return null
  }

  let cursor = nextSeatOf(current)
  for (let attempts = 0; attempts < SEATS.length; attempts += 1) {
    if (hands[cursor].length > 0) {
      return cursor
    }
    cursor = nextSeatOf(cursor)
  }

  return null
}

function nextLeaderAfterTrick(lastWinningSeat: Seat, hands: Record<Seat, Card[]>) {
  const activeSeats = countActiveSeats(hands)
  if (activeSeats.length <= 1) {
    return null
  }

  // Winner still has cards → they lead next trick
  if (hands[lastWinningSeat].length > 0) {
    return lastWinningSeat
  }

  // Winner finished → partner leads
  const partnerSeat = partnerOf(lastWinningSeat)
  if (hands[partnerSeat].length > 0) {
    return partnerSeat
  }

  // Both finished → next active seat
  return nextActiveSeat(lastWinningSeat, hands)
}

function buildRemainingCounts(hands: Record<Seat, Card[]>) {
  return {
    south: hands.south.length,
    east: hands.east.length,
    north: hands.north.length,
    west: hands.west.length,
  }
}

function estimateHandCount(hand: Card[], levelRank: number) {
  // Greedy estimate: how many moves to empty the hand
  // This counts natural groupings (pairs, triples, straights etc.)
  const analysis = analyzeHand(hand, levelRank)
  let remaining = hand.length
  let moves = 0

  // Count bombs (4+ of same rank) — these are efficient
  for (const [, cards] of analysis.naturalByRank) {
    if (cards.length >= 4) {
      remaining -= cards.length
      moves += 1
    }
  }

  // Count triples (full houses use 5 cards in 1 move)
  const triples: number[] = []
  const pairs: number[] = []
  const singles: number[] = []

  for (const [rank, cards] of analysis.naturalByRank) {
    if (cards.length >= 4) continue // already counted as bomb
    if (cards.length === 3) triples.push(rank)
    else if (cards.length === 2) pairs.push(rank)
    else if (cards.length === 1) singles.push(rank)
  }

  // Pair triples with pairs for full houses
  const fullHouses = Math.min(triples.length, pairs.length)
  moves += fullHouses
  remaining -= fullHouses * 5
  const leftoverTriples = triples.length - fullHouses
  moves += leftoverTriples
  remaining -= leftoverTriples * 3
  const leftoverPairs = pairs.length - fullHouses
  moves += leftoverPairs
  remaining -= leftoverPairs * 2
  // Remaining singles + wilds
  moves += Math.max(0, remaining)

  return moves
}

function comboPreservationPenalty(play: PatternPlay, hand: Card[], levelRank: number) {
  const analysis = analyzeHand(hand, levelRank)
  const naturalUsage = new Map<number, number>()

  for (const card of play.cards) {
    if (card.rank >= 16 || isWildCard(card, levelRank)) {
      continue
    }

    naturalUsage.set(card.rank, (naturalUsage.get(card.rank) ?? 0) + 1)
  }

  let penalty = 0

  for (const [rank] of naturalUsage) {
    const naturalCount = analysis.naturalByRank.get(rank)?.length ?? 0

    if (naturalCount >= 4) {
      const keepsWholeBomb =
        play.type === 'bomb' &&
        play.primaryValue === powerValue(rank, levelRank) &&
        (play.sameRankCount ?? 0) === naturalCount

      if (!keepsWholeBomb) {
        penalty += 90
      }
      continue
    }

    if (naturalCount === 3 && play.type !== 'triple' && play.type !== 'fullHouse' && play.type !== 'plate') {
      penalty += 28
      continue
    }

    if (naturalCount === 2 && play.type !== 'pair' && play.type !== 'tube' && play.type !== 'fullHouse') {
      penalty += 12
      continue
    }

    if (play.type === 'straight' && naturalCount >= 2) {
      penalty += 10
    }
  }

  if (play.wildCount > 0) {
    penalty += play.wildCount * 10

    if (play.type === 'straight' || play.type === 'tube' || play.type === 'plate') {
      penalty += 28
    } else if (play.type === 'fullHouse') {
      penalty += 18
    } else if (isBombPattern(play)) {
      penalty += 22
    }
  }

  if (hand.length >= 18 && (play.type === 'straight' || play.type === 'tube' || play.type === 'plate' || play.type === 'fullHouse')) {
    penalty += 18
  }

  if (hand.length >= 16 && play.cards.length >= 5) {
    penalty += 8
  }

  return penalty
}

function playImprovesTempo(play: PatternPlay, hand: Card[], levelRank: number) {
  const afterHand = hand.filter((card) => !play.cards.some((used) => used.id === card.id))
  return estimateHandCount(afterHand, levelRank) < estimateHandCount(hand, levelRank)
}

function breaksNaturalBomb(play: PatternPlay, hand: Card[], levelRank: number) {
  const naturalCounts = new Map<number, number>()
  for (const card of hand) {
    if (card.rank >= 16 || isWildCard(card, levelRank)) {
      continue
    }
    naturalCounts.set(card.rank, (naturalCounts.get(card.rank) ?? 0) + 1)
  }

  const usedRanks = Array.from(
    new Set(play.cards.filter((card) => card.rank < 16 && !isWildCard(card, levelRank)).map((card) => card.rank)),
  )

  return usedRanks.some((rank) => {
    const naturalCount = naturalCounts.get(rank) ?? 0
    return naturalCount >= 4 && !(play.type === 'bomb' && play.sameRankCount === naturalCount && usedRanks.length === 1)
  })
}

function isComplexPattern(play: PatternPlay) {
  return play.type === 'straight' || play.type === 'tube' || play.type === 'plate' || play.type === 'fullHouse'
}

export function shouldKeepCandidate(play: PatternPlay, hand: Card[], levelRank: number, urgent: boolean) {
  if (play.cards.length === hand.length) {
    return true
  }

  if (breaksNaturalBomb(play, hand, levelRank)) {
    return urgent && hand.length <= 6
  }

  const preservePenalty = comboPreservationPenalty(play, hand, levelRank)
  if (preservePenalty >= 80) {
    return urgent || hand.length <= 5
  }

  if (!urgent && preservePenalty >= 32 && hand.length >= 10) {
    return false
  }

  if (!urgent && play.wildCount > 0 && isComplexPattern(play) && hand.length > 8) {
    return false
  }

  return true
}

function scoreLead(play: PatternPlay, hand: Card[], levelRank: number) {
  const handSize = hand.length
  // Instant-win: play all remaining cards
  if (play.cards.length === handSize) {
    return -9999
  }

  // Estimate how the hand looks after this play
  const afterHand = hand.filter((c) => !play.cards.some((p) => p.id === c.id))
  const afterMoves = estimateHandCount(afterHand, levelRank)
  const currentMoves = estimateHandCount(hand, levelRank)

  let score = comboPreservationPenalty(play, hand, levelRank)

  // Prefer plays that reduce move count efficiently
  score += (currentMoves - afterMoves) * -30

  // Prefer small-value leads to keep big cards for control
  score += play.primaryValue * 1.5

  // Penalize using wilds (save them)
  score += play.wildCount * 12

  // Prefer singles and pairs first (get rid of loose cards)
  if (play.type === 'single') {
    score -= 15
  }
  if (play.type === 'pair') {
    score -= 8
  }
  if (play.type === 'triple') {
    score -= 4
  }

  // Penalize breaking combos (straights, tubes, plates)
  if (play.type === 'straight' || play.type === 'tube' || play.type === 'plate') {
    score += handSize > 10 ? 10 : -4
  }
  if (play.type === 'fullHouse') {
    score += handSize > 10 ? 8 : -2
  }

  // Strongly preserve bombs for later
  if (isBombPattern(play)) {
    score += handSize > 6 ? 96 : 18
  }

  // If hand is small, start playing aggressively
  if (handSize <= 5) {
    score -= play.cards.length * 6 // prefer multi-card plays to finish faster
  }

  if (afterMoves <= 2) {
    score -= 12
  }

  return score
}

function scoreResponse(
  play: PatternPlay,
  current: PatternPlay,
  hand: Card[],
  levelRank: number,
  enemyDanger: boolean,
  partnerClose: boolean,
  teammateAhead: boolean,
) {
  const handSize = hand.length
  // Instant-win
  if (play.cards.length === handSize) {
    return -9999
  }

  const preservePenalty = comboPreservationPenalty(play, hand, levelRank)
  let score = preservePenalty

  // Base: prefer smaller plays to beat the current
  score += play.primaryValue * 0.8

  // Penalize using wilds
  score += play.wildCount * 8

  // If it's a bomb to beat non-bomb, heavy cost (save bombs)
  if (isBombPattern(play) && !isBombPattern(current)) {
    if (enemyDanger) {
      score += 15 // worth it when enemy is close to finishing
    } else if (partnerClose) {
      score += 10 // help partner
    } else {
      score += 60 // expensive otherwise
    }
  }

  // Prefer the minimum card to beat
  const overshoot = play.primaryValue - current.primaryValue
  score += overshoot * 0.5

  // If partner is close to finishing, be more aggressive about getting control
  if (partnerClose && !teammateAhead) {
    score -= 8
  }

  // If hand count improves after playing, it's worth it
  const afterHand = hand.filter((c) => !play.cards.some((p) => p.id === c.id))
  const movesBefore = estimateHandCount(hand, levelRank)
  const movesAfter = estimateHandCount(afterHand, levelRank)
  if (movesAfter < movesBefore) {
    score -= (movesBefore - movesAfter) * 5
  }

  return score
}

export function chooseLeadPlay(
  hand: Card[],
  levelRank: number,
  actor: Seat,
  remainingCounts: Record<Seat, number>,
) {
  const rawCandidates = enumerateLeadPatterns(hand, levelRank)
  const candidates = rawCandidates.filter((play) => shouldKeepCandidate(play, hand, levelRank, false))
  if (candidates.length === 0) return undefined

  const partnerSeat = partnerOf(actor)
  const partnerClose = remainingCounts[partnerSeat] <= 4 && remainingCounts[partnerSeat] > 0

  // If partner is close to finishing, try to lead small cards the partner can beat
  // (feed partner small singles so they can play their remaining cards)
  if (partnerClose) {
    const smallSingles = candidates
      .filter((p) => p.type === 'single' && p.primaryValue <= 10 && comboPreservationPenalty(p, hand, levelRank) <= 10)
      .toSorted((a, b) => a.primaryValue - b.primaryValue)
    if (smallSingles.length > 0) {
      return smallSingles[0]
    }
    const smallPairs = candidates
      .filter((p) => p.type === 'pair' && p.primaryValue <= 10 && comboPreservationPenalty(p, hand, levelRank) <= 12)
      .toSorted((a, b) => a.primaryValue - b.primaryValue)
    if (smallPairs.length > 0) {
      return smallPairs[0]
    }
  }

  if (hand.length >= 18) {
    const safeOpeners = candidates.filter(
      (play) =>
        (play.type === 'single' || play.type === 'pair' || play.type === 'triple') &&
        comboPreservationPenalty(play, hand, levelRank) <= 14,
    )
    if (safeOpeners.length > 0) {
      return safeOpeners.toSorted(
        (left, right) => scoreLead(left, hand, levelRank) - scoreLead(right, hand, levelRank),
      )[0]
    }
  }

  return candidates.toSorted(
    (left, right) => scoreLead(left, hand, levelRank) - scoreLead(right, hand, levelRank),
  )[0]
}

export function chooseResponsePlay(
  hand: Card[],
  levelRank: number,
  current: PatternPlay,
  actor: Seat,
  winningSeat: Seat,
  remainingCounts: Record<Seat, number>,
) {
  const urgent = remainingCounts[winningSeat] <= 5 || remainingCounts[partnerOf(actor)] <= 3 || hand.length <= 6
  const candidates = enumerateLeadPatterns(hand, levelRank)
    .filter((pattern) => canBeat(pattern, current))
    .filter((play) => shouldKeepCandidate(play, hand, levelRank, urgent))
  if (candidates.length === 0) {
    return null
  }

  const teammateAhead = partnerOf(actor) === winningSeat
  const enemyDanger = remainingCounts[winningSeat] <= 5
  const partnerClose = remainingCounts[partnerOf(actor)] <= 3

  const sameTypeCandidates = candidates.filter((pattern) => !isBombPattern(pattern))
  const bombCandidates = candidates.filter((pattern) => isBombPattern(pattern))

  const scoreCandidate = (play: PatternPlay) =>
    scoreResponse(play, current, hand, levelRank, enemyDanger, partnerClose, teammateAhead)

  const chooseBest = (plays: PatternPlay[]) =>
    plays
      .map((play) => ({
        play,
        score: scoreCandidate(play),
      }))
      .toSorted((left, right) => left.score - right.score)[0]

  // Teammate is winning the trick — only play if we can finish
  if (teammateAhead) {
    const finishingPlay = candidates.find((pattern) => pattern.cards.length === hand.length)
    return finishingPlay ?? null
  }

  // Try same-type plays first
  if (sameTypeCandidates.length > 0) {
    const bestSameType = chooseBest(sameTypeCandidates)
    if (!bestSameType) {
      return null
    }

    // Always play if: enemy is dangerous, we're close to finishing, or cost is low
    if (enemyDanger || partnerClose || hand.length <= 8 || bestSameType.play.cards.length >= 5) {
      return bestSameType.play
    }

    // Play if the overshoot is small (don't waste big cards)
    if (bestSameType.play.primaryValue - current.primaryValue <= 2 && bestSameType.score <= 34) {
      return bestSameType.play
    }

    // If hand count improves, worth it
    if (playImprovesTempo(bestSameType.play, hand, levelRank) && bestSameType.score <= 40) {
      return bestSameType.play
    }

    if (bestSameType.score <= 18) {
      return bestSameType.play
    }
  }

  // Try bombs
  if (bombCandidates.length > 0) {
    const bestBomb = chooseBest(bombCandidates)
    if (!bestBomb) {
      return null
    }

    if (enemyDanger || partnerClose || hand.length <= 6 || bestBomb.play.cards.length === hand.length) {
      return bestBomb.play
    }

    if (isBombPattern(current) && bestBomb.score <= 56) {
      return bestBomb.play
    }
  }

  return null
}

function cloneHands(hands: Record<Seat, Card[]>, levelRank: number) {
  return {
    south: arrangeHandCards(hands.south, levelRank),
    east: arrangeHandCards(hands.east, levelRank),
    north: arrangeHandCards(hands.north, levelRank),
    west: arrangeHandCards(hands.west, levelRank),
  }
}

export function faceLabelForTraining(rank: number, levelRank: number) {
  if (rank === levelRank) {
    return `级牌 ${rankToText(rank)}`
  }
  if (rank === 16) {
    return '小王'
  }
  if (rank === 17) {
    return '大王'
  }
  return `${rankToText(rank)}`
}

export function remainingFaceCounts(game: GuandanGame, stepIndex: number) {
  const counts = new Map<number, number>()
  for (const rank of FACE_RANKS) {
    counts.set(rank, 8)
  }
  counts.set(16, 2)
  counts.set(17, 2)

  const visibleActions = game.actions.slice(0, stepIndex)
  for (const action of visibleActions) {
    if (!action.play) {
      continue
    }
    for (const card of action.play.cards) {
      counts.set(card.rank, (counts.get(card.rank) ?? 0) - 1)
    }
  }

  const heartLevelLeft = game.players.south
    .concat(game.players.east, game.players.north, game.players.west)
    .filter((card) => isWildCard(card, game.levelRank)).length -
    visibleActions
      .flatMap((action) => action.play?.cards ?? [])
      .filter((card) => isWildCard(card, game.levelRank)).length

  return {
    byRank: counts,
    wildsLeft: heartLevelLeft,
  }
}

export function buildReplaySnapshot(game: GuandanGame, stepIndex: number): ReplaySnapshot {
  const clampedStep = Math.max(0, Math.min(stepIndex, game.actions.length))
  const visibleActions = game.actions.slice(0, clampedStep)
  const trickMap = new Map<number, VisibleTrick>()

  for (const action of visibleActions) {
    const existing = trickMap.get(action.trickIndex)
    if (existing) {
      existing.actions.push(action)
      existing.winningSeat = action.winningSeat
      continue
    }

    trickMap.set(action.trickIndex, {
      index: action.trickIndex,
      leader: action.seat,
      winningSeat: action.winningSeat,
      actions: [action],
      complete: false,
    })
  }

  const visibleTricks = [...trickMap.values()].map((trick) => {
    const record = game.tricks.find((item) => item.index === trick.index)
    return {
      ...trick,
      complete: record ? trick.actions.length === record.actionIndexes.length : false,
    }
  })

  const completedTricks = visibleTricks.filter((trick) => trick.complete)
  const currentTrick = [...visibleTricks].reverse().find((trick) => !trick.complete) ?? null
  const lastAction = visibleActions.at(-1) ?? null
  const remainingCounts = lastAction?.remainingCounts ?? {
    south: 27,
    east: 27,
    north: 27,
    west: 27,
  }

  return {
    stepIndex: clampedStep,
    visibleActions,
    visibleTricks,
    completedTricks,
    currentTrick,
    remainingCounts,
    nextSeat:
      clampedStep < game.actions.length
        ? game.actions[clampedStep].seat
        : game.actions.length === 0
          ? game.startingSeat
          : null,
    lastAction,
    isComplete: game.actions.length > 0 && clampedStep >= game.actions.length,
    finishOrder: game.finishOrder,
  }
}

function addFinishIfNeeded(
  finishOrder: FinishRecord[],
  seat: Seat,
  hands: Record<Seat, Card[]>,
) {
  if (hands[seat].length > 0) {
    return
  }
  if (finishOrder.some((item) => item.seat === seat)) {
    return
  }

  finishOrder.push({ seat, place: finishOrder.length + 1 })
}

function finalizeLastSeat(finishOrder: FinishRecord[]) {
  const leftovers = SEATS.filter((seat) => !finishOrder.some((item) => item.seat === seat))
  leftovers.forEach((seat) => {
    finishOrder.push({ seat, place: finishOrder.length + 1 })
  })
}

function buildHandsFromDeck(deck: Card[], levelRank: number) {
  return cloneHands(
    {
      south: deck.slice(0, 27),
      east: deck.slice(27, 54),
      north: deck.slice(54, 81),
      west: deck.slice(81, 108),
    },
    levelRank,
  )
}

function pushAction(
  actions: ReplayAction[],
  trickState: MutableTrickState,
  seat: Seat,
  play: PatternPlay | null,
  hands: Record<Seat, Card[]>,
) {
  const action: ReplayAction = {
    index: actions.length,
    trickIndex: trickState.trickIndex,
    seat,
    action: play ? 'play' : 'pass',
    play,
    handCountAfter: hands[seat].length,
    remainingCounts: buildRemainingCounts(hands),
    winningSeat: trickState.lastWinningSeat,
    note: play ? play.detail : '过牌',
  }

  actions.push(action)
  trickState.actionIndexes.push(action.index)
}

export function generateGame(seed = Date.now()) {
  const rng = createSeededRng(seed)
  const levelRank = FACE_RANKS[randomInt(rng, FACE_RANKS.length)]
  const startingSeat = SEATS[randomInt(rng, SEATS.length)]
  const hands = buildHandsFromDeck(shuffle(buildDeck(), rng), levelRank)
  const players = cloneHands(hands, levelRank)
  const actions: ReplayAction[] = []
  const tricks: TrickRecord[] = []
  const finishOrder: FinishRecord[] = []

  let currentSeat: Seat | null = startingSeat
  let trickIndex = 0
  let trickState: MutableTrickState | null = null
  const MAX_ACTIONS = 800 // safety guard: 108 cards, ≤4 actions per card max

  while (currentSeat && actions.length < MAX_ACTIONS) {
    const activeSeats = countActiveSeats(hands)
    if (activeSeats.length <= 1) {
      break
    }

    if (!trickState) {
      const remainingCounts: Record<Seat, number> = {
        south: hands.south.length,
        east: hands.east.length,
        north: hands.north.length,
        west: hands.west.length,
      }
      const leadPlay = chooseLeadPlay(hands[currentSeat], levelRank, currentSeat, remainingCounts)
      if (!leadPlay) {
        break
      }

      hands[currentSeat] = removePlayedCards(hands[currentSeat], leadPlay)
      addFinishIfNeeded(finishOrder, currentSeat, hands)

      trickState = {
        leader: currentSeat,
        trickIndex,
        actionIndexes: [],
        lastWinningSeat: currentSeat,
        lastWinningPlay: leadPlay,
      }

      pushAction(actions, trickState, currentSeat, leadPlay, hands)
      currentSeat = nextActiveSeat(currentSeat, hands)
      continue
    }

    const responsePlay = chooseResponsePlay(
      hands[currentSeat],
      levelRank,
      trickState.lastWinningPlay,
      currentSeat,
      trickState.lastWinningSeat,
      buildRemainingCounts(hands),
    )

    if (responsePlay) {
      hands[currentSeat] = removePlayedCards(hands[currentSeat], responsePlay)
      addFinishIfNeeded(finishOrder, currentSeat, hands)
      trickState.lastWinningPlay = responsePlay
      trickState.lastWinningSeat = currentSeat
      pushAction(actions, trickState, currentSeat, responsePlay, hands)
    } else {
      pushAction(actions, trickState, currentSeat, null, hands)
    }

    const nextSeat = nextActiveSeat(currentSeat, hands)
    // Trick ends when: no next seat, OR next seat IS the current winner,
    // OR the winner has already finished and we've looped back to the
    // first responder after the winner (otherwise infinite loop).
    const winnerGone = hands[trickState.lastWinningSeat].length === 0
    const firstAfterWinner = winnerGone ? nextActiveSeat(trickState.lastWinningSeat, hands) : null
    if (!nextSeat || nextSeat === trickState.lastWinningSeat || (winnerGone && nextSeat === firstAfterWinner)) {
      tricks.push({
        index: trickState.trickIndex,
        leader: trickState.leader,
        winningSeat: trickState.lastWinningSeat,
        actionIndexes: [...trickState.actionIndexes],
      })
      const nextLeader = nextLeaderAfterTrick(trickState.lastWinningSeat, hands)
      trickState = null
      trickIndex += 1
      currentSeat = nextLeader
      continue
    }

    currentSeat = nextSeat
  }

  finalizeLastSeat(finishOrder)

  return {
    seed,
    levelRank,
    startingSeat,
    players,
    actions,
    tricks,
    finishOrder,
    createdAt: new Date().toISOString(),
  } satisfies GuandanGame
}
