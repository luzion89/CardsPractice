import type { PatternPlay, ReplayAction, Seat } from './types'
import type { AILegalActionOption, AIPlayResult } from './aiService'

export type StrategyRuleCategory = 'rules' | 'tempo' | 'teamplay' | 'control' | 'defense'

export interface StrategyRuleDefinition {
  id: string
  priority: number
  category: StrategyRuleCategory
  rule: string
  trigger: string
  action: string
  exception?: string
  example?: string
}

export const STRATEGY_RULES: StrategyRuleDefinition[] = [
  {
    id: 'rules.legal-actions-only',
    priority: 0,
    category: 'rules',
    rule: '任何时候都只从本地枚举出的合法动作里选择。',
    trigger: '每次轮到当前座位行动。',
    action: '只在 legalActions 中选 actionId。',
    example: '即使觉得拆牌更有利，也不能跳出本地合法候选。',
  },
  {
    id: 'teamplay.partner-keeps-lead',
    priority: 10,
    category: 'teamplay',
    rule: '对家当前控轮时，除非能直接收尾，否则不抢对家牌权。',
    trigger: 'currentWinningSeat 为对家。',
    action: '默认过牌；只有能一次走完时才压。',
  },
  {
    id: 'tempo.fastest-hand-count',
    priority: 20,
    category: 'tempo',
    rule: '领出优先考虑能明显压缩手数的组合。',
    trigger: '当前为领出阶段。',
    action: '若组合牌能显著降低剩余手数，则优先它。',
    example: '顺子、三连对、钢板通常优于零散小牌。',
  },
  {
    id: 'defense.preserve-natural-bombs',
    priority: 30,
    category: 'defense',
    rule: '尽量不拆天然炸弹，也尽量保留逢人配和高控制牌。',
    trigger: '候选动作会拆 4 张及以上天然炸弹，或明显提前消耗高控制资源。',
    action: '除非收尾、救急或连续失控，否则下调这类候选优先级。',
  },
  {
    id: 'teamplay.feed-partner-when-close',
    priority: 40,
    category: 'teamplay',
    rule: '对家剩牌较少时，优先送低风险小牌帮助对家接管节奏。',
    trigger: '对家剩牌 <= 3 且当前由我领出。',
    action: '优先不拆结构的小单或小对。',
    exception: '若敌方马上收尾且我方无控制资源，则不机械送牌。',
  },
  {
    id: 'control.contest-dangerous-enemy',
    priority: 50,
    category: 'control',
    rule: '对手快走完时，提高抢权优先级。',
    trigger: '当前领先敌方剩牌 <= 5。',
    action: '接受更高保牌成本，优先选择能断节奏的合法应对。',
  },
  {
    id: 'control.break-combo-pressure',
    priority: 60,
    category: 'control',
    rule: '敌方连续用顺子、三连对、钢板或炸弹控场时，要提高抢权意愿。',
    trigger: '连续失去牌权，或敌方连续两轮以上组合控场。',
    action: '允许使用更强控制牌甚至炸弹抢回牌权。',
  },
  {
    id: 'defense.minimize-overshoot',
    priority: 70,
    category: 'defense',
    rule: '能用较小同型接牌，就不要明显过冲。',
    trigger: '当前为应对阶段且存在多个同型可压候选。',
    action: '优先更小的同型候选；若收益不足则直接过牌保结构。',
  },
  {
    id: 'tempo.small-card-first',
    priority: 80,
    category: 'tempo',
    rule: '在手数收益接近时，优先走小牌，保留高牌做后续控场。',
    trigger: '多个候选手数收益接近。',
    action: '小单、小对优先于高控制单牌或过早的大牌。',
  },
]

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

function getRule(id: string) {
  return STRATEGY_RULES.find((rule) => rule.id === id)
}

function findCurrentWinningSeat(actions: ReplayAction[], currentPlay: PatternPlay | null) {
  if (!currentPlay || actions.length === 0) {
    return null
  }

  const currentTrickIndex = actions[actions.length - 1]?.trickIndex ?? 0
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]
    if (action.trickIndex !== currentTrickIndex) {
      break
    }
    if (action.play) {
      return action.seat
    }
  }

  return null
}

function isBombLike(detail: string) {
  return detail.includes('炸弹') || detail.includes('同花顺') || detail.includes('天王炸')
}

function isComboLike(detail: string) {
  return detail.includes('顺子') || detail.includes('三连对') || detail.includes('钢板') || detail.includes('三带二')
}

function isSmallTempoFeed(option: AILegalActionOption) {
  return option.action === 'play'
    && (option.label.startsWith('单张') || option.label.startsWith('对子'))
    && !isBombLike(option.detail)
}

export interface StrategyReasonParams {
  seat: Seat
  actions: ReplayAction[]
  currentPlay: PatternPlay | null
  isLeading: boolean
  remainingCounts: Record<Seat, number>
  legalActions: AILegalActionOption[]
  chosenAction: AILegalActionOption
}

export function buildStrategyReason({
  seat,
  actions,
  currentPlay,
  isLeading,
  remainingCounts,
  chosenAction,
}: StrategyReasonParams) {
  const partner = partnerOf(seat)
  const currentWinningSeat = findCurrentWinningSeat(actions, currentPlay)
  const partnerClose = remainingCounts[partner] > 0 && remainingCounts[partner] <= 3
  const enemyDanger = currentWinningSeat && currentWinningSeat !== partner && currentWinningSeat !== seat
    ? remainingCounts[currentWinningSeat] <= 5
    : false

  if (chosenAction.action === 'pass') {
    if (currentWinningSeat === partner) {
      const rule = getRule('teamplay.partner-keeps-lead')
      return `[${rule?.id}] 对家当前控轮，选择让出牌权留在我方。`
    }

    const rule = getRule('defense.minimize-overshoot')
    return `[${rule?.id}] 当前没有低成本且合理的应对，选择过牌保留结构。`
  }

  if (isLeading && partnerClose && isSmallTempoFeed(chosenAction)) {
    const rule = getRule('teamplay.feed-partner-when-close')
    return `[${rule?.id}] 对家剩牌少，优先送低风险小牌，争取让对家接住节奏。`
  }

  if (currentPlay && enemyDanger && isBombLike(chosenAction.detail)) {
    const rule = getRule('control.contest-dangerous-enemy')
    return `[${rule?.id}] 对手剩牌危险，使用强控制牌抢回牌权。`
  }

  if (currentPlay && !isBombLike(chosenAction.detail)) {
    const rule = getRule('defense.minimize-overshoot')
    return `[${rule?.id}] 采用更小的合法应对，避免无谓交大牌。`
  }

  if (isLeading && isComboLike(chosenAction.detail)) {
    const rule = getRule('tempo.fastest-hand-count')
    return `[${rule?.id}] 这手能更明显压缩整体手数，优先走组合牌。`
  }

  const rule = getRule('tempo.small-card-first')
  return `[${rule?.id}] 在收益接近时先走小牌，保留后续控制资源。`
}

export function chooseStrategyActionFromLegalActions(params: Omit<StrategyReasonParams, 'chosenAction'>): AIPlayResult {
  const playOptions = params.legalActions.filter((option) => option.action === 'play')
  const passOption = params.legalActions.find((option) => option.action === 'pass') ?? null
  const chosenAction = playOptions[0] ?? passOption ?? params.legalActions[0]

  if (!chosenAction) {
    return {
      cards: [],
      pass: true,
      reason: '[rules.legal-actions-only] 当前没有可选动作，按规则过牌。',
    }
  }

  return {
    actionId: chosenAction.actionId,
    cards: chosenAction.cards,
    pass: chosenAction.action === 'pass',
    reason: buildStrategyReason({ ...params, chosenAction }),
  }
}