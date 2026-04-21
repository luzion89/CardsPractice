import {
  arrangeHandCards,
  canBeat,
  comboPreservationPenalty,
  enumerateLeadPatterns,
  estimateHandCount,
  generateGame,
  shouldKeepCandidate,
} from './engine'
import type { Card, GuandanGame, PatternPlay, Seat } from './types'

export type StrategyDiagnosticTag =
  | 'partner-block'
  | 'bomb-overuse'
  | 'oversized-response'
  | 'high-control-lead'
  | 'missed-tempo-lead'

export interface StrategyDiagnostic {
  actionIndex: number
  seat: Seat
  tag: StrategyDiagnosticTag
  message: string
}

export interface StrategyGameReport {
  game: GuandanGame
  diagnostics: StrategyDiagnostic[]
}

export interface StrategySimulationReport {
  seeds: number[]
  games: StrategyGameReport[]
  summary: {
    totalGames: number
    totalDiagnostics: number
    byTag: Partial<Record<StrategyDiagnosticTag, number>>
  }
}

function partnerOf(seat: Seat): Seat {
  switch (seat) {
    case 'south':
      return 'north'
    case 'east':
      return 'west'
    case 'north':
      return 'south'
    case 'west':
      return 'east'
  }
}

function cloneHands(players: Record<Seat, Card[]>, levelRank: number) {
  return {
    south: arrangeHandCards(players.south, levelRank),
    east: arrangeHandCards(players.east, levelRank),
    north: arrangeHandCards(players.north, levelRank),
    west: arrangeHandCards(players.west, levelRank),
  }
}

function removePlayedCards(hand: Card[], play: PatternPlay) {
  const ids = new Set(play.cards.map((card) => card.id))
  return hand.filter((card) => !ids.has(card.id))
}

function isBombLike(play: PatternPlay) {
  return play.type === 'bomb' || play.type === 'straightFlush' || play.type === 'jokerBomb'
}

function isControlLike(play: PatternPlay) {
  if (isBombLike(play)) {
    return true
  }

  if (play.type === 'single') {
    return play.primaryValue >= 14
  }

  if (play.type === 'pair') {
    return play.primaryValue >= 13
  }

  if (play.type === 'triple' || play.type === 'fullHouse') {
    return play.primaryValue >= 12
  }

  return false
}

function samePattern(left: PatternPlay, right: PatternPlay) {
  if (left.cards.length !== right.cards.length) {
    return false
  }

  const ids = new Set(left.cards.map((card) => card.id))
  return right.cards.every((card) => ids.has(card.id))
}

function buildRemainingCounts(hands: Record<Seat, Card[]>) {
  return {
    south: hands.south.length,
    east: hands.east.length,
    north: hands.north.length,
    west: hands.west.length,
  }
}

function analyzeLead(
  diagnostics: StrategyDiagnostic[],
  actionIndex: number,
  seat: Seat,
  hand: Card[],
  play: PatternPlay,
  levelRank: number,
) {
  const candidates = enumerateLeadPatterns(hand, levelRank)
    .filter((candidate) => shouldKeepCandidate(candidate, hand, levelRank, false))
  const actualAfterMoves = 1 + estimateHandCount(removePlayedCards(hand, play), levelRank)
  const actualPenalty = comboPreservationPenalty(play, hand, levelRank)

  if (isControlLike(play) && hand.length >= 10) {
    const saferAlternative = candidates.find((candidate) => {
      if (samePattern(candidate, play) || isControlLike(candidate) || candidate.primaryValue >= play.primaryValue) {
        return false
      }

      const candidateAfterMoves = 1 + estimateHandCount(removePlayedCards(hand, candidate), levelRank)
      return candidateAfterMoves <= actualAfterMoves + 1
    })

    if (saferAlternative) {
      diagnostics.push({
        actionIndex,
        seat,
        tag: 'high-control-lead',
        message: `存在更低风险的领出 ${saferAlternative.detail}，当前过早交出 ${play.detail}`,
      })
    }
  }

  const betterTempoAlternative = candidates.find((candidate) => {
    if (samePattern(candidate, play)) {
      return false
    }

    const candidateAfterMoves = 1 + estimateHandCount(removePlayedCards(hand, candidate), levelRank)
    const candidatePenalty = comboPreservationPenalty(candidate, hand, levelRank)
    return candidateAfterMoves + 1 < actualAfterMoves && candidatePenalty <= actualPenalty + 18
  })

  if (betterTempoAlternative) {
    diagnostics.push({
      actionIndex,
      seat,
      tag: 'missed-tempo-lead',
      message: `存在更快的领出 ${betterTempoAlternative.detail}，当前 ${play.detail} 未优先压缩手数`,
    })
  }
}

function analyzeResponse(
  diagnostics: StrategyDiagnostic[],
  actionIndex: number,
  seat: Seat,
  hand: Card[],
  play: PatternPlay,
  currentPlay: PatternPlay,
  currentWinningSeat: Seat,
  levelRank: number,
  remainingCounts: Record<Seat, number>,
) {
  const partner = partnerOf(seat)
  const candidates = enumerateLeadPatterns(hand, levelRank).filter((candidate) => canBeat(candidate, currentPlay))

  if (currentWinningSeat === partner && play.cards.length !== hand.length) {
    diagnostics.push({
      actionIndex,
      seat,
      tag: 'partner-block',
      message: `对家当前控轮，却继续以 ${play.detail} 抢权`,
    })
  }

  if (isBombLike(play) && !isBombLike(currentPlay) && remainingCounts[currentWinningSeat] >= 6) {
    const smallerBeatingPlay = candidates.find((candidate) => !isBombLike(candidate))
    if (smallerBeatingPlay) {
      diagnostics.push({
        actionIndex,
        seat,
        tag: 'bomb-overuse',
        message: `可用 ${smallerBeatingPlay.detail} 接牌，却直接用了 ${play.detail}`,
      })
    }
  }

  if (!isBombLike(play) && play.type === currentPlay.type && currentWinningSeat !== partner && remainingCounts[currentWinningSeat] >= 6) {
    const minimalResponse = candidates
      .filter((candidate) => !isBombLike(candidate) && candidate.type === currentPlay.type)
      .toSorted((left, right) => {
        return left.primaryValue - right.primaryValue
          || left.wildCount - right.wildCount
          || left.cards.length - right.cards.length
      })[0]

    if (minimalResponse) {
      const overshoot = play.primaryValue - minimalResponse.primaryValue
      if (!samePattern(minimalResponse, play) && (overshoot >= 3 || play.wildCount > minimalResponse.wildCount)) {
        diagnostics.push({
          actionIndex,
          seat,
          tag: 'oversized-response',
          message: `存在更小的应对 ${minimalResponse.detail}，当前 ${play.detail} 明显过大`,
        })
      }
    }
  }
}

export function analyzeGameStrategy(game: GuandanGame): StrategyGameReport {
  const hands = cloneHands(game.players, game.levelRank)
  const diagnostics: StrategyDiagnostic[] = []
  const trickEndIndexes = new Set(game.tricks.map((trick) => trick.actionIndexes[trick.actionIndexes.length - 1]))
  let currentPlay: PatternPlay | null = null
  let currentWinningSeat: Seat | null = null

  for (const action of game.actions) {
    const seat = action.seat
    const handBeforeAction = hands[seat]

    if (action.action === 'play' && action.play) {
      if (!currentPlay || !currentWinningSeat) {
        analyzeLead(diagnostics, action.index, seat, handBeforeAction, action.play, game.levelRank)
      } else {
        analyzeResponse(
          diagnostics,
          action.index,
          seat,
          handBeforeAction,
          action.play,
          currentPlay,
          currentWinningSeat,
          game.levelRank,
          buildRemainingCounts(hands),
        )
      }

      hands[seat] = removePlayedCards(handBeforeAction, action.play)
      currentPlay = action.play
      currentWinningSeat = seat
    }

    if (trickEndIndexes.has(action.index)) {
      currentPlay = null
      currentWinningSeat = null
    }
  }

  return {
    game,
    diagnostics,
  }
}

export function simulateStrategyGames(seeds: number[]): StrategySimulationReport {
  const games = seeds.map((seed) => analyzeGameStrategy(generateGame(seed)))
  const byTag: Partial<Record<StrategyDiagnosticTag, number>> = {}

  for (const game of games) {
    for (const diagnostic of game.diagnostics) {
      byTag[diagnostic.tag] = (byTag[diagnostic.tag] ?? 0) + 1
    }
  }

  return {
    seeds,
    games,
    summary: {
      totalGames: games.length,
      totalDiagnostics: games.reduce((total, game) => total + game.diagnostics.length, 0),
      byTag,
    },
  }
}