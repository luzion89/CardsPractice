import type { PatternType, ReplayAction, Seat, TrickRecord } from './types'

const PARTNERS: Record<Seat, Seat> = {
  south: 'north',
  east: 'west',
  north: 'south',
  west: 'east',
}

const COMBO_TYPES = new Set<PatternType>(['straight', 'tube', 'plate', 'fullHouse'])
const BOMB_TYPES = new Set<PatternType>(['bomb', 'straightFlush', 'jokerBomb'])

export interface StrategyTrickSummary {
  index: number
  leader: Seat
  winner: Seat
  winningType: PatternType | null
  winningValue: number | null
  playCount: number
  uncontested: boolean
  comboLike: boolean
  bombLike: boolean
}

export interface StrategyContext {
  recentTricks: StrategyTrickSummary[]
  enemyWinningStreak: number
  partnerWinningStreak: number
  enemyComboPressure: number
}

function summarizeTrick(actions: ReplayAction[], trick: TrickRecord): StrategyTrickSummary {
  const trickActions = trick.actionIndexes
    .map((actionIndex) => actions[actionIndex])
    .filter((action): action is ReplayAction => Boolean(action))
  const playActions = trickActions.filter((action) => action.action === 'play' && action.play)
  const winningAction = [...playActions].reverse().find((action) => action.seat === trick.winningSeat) ?? null
  const winningType = winningAction?.play?.type ?? null

  return {
    index: trick.index,
    leader: trick.leader,
    winner: trick.winningSeat,
    winningType,
    winningValue: winningAction?.play?.primaryValue ?? null,
    playCount: playActions.length,
    uncontested: playActions.length === 1,
    comboLike: winningType ? COMBO_TYPES.has(winningType) : false,
    bombLike: winningType ? BOMB_TYPES.has(winningType) : false,
  }
}

function countConsecutiveFromEnd(
  tricks: StrategyTrickSummary[],
  predicate: (trick: StrategyTrickSummary) => boolean,
) {
  let count = 0

  for (let index = tricks.length - 1; index >= 0; index -= 1) {
    if (!predicate(tricks[index])) {
      break
    }
    count += 1
  }

  return count
}

export function buildStrategyContext(
  actor: Seat,
  actions: ReplayAction[],
  tricks: TrickRecord[],
): StrategyContext {
  const partner = PARTNERS[actor]
  const recentTricks = tricks.slice(-4).map((trick) => summarizeTrick(actions, trick))

  return {
    recentTricks,
    enemyWinningStreak: countConsecutiveFromEnd(recentTricks, (trick) => trick.winner !== actor && trick.winner !== partner),
    partnerWinningStreak: countConsecutiveFromEnd(recentTricks, (trick) => trick.winner === partner),
    enemyComboPressure: countConsecutiveFromEnd(
      recentTricks,
      (trick) => trick.winner !== actor && trick.winner !== partner && (trick.comboLike || trick.bombLike),
    ),
  }
}