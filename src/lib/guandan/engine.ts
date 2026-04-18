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
    summary: '每轮必答；A、K、王或级牌出现后优先追问剩余张数。',
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
    if (left.suit === right.suit) {
      return left.deck - right.deck
    }
    return SUIT_SYMBOLS[left.suit].localeCompare(SUIT_SYMBOLS[right.suit], 'zh-Hans-CN')
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

function scoreLead(play: PatternPlay, handSize: number, levelRank: number) {
  if (play.cards.length === handSize) {
    return -999
  }

  let score = play.primaryValue * 0.8
  score += play.wildCount * 6
  score -= play.cards.length * 2.2

  if (play.type === 'straight' || play.type === 'tube' || play.type === 'plate') {
    score -= 24
  }
  if (play.type === 'fullHouse') {
    score -= 18
  }
  if (play.type === 'triple') {
    score -= 9
  }
  if (play.type === 'single') {
    score += 24
  }
  if (play.type === 'pair') {
    score += 12
  }
  if (isBombPattern(play)) {
    score += handSize > 8 ? 70 : 24
  }
  if (play.primaryValue >= powerValue(levelRank, levelRank)) {
    score += handSize > 10 ? 8 : 2
  }

  return score
}

function scoreResponse(
  play: PatternPlay,
  current: PatternPlay,
  handSize: number,
  enemyDanger: boolean,
  partnerClose: boolean,
) {
  if (play.cards.length === handSize) {
    return -999
  }

  let score = play.primaryValue
  score += play.wildCount * 5
  score += isBombPattern(play) ? (enemyDanger ? 18 : 64) : 0
  score += canBeat(play, current) ? 0 : 1000
  score += play.primaryValue - current.primaryValue
  if (partnerClose) {
    score -= isBombPattern(play) ? 14 : 8
  }
  return score
}

function chooseLeadPlay(hand: Card[], levelRank: number) {
  const candidates = enumerateLeadPatterns(hand, levelRank)
  return candidates.toSorted((left, right) => scoreLead(left, hand.length, levelRank) - scoreLead(right, hand.length, levelRank))[0]
}

function chooseResponsePlay(
  hand: Card[],
  levelRank: number,
  current: PatternPlay,
  actor: Seat,
  winningSeat: Seat,
  remainingCounts: Record<Seat, number>,
) {
  const candidates = enumerateLeadPatterns(hand, levelRank).filter((pattern) => canBeat(pattern, current))
  if (candidates.length === 0) {
    return null
  }

  const teammateAhead = partnerOf(actor) === winningSeat
  const enemyDanger = remainingCounts[winningSeat] <= 5
  const partnerClose = remainingCounts[partnerOf(actor)] <= 3

  const sameTypeCandidates = candidates.filter((pattern) => !isBombPattern(pattern))
  const bombCandidates = candidates.filter((pattern) => isBombPattern(pattern))

  const chooseBest = (plays: PatternPlay[]) =>
    plays.toSorted(
      (left, right) =>
        scoreResponse(left, current, hand.length, enemyDanger, partnerClose) -
        scoreResponse(right, current, hand.length, enemyDanger, partnerClose),
    )[0]

  if (teammateAhead) {
    const finishingPlay = candidates.find((pattern) => pattern.cards.length === hand.length)
    return finishingPlay ?? null
  }

  if (sameTypeCandidates.length > 0) {
    const bestSameType = chooseBest(sameTypeCandidates)
    if (enemyDanger || partnerClose || hand.length <= 8 || bestSameType.cards.length >= 5) {
      return bestSameType
    }
    if (bestSameType.primaryValue - current.primaryValue <= 2) {
      return bestSameType
    }
  }

  if (bombCandidates.length > 0) {
    const bestBomb = chooseBest(bombCandidates)
    if (enemyDanger || partnerClose || hand.length <= 6 || bestBomb.cards.length === hand.length) {
      return bestBomb
    }
  }

  return null
}

function cloneHands(hands: Record<Seat, Card[]>, levelRank: number) {
  return {
    south: sortCards(hands.south, levelRank),
    east: sortCards(hands.east, levelRank),
    north: sortCards(hands.north, levelRank),
    west: sortCards(hands.west, levelRank),
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
    currentTrick: visibleTricks.at(-1) ?? null,
    remainingCounts,
    nextSeat: clampedStep < game.actions.length ? game.actions[clampedStep].seat : null,
    lastAction,
    isComplete: clampedStep >= game.actions.length,
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
      const leadPlay = chooseLeadPlay(hands[currentSeat], levelRank)
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
