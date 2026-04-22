import type { Card, PatternPlay, ReplayAction, Seat } from './types'
import type { AILegalActionOption, AIPlayResult } from './aiService'
import { chooseStrategyActionFromLegalActions } from './strategyPolicy'

export class LocalStrategySession {
  readonly seat: Seat
  readonly levelRank: number

  constructor(seat: Seat, levelRank: number) {
    this.seat = seat
    this.levelRank = levelRank
  }

  async requestPlay(
    _hand: Card[],
    actions: ReplayAction[],
    currentPlay: PatternPlay | null,
    isLeading: boolean,
    remainingCounts: Record<Seat, number>,
    legalActions: AILegalActionOption[] = [],
    _signal?: AbortSignal,
  ): Promise<AIPlayResult> {
    void _signal

    return chooseStrategyActionFromLegalActions({
      seat: this.seat,
      actions,
      currentPlay,
      isLeading,
      remainingCounts,
      legalActions,
    })
  }
}