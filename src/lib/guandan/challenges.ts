import {
  buildReplaySnapshot,
  createSeededRng,
  DIFFICULTY_META,
  faceLabelForTraining,
  partnerOf,
  remainingFaceCounts,
  SEAT_LABELS,
  totalFaceCount,
} from './engine'
import type {
  ChallengeQuestion,
  Difficulty,
  GuandanGame,
  ReplayAction,
  ReplaySnapshot,
  VisibleTrick,
} from './types'

type PlannedChallenge = {
  trickIndex: number
  question: ChallengeQuestion
}

const STARTER_FOCUS_RANKS = [17, 16, 14, 13] as const

function shuffle<T>(items: T[], rng: () => number) {
  const clone = [...items]
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1))
    const temp = clone[index]
    clone[index] = clone[swapIndex]
    clone[swapIndex] = temp
  }
  return clone
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function buildNumericOptions(correct: number, max: number, rng: () => number) {
  const pool = new Set<number>([correct])
  const offsets = [-3, -2, -1, 1, 2, 3, 4]
  while (pool.size < 4) {
    const offset = offsets[Math.floor(rng() * offsets.length)]
    const value = Math.min(max, Math.max(0, correct + offset))
    pool.add(value)
    if (pool.size >= max + 1) {
      break
    }
  }

  while (pool.size < 4) {
    pool.add(Math.floor(rng() * (max + 1)))
  }

  const options = shuffle([...pool].map(String), rng)
  return {
    options,
    correctIndex: options.indexOf(String(correct)),
  }
}

function latestCompletedTrick(tricks: VisibleTrick[]) {
  return tricks.at(-1) ?? null
}

function playActionsOfTrick(trick: VisibleTrick) {
  return trick.actions.filter((action) => action.play)
}

function buildPatternQuestion(
  trick: VisibleTrick,
  recentActions: ReplayAction[],
  difficulty: Difficulty,
  rng: () => number,
) {
  const playActions = playActionsOfTrick(trick)
  if (playActions.length === 0) {
    return null
  }

  const target = playActions[Math.floor(rng() * playActions.length)]
  const distractors = uniqueStrings(
    recentActions
      .filter((action) => action.play && action.index !== target.index)
      .map((action) => action.play?.label ?? ''),
  )

  const optionPool = uniqueStrings([
    target.play?.label ?? '',
    ...shuffle(distractors, rng).slice(0, 6),
    '过牌',
    '天王炸',
  ]).filter(Boolean)

  const options = shuffle(optionPool.slice(0, 4), rng)
  if (!options.includes(target.play?.label ?? '')) {
    options[0] = target.play?.label ?? ''
  }

  return {
    prompt: `上一轮里，${SEAT_LABELS[target.seat]}最后一次出的是什么牌型？`,
    options,
    correctIndex: options.indexOf(target.play?.label ?? ''),
    explanation: `${SEAT_LABELS[target.seat]}当轮的有效出牌是 ${target.play?.detail ?? ''}。`,
    difficulty,
    tag: 'last-trick-pattern',
  } satisfies ChallengeQuestion
}

function buildWinnerQuestion(trick: VisibleTrick, difficulty: Difficulty, rng: () => number) {
  const options = shuffle(Object.values(SEAT_LABELS), rng)
  return {
    prompt: '上一轮最终是谁收轮并取得下一轮主动权？',
    options,
    correctIndex: options.indexOf(SEAT_LABELS[trick.winningSeat ?? trick.leader]),
    explanation: `${SEAT_LABELS[trick.winningSeat ?? trick.leader]}在上一轮最终压住。`,
    difficulty,
    tag: 'last-trick-winner',
  } satisfies ChallengeQuestion
}

function buildBigCardCountQuestion(game: GuandanGame, stepIndex: number, difficulty: Difficulty, rng: () => number) {
  const remaining = remainingFaceCounts(game, stepIndex)
  const pools = [game.levelRank, 14, 16, 17]
  const targetRank = pools[Math.floor(rng() * pools.length)]
  const correct = remaining.byRank.get(targetRank) ?? 0
  const max = totalFaceCount(targetRank)
  const numeric = buildNumericOptions(correct, max, rng)

  return {
    prompt: `${faceLabelForTraining(targetRank, game.levelRank)}还剩几张？`,
    options: numeric.options,
    correctIndex: numeric.correctIndex,
    explanation: `当前已经打出的都是实体牌面计数，所以 ${faceLabelForTraining(targetRank, game.levelRank)} 还剩 ${correct} 张。`,
    difficulty,
    tag: 'big-card-count',
  } satisfies ChallengeQuestion
}

function buildSpecificRankCountQuestion(
  game: GuandanGame,
  stepIndex: number,
  difficulty: Difficulty,
  rng: () => number,
  targetRank: number,
  promptPrefix = '',
  tag = 'focus-count',
) {
  const remaining = remainingFaceCounts(game, stepIndex)
  const correct = remaining.byRank.get(targetRank) ?? 0
  const numeric = buildNumericOptions(correct, totalFaceCount(targetRank), rng)
  const faceLabel = faceLabelForTraining(targetRank, game.levelRank)
  const prompt = promptPrefix
    ? `${promptPrefix}${faceLabel}还剩几张？`
    : `${faceLabel}还剩几张？`

  return {
    prompt,
    options: numeric.options,
    correctIndex: numeric.correctIndex,
    explanation: `${faceLabel}这一轮已经发生数量变化，按实体牌面现在还剩 ${correct} 张。`,
    difficulty,
    tag,
  } satisfies ChallengeQuestion
}

function buildWildCountQuestion(game: GuandanGame, stepIndex: number, difficulty: Difficulty, rng: () => number) {
  const remaining = remainingFaceCounts(game, stepIndex)
  const numeric = buildNumericOptions(remaining.wildsLeft, 2, rng)

  return {
    prompt: '红桃级牌“逢人配”还剩几张？',
    options: numeric.options,
    correctIndex: numeric.correctIndex,
    explanation: `本局共有 2 张红桃级牌，目前还剩 ${remaining.wildsLeft} 张未出现。`,
    difficulty,
    tag: 'wild-count',
  } satisfies ChallengeQuestion
}

function buildRecentTrickQuestion(
  completedTricks: VisibleTrick[],
  difficulty: Difficulty,
  rng: () => number,
  minOffset = 1,
  maxOffset = 2,
) {
  if (completedTricks.length <= minOffset) {
    return null
  }

  const highestOffset = Math.min(maxOffset, completedTricks.length - 1)
  const lowestOffset = Math.min(minOffset, highestOffset)
  const offset =
    highestOffset === lowestOffset
      ? highestOffset
      : lowestOffset + Math.floor(rng() * (highestOffset - lowestOffset + 1))
  const trick = completedTricks[completedTricks.length - 1 - offset]
  const playActions = playActionsOfTrick(trick)
  if (playActions.length === 0) {
    return null
  }

  const target = playActions[Math.floor(rng() * playActions.length)]
  const distractors = uniqueStrings(
    completedTricks
      .slice(Math.max(0, completedTricks.length - (highestOffset + 3)))
      .flatMap((item) => playActionsOfTrick(item))
      .filter((action) => action.index !== target.index)
      .map((action) => action.play?.detail ?? ''),
  )

  const optionPool = uniqueStrings([target.play?.detail ?? '', ...distractors]).filter(Boolean)
  const options = shuffle(optionPool.slice(0, 4), rng)
  if (!options.includes(target.play?.detail ?? '')) {
    options[0] = target.play?.detail ?? ''
  }

  return {
    prompt: `倒数第 ${completedTricks.at(-1)!.index - trick.index + 1} 轮中，${SEAT_LABELS[target.seat]}出的这手牌是什么？`,
    options,
    correctIndex: options.indexOf(target.play?.detail ?? ''),
    explanation: `${SEAT_LABELS[target.seat]}在那一轮打出的是 ${target.play?.detail ?? ''}。`,
    difficulty,
    tag: 'recent-trick-detail',
  } satisfies ChallengeQuestion
}

function buildCountQuestion(game: GuandanGame, stepIndex: number, difficulty: Difficulty, rng: () => number) {
  const builders =
    difficulty === 'expert'
      ? [
          () => buildAnyRankCountQuestion(game, stepIndex, difficulty, rng),
          () => buildBigCardCountQuestion(game, stepIndex, difficulty, rng),
          () => buildWildCountQuestion(game, stepIndex, difficulty, rng),
        ]
      : [
          () => buildBigCardCountQuestion(game, stepIndex, difficulty, rng),
          () => buildWildCountQuestion(game, stepIndex, difficulty, rng),
        ]

  for (const builder of shuffle(builders, rng)) {
    const question = builder()
    if (question) {
      return question
    }
  }

  return null
}

function buildAnyRankCountQuestion(game: GuandanGame, stepIndex: number, difficulty: Difficulty, rng: () => number) {
  const remaining = remainingFaceCounts(game, stepIndex)
  const pools = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]
  const targetRank = pools[Math.floor(rng() * pools.length)]
  const correct = remaining.byRank.get(targetRank) ?? 0
  const numeric = buildNumericOptions(correct, totalFaceCount(targetRank), rng)

  return {
    prompt: `${faceLabelForTraining(targetRank, game.levelRank)}按实体牌面还剩几张？`,
    options: numeric.options,
    correctIndex: numeric.correctIndex,
    explanation: `这里按实体牌面计数，不把红桃级牌替身重算到目标点数里，所以正确答案是 ${correct}。`,
    difficulty,
    tag: 'any-rank-count',
  } satisfies ChallengeQuestion
}

function buildPartnerPressureQuestion(trick: VisibleTrick, difficulty: Difficulty, rng: () => number) {
  const winner = trick.winningSeat ?? trick.leader
  const options = shuffle([
    `${SEAT_LABELS[winner]} 与 ${SEAT_LABELS[partnerOf(winner)]}`,
    `${SEAT_LABELS[winner]} 与 ${SEAT_LABELS[winner]}`,
    `${SEAT_LABELS[partnerOf(winner)]} 与 ${SEAT_LABELS[winner] === '南家' ? '东家' : '南家'}`,
    `${SEAT_LABELS[winner]} 与 ${SEAT_LABELS[winner] === '北家' ? '西家' : '北家'}`,
  ], rng)

  return {
    prompt: '上一轮收轮者的队友是谁？',
    options,
    correctIndex: options.indexOf(`${SEAT_LABELS[winner]} 与 ${SEAT_LABELS[partnerOf(winner)]}`),
    explanation: `${SEAT_LABELS[winner]} 的对家队友是 ${SEAT_LABELS[partnerOf(winner)]}。`,
    difficulty,
    tag: 'partner-awareness',
  } satisfies ChallengeQuestion
}

function ranksSeenInTrick(trick: VisibleTrick) {
  return new Set(
    trick.actions
      .flatMap((action) => action.play?.cards ?? [])
      .map((card) => card.rank),
  )
}

function pickStarterFocusRank(trick: VisibleTrick, levelRank: number) {
  const seenRanks = ranksSeenInTrick(trick)
  const priorityOrder = [levelRank, ...STARTER_FOCUS_RANKS].filter(
    (rank, index, items) => items.indexOf(rank) === index,
  )

  return priorityOrder.find((rank) => seenRanks.has(rank)) ?? null
}

function buildChallengePlan(
  game: GuandanGame,
  snapshot: ReplaySnapshot,
  difficulty: Difficulty,
  rng: () => number,
) {
  const latestTrick = latestCompletedTrick(snapshot.completedTricks)
  const recentActions = snapshot.visibleActions.slice(-18)
  const checkpoint = snapshot.completedTricks.length
  const reviewDepth = DIFFICULTY_META[difficulty].reviewDepth

  if (!latestTrick) {
    return [] as Array<() => ChallengeQuestion | null>
  }

  if (difficulty === 'starter') {
    const focusRank = pickStarterFocusRank(latestTrick, game.levelRank)
    if (focusRank !== null) {
      const forcedQuestion = buildSpecificRankCountQuestion(
        game,
        snapshot.stepIndex,
        difficulty,
        rng,
        focusRank,
        '这一轮里它已经出现，按实体牌面现在 ',
      )
      return [() => forcedQuestion]
    }

    const preferWinner = checkpoint % 2 === 1
    return [
      () => (preferWinner ? buildWinnerQuestion(latestTrick, difficulty, rng) : buildPatternQuestion(latestTrick, recentActions, difficulty, rng)),
      () => (preferWinner ? buildPatternQuestion(latestTrick, recentActions, difficulty, rng) : buildWinnerQuestion(latestTrick, difficulty, rng)),
    ]
  }

  if (difficulty === 'standard') {
    const cycle = (checkpoint - 1) % 3
    if (cycle === 0) {
      return [
        () => buildPatternQuestion(latestTrick, recentActions, difficulty, rng),
        () => buildWinnerQuestion(latestTrick, difficulty, rng),
        () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
      ]
    }
    if (cycle === 1) {
      return [
        () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
        () => buildWinnerQuestion(latestTrick, difficulty, rng),
        () => buildPatternQuestion(latestTrick, recentActions, difficulty, rng),
      ]
    }
    return [
      () => buildRecentTrickQuestion(snapshot.completedTricks, difficulty, rng, 1, reviewDepth),
      () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
      () => buildPatternQuestion(latestTrick, recentActions, difficulty, rng),
    ]
  }

  const cycle = (checkpoint - 1) % 4
  if (cycle === 0) {
    return [
      () => buildPatternQuestion(latestTrick, recentActions, difficulty, rng),
      () => buildWinnerQuestion(latestTrick, difficulty, rng),
      () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
    ]
  }
  if (cycle === 1) {
    return [
      () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
      () => buildRecentTrickQuestion(snapshot.completedTricks, difficulty, rng, 1, reviewDepth),
      () => buildWinnerQuestion(latestTrick, difficulty, rng),
    ]
  }
  if (cycle === 2) {
    return [
      () => buildRecentTrickQuestion(snapshot.completedTricks, difficulty, rng, 2, reviewDepth),
      () => buildAnyRankCountQuestion(game, snapshot.stepIndex, difficulty, rng),
      () => buildPatternQuestion(latestTrick, recentActions, difficulty, rng),
    ]
  }
  return [
    () => buildPartnerPressureQuestion(latestTrick, difficulty, rng),
    () => buildCountQuestion(game, snapshot.stepIndex, difficulty, rng),
    () => buildRecentTrickQuestion(snapshot.completedTricks, difficulty, rng, 1, reviewDepth),
  ]
}

function createChallengeFromSnapshot(game: GuandanGame, snapshot: ReplaySnapshot, difficulty: Difficulty) {
  if (snapshot.completedTricks.length === 0) {
    return null
  }

  const rng = createSeededRng(game.seed + snapshot.stepIndex * 131 + snapshot.completedTricks.length * 19 + difficulty.length * 17)
  for (const builder of buildChallengePlan(game, snapshot, difficulty, rng)) {
    const question = builder()
    if (question && question.options.length >= 2 && question.correctIndex >= 0) {
      return question
    }
  }

  return null
}

export function createChallenge(game: GuandanGame, stepIndex: number, difficulty: Difficulty) {
  return createChallengeFromSnapshot(game, buildReplaySnapshot(game, stepIndex), difficulty)
}

export function getChallengeForAdvance(
  game: GuandanGame,
  fromStep: number,
  toStep: number,
  difficulty: Difficulty,
  askedTrickIndexes: number[] = [],
): PlannedChallenge | null {
  const before = buildReplaySnapshot(game, fromStep)
  const after = buildReplaySnapshot(game, toStep)
  if (after.completedTricks.length <= before.completedTricks.length) {
    return null
  }

  const latestTrick = latestCompletedTrick(after.completedTricks)
  if (!latestTrick || askedTrickIndexes.includes(latestTrick.index)) {
    return null
  }

  const question = createChallengeFromSnapshot(game, after, difficulty)
  if (!question) {
    return null
  }

  return {
    trickIndex: latestTrick.index,
    question,
  }
}