export type Seat = 'south' | 'east' | 'north' | 'west'

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades' | 'black' | 'red'

export type Difficulty = 'starter' | 'standard' | 'expert'

export type PatternType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'fullHouse'
  | 'straight'
  | 'tube'
  | 'plate'
  | 'bomb'
  | 'straightFlush'
  | 'jokerBomb'

export interface Card {
  id: string
  rank: number
  suit: Suit
  deck: 1 | 2
}

export interface PatternAssignment {
  rank: number
  suit?: Suit
}

export interface PatternPlay {
  type: PatternType
  cards: Card[]
  label: string
  detail: string
  shortLabel: string
  primaryValue: number
  sequenceIndex: number | null
  sameRankCount: number | null
  bombTier: number
  wildCount: number
  assignments: Record<string, PatternAssignment>
}

export interface ReplayAction {
  index: number
  trickIndex: number
  seat: Seat
  action: 'play' | 'pass'
  play: PatternPlay | null
  handCountAfter: number
  remainingCounts: Record<Seat, number>
  winningSeat: Seat | null
  note: string
}

export interface TrickRecord {
  index: number
  leader: Seat
  winningSeat: Seat
  actionIndexes: number[]
}

export interface FinishRecord {
  seat: Seat
  place: number
}

export interface GuandanGame {
  seed: number
  levelRank: number
  startingSeat: Seat
  players: Record<Seat, Card[]>
  actions: ReplayAction[]
  tricks: TrickRecord[]
  finishOrder: FinishRecord[]
  createdAt: string
}

export interface VisibleTrick {
  index: number
  leader: Seat
  winningSeat: Seat | null
  actions: ReplayAction[]
  complete: boolean
}

export interface ReplaySnapshot {
  stepIndex: number
  visibleActions: ReplayAction[]
  visibleTricks: VisibleTrick[]
  completedTricks: VisibleTrick[]
  currentTrick: VisibleTrick | null
  remainingCounts: Record<Seat, number>
  nextSeat: Seat | null
  lastAction: ReplayAction | null
  isComplete: boolean
  finishOrder: FinishRecord[]
}

export interface ChallengeQuestion {
  prompt: string
  options: string[]
  correctIndex: number
  explanation: string
  difficulty: Difficulty
  tag: string
}

export interface DifficultyMeta {
  label: string
  challengeChance: number
  summary: string
}
