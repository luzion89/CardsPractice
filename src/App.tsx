import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getChallengeForAdvance } from './lib/guandan/challenges'
import {
  buildReplaySnapshot,
  DIFFICULTY_META,
  generateGame,
  rankToText,
  SEAT_LABELS,
  sortHandForDisplay,
  TEAM_LABELS,
} from './lib/guandan/engine'
import { GameManager, type GamePhase } from './lib/guandan/gameManager'
import { buildOpeningGuideItems, DEFAULT_AI_CONFIG, type OpeningGuideItem, testOpenRouterConnection } from './lib/guandan/aiService'
import type {
  AIConfig,
  Card,
  ChallengeQuestion,
  Difficulty,
  GuandanGame,
  PatternPlay,
  ReplayAction,
  ReplaySnapshot,
  Seat,
} from './lib/guandan/types'
import { CardGroup, PlayingCard } from './components/PlayingCard'
import { CARD_SIZE_METRICS, type CardSize } from './components/cardMetrics'
import './App.css'

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

type TrainingStats = {
  attempted: number
  correct: number
  streak: number
  bestStreak: number
}

type GameMode = 'ai' | 'strategy' | 'local'

type ActiveChallenge = {
  trickIndex: number
  question: ChallengeQuestion
  selectedIndex: number | null
  isCorrect: boolean | null
}

type PersistedState = {
  difficulty: Difficulty
  stats: TrainingStats
  aiConfig: AIConfig | null
  debugMode: boolean
  gameMode?: GameMode
}

type OpeningGuideState = {
  items: OpeningGuideItem[]
}

type ModalKind = 'none' | 'settings' | 'info' | 'result'
type TablePosition = 'top' | 'bottom' | 'left' | 'right'

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const STORAGE_KEY = 'guandan-memory-lab-v2'
const SELF_SEAT: Seat = 'south'
const LEGACY_DEFAULT_MODELS = new Set(['google/gemini-2.0-flash-001'])
const POSITION_BY_SEAT: Record<Seat, TablePosition> = {
  north: 'top',
  west: 'left',
  east: 'right',
  south: 'bottom',
}
const TABLE_SEATS: Seat[] = ['north', 'west', 'east', 'south']

/* ================================================================== */
/*  Persistence                                                        */
/* ================================================================== */

function loadPersisted(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PersistedState
  } catch {
    return null
  }
}

function persistSettings(state: PersistedState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function normalizeStoredModel(model: string | null | undefined) {
  const trimmed = model?.trim() ?? ''
  if (!trimmed || LEGACY_DEFAULT_MODELS.has(trimmed)) {
    return DEFAULT_AI_CONFIG.model
  }
  return trimmed
}

function makeFreshStats(): TrainingStats {
  return { attempted: 0, correct: 0, streak: 0, bestStreak: 0 }
}

function challengeTagLabel(tag: string) {
  switch (tag) {
    case 'focus-count': return '重点计数'
    case 'last-trick-pattern':
    case 'last-trick-winner': return '立即回忆'
    case 'big-card-count':
    case 'wild-count':
    case 'any-rank-count': return '全局计数'
    case 'recent-trick-detail': return '延迟回忆'
    case 'partner-awareness': return '搭档判断'
    default: return '轮次检索'
  }
}

function buildLocalOpeningGuide(cards: Card[], levelRank: number): OpeningGuideState {
  return {
    items: buildOpeningGuideItems(cards, levelRank),
  }
}

function gameModeLabel(mode: GameMode) {
  switch (mode) {
    case 'ai':
      return 'AI实时对局'
    case 'strategy':
      return '策略实时对局'
    case 'local':
      return '本地预生成回放'
  }
}

/* ================================================================== */
/*  Sub-components                                                     */
/* ================================================================== */

function remainingHandForSeat(game: GuandanGame, snapshot: ReplaySnapshot, seat: Seat) {
  const playedIds = new Set(
    snapshot.visibleActions
      .filter((a) => a.seat === seat)
      .flatMap((a) => a.play?.cards ?? [])
      .map((c) => c.id),
  )
  return sortHandForDisplay(
    game.players[seat].filter((c) => !playedIds.has(c.id)),
    game.levelRank,
  )
}

function PlayDisplay({ play, levelRank, size = 'sm' }: { play: PatternPlay | null; levelRank: number; size?: CardSize }) {
  if (!play) return <span className="pass-text">过</span>
  return <CardGroup cards={play.cards} levelRank={levelRank} size={size} />
}

function SeatBadge({
  seat,
  remaining,
  isNext,
  isFinished,
  position,
  thinking,
}: {
  seat: Seat
  remaining: number
  isNext: boolean
  isFinished: boolean
  position: TablePosition
  thinking?: boolean
}) {
  const teamClass = seat === 'south' || seat === 'north' ? 'team-ns' : 'team-ew'
  const metaText = isFinished ? '已出完' : `${remaining}张`

  return (
    <div className={`seat-badge ${position} ${teamClass} ${isNext ? 'is-next' : ''} ${isFinished ? 'is-finished' : ''} ${thinking ? 'thinking' : ''}`}>
      <span className="seat-role">{SEAT_LABELS[seat]}</span>
      <span className="seat-meta">{metaText}</span>
      {thinking && <span className="thinking-dot"><span /><span /><span /></span>}
    </div>
  )
}

function TablePlaySlot({
  play,
  levelRank,
  position,
}: {
  play: PatternPlay | null | undefined
  levelRank: number
  position: TablePosition
}) {
  if (play === undefined) return null
  return (
    <div className={`table-play-slot ${position} ${play ? 'has-play' : 'is-pass'}`}>
      <PlayDisplay play={play} levelRank={levelRank} size="sm" />
    </div>
  )
}

function HandRack({ cards, levelRank }: { cards: Card[]; levelRank: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    const update = () => setContainerWidth(node.clientWidth)
    update()

    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const availableWidth = Math.max(containerWidth, 260)
  const size: CardSize = availableWidth >= 920 ? 'md' : availableWidth >= 560 ? 'sm' : 'xs'
  const metrics = CARD_SIZE_METRICS[size]
  const preferredStep = size === 'md' ? 28 : size === 'sm' ? 20 : 14
  const fitStep = cards.length > 1
    ? Math.floor((availableWidth - metrics.w) / Math.max(1, cards.length - 1))
    : metrics.w
  const step = cards.length > 1 ? Math.max(6, Math.min(preferredStep, fitStep)) : 0
  const rackWidth = cards.length > 1 ? metrics.w + step * (cards.length - 1) : metrics.w

  return (
    <div className="hand-scroll" ref={containerRef}>
      <div className="hand-rack hand-rack-overlap" style={{ width: rackWidth, height: metrics.h }}>
        {cards.map((card, index) => (
          <div
            key={card.id}
            className="hand-card-shell overlap"
            style={{ left: index * step, zIndex: index + 1 }}
          >
            <PlayingCard card={card} levelRank={levelRank} size={size} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ================================================================== */
/*  Main App                                                           */
/* ================================================================== */

function App() {
  const persisted = loadPersisted()

  /* ---- Core state ---- */
  const [game, setGame] = useState<GuandanGame | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [difficulty, setDifficulty] = useState<Difficulty>(() => persisted?.difficulty ?? 'starter')
  const [challengedTrickIndexes, setChallengedTrickIndexes] = useState<number[]>([])
  const [stats, setStats] = useState<TrainingStats>(() => persisted?.stats ?? makeFreshStats())
  const [activeChallenge, setActiveChallenge] = useState<ActiveChallenge | null>(null)
  const [modal, setModal] = useState<ModalKind>('none')
  const [error, setError] = useState<string | null>(null)
  const [debugMode, setDebugMode] = useState(() => persisted?.debugMode ?? false)
  const [aiThinking, setAiThinking] = useState(false)
  const [aiReasons, setAiReasons] = useState<Record<number, string>>({})
  const [thinkingSeat, setThinkingSeat] = useState<Seat | null>(null)
  const [aiPhase, setAiPhase] = useState<GamePhase>('waiting')
  const [openingGuide, setOpeningGuide] = useState<OpeningGuideState | null>(null)

  /* ---- AI config ---- */
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(() => {
    if (!persisted?.aiConfig) return null
    return {
      ...persisted.aiConfig,
      model: normalizeStoredModel(persisted.aiConfig.model),
    }
  })
  const [apiKeyInput, setApiKeyInput] = useState(() => persisted?.aiConfig?.apiKey ?? '')
  const [modelInput, setModelInput] = useState(() => normalizeStoredModel(persisted?.aiConfig?.model))
  const [aiConnectionStatus, setAiConnectionStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [aiConnectionMessage, setAiConnectionMessage] = useState('')

  /* ---- Game mode: 'ai' (live AI) or 'local' (pre-generated) ---- */
  const [gameMode, setGameMode] = useState<GameMode>(() => persisted?.gameMode ?? (persisted?.aiConfig?.apiKey ? 'ai' : 'local'))

  const isManagedMode = gameMode === 'ai' || gameMode === 'strategy'

  /* ---- Refs ---- */
  const managerRef = useRef<GameManager | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nextStepLockRef = useRef(false)

  /* ---- Derived ---- */
  const snapshot = useMemo(
    () => (game ? buildReplaySnapshot(game, stepIndex) : null),
    [game, stepIndex],
  )
  const progress =
    !game || isManagedMode
      ? null
      : game.actions.length > 0
        ? Math.round((stepIndex / game.actions.length) * 100)
        : 0
  const accuracy = stats.attempted === 0 ? 0 : Math.round((stats.correct / stats.attempted) * 100)
  const isGameOver =
    !game || (isManagedMode ? aiPhase === 'finished' : (snapshot?.isComplete ?? false))
  const actingSeat = aiThinking ? thinkingSeat : snapshot?.nextSeat ?? null
  const ownHand = useMemo(
    () => (game && snapshot ? remainingHandForSeat(game, snapshot, SELF_SEAT) : []),
    [game, snapshot],
  )
  const latestVisibleActionBySeat = useMemo(() => {
    const latest: Partial<Record<Seat, ReplayAction>> = {}
    for (const action of snapshot?.visibleActions ?? []) {
      latest[action.seat] = action
    }
    return latest
  }, [snapshot])

  const currentTrickPlays: Partial<Record<Seat, PatternPlay | null>> = {}
  if (snapshot?.currentTrick) {
    for (const action of snapshot.currentTrick.actions) {
      currentTrickPlays[action.seat] = action.play
    }
  }

  /* ---- Persist settings ---- */
  const debouncedPersist = useCallback(
    (state: PersistedState) => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => persistSettings(state), 200)
    },
    [],
  )

  useEffect(() => {
    debouncedPersist({ difficulty, stats, aiConfig, debugMode, gameMode })
  }, [debouncedPersist, difficulty, stats, aiConfig, debugMode, gameMode])

  const prepareOpeningGuide = useCallback((initialHand: Card[], levelRank: number) => {
    setOpeningGuide(buildLocalOpeningGuide(initialHand, levelRank))
  }, [])

  const handleDifficultyChange = useCallback((nextDifficulty: Difficulty) => {
    setDifficulty(nextDifficulty)

    if (!game || stepIndex !== 0) {
      if (nextDifficulty !== 'starter') {
        setOpeningGuide(null)
      }
      return
    }

    if (nextDifficulty !== 'starter') {
      setOpeningGuide(null)
      return
    }

    prepareOpeningGuide(game.players[SELF_SEAT], game.levelRank)
  }, [game, prepareOpeningGuide, stepIndex])

  const markConnectionAsDirty = useCallback(() => {
    setAiConnectionStatus('idle')
    setAiConnectionMessage('')
  }, [])

  const handleApiKeyInputChange = useCallback((value: string) => {
    setApiKeyInput(value)
    markConnectionAsDirty()
  }, [markConnectionAsDirty])

  const handleModelInputChange = useCallback((value: string) => {
    setModelInput(value)
    markConnectionAsDirty()
  }, [markConnectionAsDirty])

  const buildAIConfigFromInputs = useCallback((): AIConfig | null => {
    if (!apiKeyInput.trim()) {
      return null
    }
    return {
      apiKey: apiKeyInput.trim(),
      model: modelInput.trim() || DEFAULT_AI_CONFIG.model,
      baseUrl: DEFAULT_AI_CONFIG.baseUrl,
    }
  }, [apiKeyInput, modelInput])

  const handleTestAIConnection = useCallback(async () => {
    const config = buildAIConfigFromInputs()
    if (!config) {
      setAiConnectionStatus('fail')
      setAiConnectionMessage('请先填写有效的 API Key。')
      return
    }

    setAiConnectionStatus('testing')
    setAiConnectionMessage('正在检测 OpenRouter 连通性...')
    setError(null)

    try {
      const result = await testOpenRouterConnection(config)
      setAiConnectionStatus(result.ok ? 'ok' : 'fail')
      setAiConnectionMessage(result.message)
    } catch (err) {
      setAiConnectionStatus('fail')
      setAiConnectionMessage(err instanceof Error ? err.message : String(err))
    }
  }, [buildAIConfigFromInputs])

  /* ---- Game actions ---- */

  function startNewGame(options?: { mode?: GameMode; config?: AIConfig | null }) {
    const resolvedMode = options?.mode ?? gameMode
    const resolvedConfig = options?.config ?? aiConfig
    const gameSeed = Date.now() + Math.floor(Math.random() * 1000)

    managerRef.current?.abort()
    setGameMode(resolvedMode)
    setError(null)
    setActiveChallenge(null)
    setChallengedTrickIndexes([])
    setAiReasons({})
    setOpeningGuide(null)
    setAiThinking(false)
    setThinkingSeat(null)
    setAiPhase(resolvedMode === 'local' ? 'waiting' : 'playing')

    if (resolvedMode === 'ai' && resolvedConfig?.apiKey) {
      const mgr = new GameManager(resolvedConfig, gameSeed, { mode: 'ai' })
      managerRef.current = mgr
      const state = mgr.getState()
      setAiPhase(state.phase)
      setGame(state.game)
      setStepIndex(0)
      setModal('none')
      if (difficulty === 'starter') {
        prepareOpeningGuide(state.game.players[SELF_SEAT], state.game.levelRank)
      }
    } else if (resolvedMode === 'strategy') {
      const mgr = new GameManager(null, gameSeed, { mode: 'strategy' })
      managerRef.current = mgr
      const state = mgr.getState()
      setAiPhase(state.phase)
      setGame(state.game)
      setStepIndex(0)
      setModal('none')
      if (difficulty === 'starter') {
        prepareOpeningGuide(state.game.players[SELF_SEAT], state.game.levelRank)
      }
    } else {
      // Local fallback mode
      managerRef.current = null
      const g = generateGame(gameSeed)
      setGame(g)
      setStepIndex(0)
      setModal('none')
      if (difficulty === 'starter') {
        prepareOpeningGuide(g.players[SELF_SEAT], g.levelRank)
      }

      if (resolvedMode === 'ai') {
        setGameMode('local')
        setError('未检测到可用 AI 配置，已切换为本地模式。')
      }
    }
  }

  async function handleNext() {
    if (activeChallenge || isGameOver || aiThinking || nextStepLockRef.current) return

    nextStepLockRef.current = true

    try {
      if (managerRef.current && isManagedMode) {
        const mgr = managerRef.current

        // If user stepped backward, reveal already-generated actions first.
        const existingState = mgr.getState()
        if (stepIndex < existingState.game.actions.length) {
          const nextStep = Math.min(existingState.game.actions.length, stepIndex + 1)
          const planned = getChallengeForAdvance(
            existingState.game,
            stepIndex,
            nextStep,
            difficulty,
            challengedTrickIndexes,
          )

          startTransition(() => {
            setGame(existingState.game)
            setStepIndex(nextStep)

            if (planned) {
              setChallengedTrickIndexes((v) => [...v, planned.trickIndex])
              setActiveChallenge({
                trickIndex: planned.trickIndex,
                question: planned.question,
                selectedIndex: null,
                isCorrect: null,
              })
            } else if (existingState.phase === 'finished' && nextStep >= existingState.game.actions.length) {
              setModal('result')
            }
          })
          return
        }

        if (existingState.phase === 'finished') {
          setModal('result')
          return
        }

        // AI mode: generate next move
        setAiThinking(true)
        setAiPhase('thinking')
        setThinkingSeat(existingState.currentSeat)
        setError(null)
        try {
          await mgr.playNextMove()
          const state = mgr.getState()
          setAiPhase(state.phase)

          const newGame = state.game
          const newStep = newGame.actions.length
          const latestAction = newGame.actions[newStep - 1] ?? null

          if (latestAction && state.lastAIReason) {
            setAiReasons((prev) => ({
              ...prev,
              [latestAction.index]: state.lastAIReason,
            }))
          }

          // Check for challenge
          const planned = getChallengeForAdvance(
            newGame,
            stepIndex,
            newStep,
            difficulty,
            challengedTrickIndexes,
          )

          startTransition(() => {
            setGame(newGame)
            setStepIndex(newStep)

            if (planned) {
              setChallengedTrickIndexes((v) => [...v, planned.trickIndex])
              setActiveChallenge({
                trickIndex: planned.trickIndex,
                question: planned.question,
                selectedIndex: null,
                isCorrect: null,
              })
            } else if (state.phase === 'finished') {
              setModal('result')
            }
          })
        } catch (err) {
          setAiPhase(mgr.getState().phase)
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setAiThinking(false)
          setThinkingSeat(null)
        }
      } else if (game) {
        // Local mode: step through pre-generated game
        const nextStep = Math.min(game.actions.length, stepIndex + 1)
        const planned = getChallengeForAdvance(game, stepIndex, nextStep, difficulty, challengedTrickIndexes)

        startTransition(() => {
          setStepIndex(nextStep)
          if (planned) {
            setChallengedTrickIndexes((v) => [...v, planned.trickIndex])
            setActiveChallenge({
              trickIndex: planned.trickIndex,
              question: planned.question,
              selectedIndex: null,
              isCorrect: null,
            })
          } else if (nextStep >= game.actions.length) {
            setModal('result')
          }
        })
      }
    } finally {
      nextStepLockRef.current = false
    }
  }

  function handlePrevious() {
    if (activeChallenge || !game || stepIndex <= 0) return
    startTransition(() => setStepIndex((v) => Math.max(0, v - 1)))
  }

  function handleSelectAnswer(index: number) {
    if (!activeChallenge || activeChallenge.selectedIndex !== null) return
    const isCorrect = index === activeChallenge.question.correctIndex
    setActiveChallenge({ ...activeChallenge, selectedIndex: index, isCorrect })
    setStats((v) => {
      const nextStreak = isCorrect ? v.streak + 1 : 0
      return {
        attempted: v.attempted + 1,
        correct: v.correct + (isCorrect ? 1 : 0),
        streak: nextStreak,
        bestStreak: Math.max(v.bestStreak, nextStreak),
      }
    })
  }

  function handleContinueAfterChallenge() {
    if (!activeChallenge || activeChallenge.selectedIndex === null) return
    setActiveChallenge(null)
    if (game && (isManagedMode ? aiPhase === 'finished' && stepIndex >= game.actions.length : stepIndex >= game.actions.length)) {
      setModal('result')
    }
  }

  function handleSaveAIConfig() {
    const config = buildAIConfigFromInputs()
    if (!config) {
      setAiConfig(null)
      setGameMode('local')
      setAiPhase('waiting')
      setAiConnectionStatus('idle')
      setAiConnectionMessage('已切换为本地模式。')
      return
    }

    setAiConfig(config)
    if (gameMode === 'local') {
      setGameMode('ai')
    }
    setAiPhase('playing')
    setAiConnectionStatus('idle')
    setAiConnectionMessage(`已保存 AI 设置：${config.model}`)
  }

  /* ---- Computed display ---- */
  const roundLabel = snapshot?.currentTrick
    ? `第 ${snapshot.currentTrick.index + 1} 轮`
    : snapshot && snapshot.completedTricks.length > 0
      ? `已完成 ${snapshot.completedTricks.length} 轮`
      : '等待开局'
  const roundNumber = snapshot?.currentTrick
    ? snapshot.currentTrick.index + 1
    : snapshot?.completedTricks.length ?? 0

  const allyRemaining = (snapshot?.remainingCounts.south ?? 27) + (snapshot?.remainingCounts.north ?? 27)
  const rivalRemaining = (snapshot?.remainingCounts.west ?? 27) + (snapshot?.remainingCounts.east ?? 27)

  const latestTricks = snapshot?.completedTricks.slice(-5).reverse() ?? []
  const finishedSeats = snapshot
    ? (Object.entries(snapshot.remainingCounts) as Array<[Seat, number]>)
        .filter(([, c]) => c === 0)
        .map(([s]) => s)
    : []
  const ownVisiblePlayReason =
    isManagedMode && snapshot?.lastAction?.seat === SELF_SEAT && snapshot.lastAction.play
      ? aiReasons[snapshot.lastAction.index] ?? ''
      : ''

  const tableNote = aiThinking
    ? `${actingSeat ? SEAT_LABELS[actingSeat] : 'AI'} 正在思考...`
    : isGameOver && game
      ? '本局已结束，可查看战报或开始新牌局。'
      : !game
        ? '点击"新牌局"开始游戏。'
        : snapshot?.lastAction
          ? `${SEAT_LABELS[snapshot.lastAction.seat]} · ${snapshot.lastAction.note}`
          : isManagedMode
            ? `牌局已开始，点击"下一步"让${gameMode === 'ai' ? 'AI' : '本地策略'}出牌。`
            : '整局牌谱已预生成，按"下一步"开始回放。'

  /* ---- Landing screen (no game) ---- */
  if (!game) {
    return (
      <div className="app-root landing">
        <div className="landing-card">
          <div className="landing-icon">🃏</div>
          <h1 className="landing-title">掼蛋记牌训练</h1>
          <p className="landing-sub">AI实时对局 · 本地策略对局 · 预生成回放</p>

          <div className="landing-config">
            <label className="config-label">
              <span>OpenRouter API Key</span>
              <input
                type="password"
                className="config-input"
                placeholder="sk-or-..."
                value={apiKeyInput}
                onChange={(e) => handleApiKeyInputChange(e.target.value)}
              />
            </label>
            <label className="config-label">
              <span>AI模型</span>
              <input
                type="text"
                className="config-input"
                placeholder={DEFAULT_AI_CONFIG.model}
                value={modelInput}
                onChange={(e) => handleModelInputChange(e.target.value)}
              />
            </label>
            <div className="landing-actions">
              <button
                type="button"
                className="ctrl-btn accent"
                onClick={() => {
                  setGameMode('strategy')
                  startNewGame({ mode: 'strategy', config: null })
                }}
              >
                开始策略对局
              </button>
              <button
                type="button"
                className="ctrl-btn"
                onClick={handleTestAIConnection}
                disabled={aiConnectionStatus === 'testing'}
              >
                {aiConnectionStatus === 'testing' ? '检测中...' : '检测连通性'}
              </button>
              <button
                type="button"
                className="ctrl-btn primary"
                disabled={!apiKeyInput.trim()}
                onClick={() => {
                  const config = buildAIConfigFromInputs()
                  if (config) {
                    setAiConfig(config)
                    setGameMode('ai')
                    startNewGame({ mode: 'ai', config })
                  }
                }}
              >
                开始AI对局
              </button>
              <button
                type="button"
                className="ctrl-btn"
                onClick={() => {
                  setAiConfig(buildAIConfigFromInputs())
                  setGameMode('local')
                  startNewGame({ mode: 'local', config: null })
                }}
              >
                开始本地回放
              </button>
            </div>
            {aiConnectionMessage && (
              <p className={`conn-status ${aiConnectionStatus}`}>{aiConnectionMessage}</p>
            )}
            <p className="landing-hint">
              {apiKeyInput.trim()
                ? '可选择 AI 实时对局，或直接进入本地策略对局 / 本地回放。'
                : '未填写 API Key 时，仍可使用本地策略对局和本地预生成回放。'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  /* ---- Main game UI ---- */
  return (
    <div className="app-root">
      {/* Header */}
      <header className="top-bar">
        <div className="hud-left">
          <div className="scoreboard">
            <div className="score-cell ally">
              <span className="score-label">我方</span>
              <strong className="score-value">{allyRemaining}</strong>
            </div>
            <div className="score-cell rival">
              <span className="score-label">对方</span>
              <strong className="score-value">{rivalRemaining}</strong>
            </div>
            <div className="score-cell round-cell">
              <span className="score-label">轮次</span>
              <strong className="score-value">{roundNumber}</strong>
            </div>
          </div>
          <div className="game-info">
            <strong className="app-title">掼蛋记牌台</strong>
            <div className="info-tags">
              <span className="tag">{roundLabel}</span>
              <span className="tag diff-tag">{DIFFICULTY_META[difficulty].label}</span>
              {gameMode === 'ai' && <span className="tag ai-tag">AI</span>}
              {gameMode === 'strategy' && <span className="tag strategy-tag">策略</span>}
              {debugMode && <span className="tag debug-tag">调试</span>}
              {typeof progress === 'number' && progress > 0 && <span className="tag">{progress}%</span>}
            </div>
          </div>
        </div>
        <div className="hud-right">
          <button type="button" className="hdr-btn" onClick={() => setModal(modal === 'settings' ? 'none' : 'settings')}>⚙️</button>
          <button type="button" className="hdr-btn" onClick={() => setModal(modal === 'info' ? 'none' : 'info')}>📋</button>
          {isGameOver && <button type="button" className="hdr-btn glow" onClick={() => setModal('result')}>🏆</button>}
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          <span>⚠️ {error}</span>
          <button type="button" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Table */}
      <section className="table-scene">
        <div className="table-felt">
          <div className="table-level-panel">
            <span className="table-level-kicker">当前级牌</span>
            <strong className="table-level-rank">{rankToText(game.levelRank)}</strong>
            <span className="table-level-wild">红桃{rankToText(game.levelRank)} 为逢人配</span>
          </div>

          {/* Seat badges */}
          {TABLE_SEATS.map((seat) => (
            <SeatBadge
              key={seat}
              seat={seat}
              remaining={snapshot?.remainingCounts[seat] ?? 27}
              position={POSITION_BY_SEAT[seat]}
              isNext={snapshot?.nextSeat === seat && !isGameOver}
              isFinished={finishedSeats.includes(seat)}
              thinking={aiThinking && thinkingSeat === seat}
            />
          ))}

          {/* Play slots */}
          <div className="play-area">
            {TABLE_SEATS.map((seat) => (
              <TablePlaySlot
                key={`${seat}-play`}
                position={POSITION_BY_SEAT[seat]}
                play={currentTrickPlays[seat]}
                levelRank={game.levelRank}
              />
            ))}
          </div>

          {/* Center watermark */}
          <div className="table-center-info">
            <span className="table-note">{tableNote}</span>
          </div>
        </div>
      </section>

      {difficulty === 'starter' && stepIndex === 0 && openingGuide && (
        <section className="opening-guide-panel">
          <div className="opening-guide-head">
            <div>
              <strong>牌面引导</strong>
              <p>以下数量均为场外余量，不含自己手牌。</p>
            </div>
            <span className="opening-guide-badge">场外余量</span>
          </div>
          <div className="opening-guide-list">
            {openingGuide.items.map((item) => (
              <article key={item.label} className="opening-guide-item">
                <span className="opening-guide-label">{item.label}</span>
                <strong className="opening-guide-value">{item.outsideCount} 张</strong>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Hand panel */}
      <section className="hand-panel">
        <div className="hand-head">
          <div className="hand-title-group">
            <h3>手牌</h3>
            {ownVisiblePlayReason && <p className="hand-ai-reason">本家{gameMode === 'ai' ? ' AI ' : '策略'}理由：{ownVisiblePlayReason}</p>}
          </div>
          <span className="hand-count">{ownHand.length} / {game.players[SELF_SEAT].length}</span>
        </div>
        {ownHand.length > 0 ? (
          <HandRack cards={ownHand} levelRank={game.levelRank} />
        ) : (
          <p className="hand-empty">已出完所有牌</p>
        )}
      </section>

      {debugMode && isManagedMode && (
        <section className="debug-panel">
          <div className="debug-head">
            <strong>调试监视器</strong>
            <span>显示四家最近一次可见{gameMode === 'ai' ? ' AI ' : ' 策略 '}理由</span>
          </div>
          <div className="debug-grid">
            {TABLE_SEATS.map((seat) => {
              const action = latestVisibleActionBySeat[seat] ?? null
              const reason = action ? aiReasons[action.index] || '该步未记录理由。' : `尚未看到该座位的${gameMode === 'ai' ? 'AI' : '策略'}动作。`
              return (
                <article key={`debug-${seat}`} className="debug-card">
                  <div className="debug-card-head">
                    <strong>{SEAT_LABELS[seat]}</strong>
                    <span>{action ? action.note : '未行动'}</span>
                  </div>
                  <p>{reason}</p>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {/* Controls */}
      <section className="control-dock">
        <div className="mini-stats">
          <span><strong>{stats.attempted}</strong> 答题</span>
          <span><strong>{accuracy}%</strong> 正确率</span>
          <span><strong>{stats.streak}</strong> 连对</span>
        </div>
        <div className="controls">
          <button type="button" className="ctrl-btn" onClick={handlePrevious} disabled={stepIndex <= 0 || !!activeChallenge}>
            ◀ 上一步
          </button>
          <button type="button" className="ctrl-btn primary" onClick={handleNext} disabled={isGameOver || !!activeChallenge || aiThinking}>
            {aiThinking ? '思考中...' : '下一步 ▶'}
          </button>
          <button type="button" className="ctrl-btn accent" onClick={() => startNewGame()} disabled={aiThinking}>
            新牌局
          </button>
        </div>
      </section>

      {/* Challenge modal */}
      {activeChallenge && (
        <div className="overlay">
          <div className="dialog challenge-dialog">
            <h3>🧠 记牌挑战</h3>
            <div className="challenge-meta">
              <span className="challenge-tag">{challengeTagLabel(activeChallenge.question.tag)}</span>
              <span className="challenge-difficulty">{DIFFICULTY_META[activeChallenge.question.difficulty].label}</span>
            </div>
            <p className="q-prompt">{activeChallenge.question.prompt}</p>
            <div className="choice-grid">
              {activeChallenge.question.options.map((opt, i) => {
                const chosen = activeChallenge.selectedIndex === i
                const correct = activeChallenge.selectedIndex !== null && i === activeChallenge.question.correctIndex
                const wrong = chosen && !activeChallenge.isCorrect
                return (
                  <button
                    type="button"
                    key={`${opt}-${i}`}
                    className={`choice ${chosen ? 'chosen' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`}
                    onClick={() => handleSelectAnswer(i)}
                    disabled={activeChallenge.selectedIndex !== null}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>
            {activeChallenge.selectedIndex !== null && (
              <div className={`result-box ${activeChallenge.isCorrect ? 'ok' : 'fail'}`}>
                <strong>{activeChallenge.isCorrect ? '✓ 正确！' : '✗ 错误'}</strong>
                <p>{activeChallenge.question.explanation}</p>
                <button type="button" className="ctrl-btn primary full" onClick={handleContinueAfterChallenge}>继续</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Settings modal */}
      {modal === 'settings' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head">
              <h3>设置</h3>
              <button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button>
            </div>

            <div className="dialog-section">
              <h4>AI配置</h4>
              <label className="config-label">
                <span>OpenRouter API Key</span>
                <input type="password" className="config-input" placeholder="sk-or-..." value={apiKeyInput} onChange={(e) => handleApiKeyInputChange(e.target.value)} />
              </label>
              <label className="config-label">
                <span>AI模型</span>
                <input type="text" className="config-input" placeholder={DEFAULT_AI_CONFIG.model} value={modelInput} onChange={(e) => handleModelInputChange(e.target.value)} />
              </label>
              <div className="settings-ai-actions">
                <button
                  type="button"
                  className="ctrl-btn small"
                  onClick={handleTestAIConnection}
                  disabled={aiConnectionStatus === 'testing'}
                >
                  {aiConnectionStatus === 'testing' ? '检测中...' : '检测连通性'}
                </button>
                <button type="button" className="ctrl-btn small" onClick={handleSaveAIConfig}>
                  保存AI设置
                </button>
              </div>
              {aiConnectionMessage && (
                <p className={`conn-status ${aiConnectionStatus}`}>{aiConnectionMessage}</p>
              )}
              <p className="settings-hint">
                当前模式: {gameModeLabel(gameMode)}
                {gameMode === 'ai' ? ` (${aiConfig?.model ?? DEFAULT_AI_CONFIG.model})` : ''}
              </p>
            </div>

            <div className="dialog-section">
              <h4>对局模式</h4>
              <div className="diff-list">
                <button type="button" className={`diff-item ${gameMode === 'strategy' ? 'active' : ''}`} onClick={() => startNewGame({ mode: 'strategy', config: null })}>
                  <strong>策略实时对局</strong>
                  <small>每点一次“下一步”，由本地策略实时决策一手。</small>
                </button>
                <button type="button" className={`diff-item ${gameMode === 'ai' ? 'active' : ''}`} onClick={() => startNewGame({ mode: 'ai', config: aiConfig })}>
                  <strong>AI实时对局</strong>
                  <small>使用 OpenRouter 驱动四家逐手出牌。</small>
                </button>
                <button type="button" className={`diff-item ${gameMode === 'local' ? 'active' : ''}`} onClick={() => startNewGame({ mode: 'local', config: null })}>
                  <strong>本地预生成回放</strong>
                  <small>一次性生成完整牌局，再按步回放。</small>
                </button>
              </div>
            </div>

            <div className="dialog-section">
              <h4>题型难度</h4>
              <div className="diff-list">
                {(Object.entries(DIFFICULTY_META) as Array<[Difficulty, (typeof DIFFICULTY_META)[Difficulty]]>).map(([key, meta]) => (
                  <button
                    type="button"
                    key={key}
                    className={`diff-item ${difficulty === key ? 'active' : ''}`}
                    onClick={() => handleDifficultyChange(key)}
                  >
                    <strong>{meta.label}</strong>
                    <small>{meta.summary}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="dialog-section">
              <h4>调试显示</h4>
              <label className="toggle-row">
                <span>调试模式</span>
                <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
              </label>
              <p className="settings-hint">
                开启后会显示四家最近一次可见的 AI / 策略理由，便于排查决策。
              </p>
            </div>

            <div className="dialog-section">
              <h4>训练统计</h4>
              <div className="stat-row">
                <span>已答 {stats.attempted}</span>
                <span>答对 {stats.correct}</span>
                <span>正确率 {accuracy}%</span>
                <span>最佳连对 {stats.bestStreak}</span>
              </div>
              <button type="button" className="ctrl-btn small" onClick={() => setStats(makeFreshStats())}>清空统计</button>
            </div>
          </div>
        </div>
      )}

      {/* Review modal */}
      {modal === 'info' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head">
              <h3>轮次回顾</h3>
              <button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button>
            </div>
            {snapshot?.currentTrick && snapshot.currentTrick.actions.length > 0 && (
              <div className="dialog-section">
                <h4>当前轮</h4>
                <div className="action-flow">
                  {snapshot.currentTrick.actions.map((action) => (
                    <div key={action.index} className="action-item">
                      <span className="action-who">{SEAT_LABELS[action.seat]}</span>
                      <PlayDisplay play={action.play} levelRank={game.levelRank} size="xs" />
                      <span className="action-rem">余{action.handCountAfter}</span>
                      {debugMode && isManagedMode && aiReasons[action.index] && <span className="action-reason">{aiReasons[action.index]}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {latestTricks.length > 0 && (
              <div className="dialog-section">
                <h4>最近完成轮</h4>
                {latestTricks.map((trick) => (
                  <div key={trick.index} className="trick-row">
                    <div className="trick-head">
                      <strong>第 {trick.index + 1} 轮</strong>
                      <span>{SEAT_LABELS[trick.winningSeat ?? trick.leader]} 收轮</span>
                    </div>
                    <div className="action-flow">
                      {trick.actions.map((action) => (
                        <div key={action.index} className="action-item">
                          <span className="action-who">{SEAT_LABELS[action.seat]}</span>
                          <PlayDisplay play={action.play} levelRank={game.levelRank} size="xs" />
                          {debugMode && isManagedMode && aiReasons[action.index] && <span className="action-reason">{aiReasons[action.index]}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {latestTricks.length === 0 && !snapshot?.currentTrick && (
              <p className="empty-hint">至少完成一轮后才有回顾内容。</p>
            )}
          </div>
        </div>
      )}

      {/* Result modal */}
      {modal === 'result' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head">
              <h3>本局总结</h3>
              <button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button>
            </div>
            <div className="dialog-section">
              <h4>完成排名</h4>
              <div className="finish-list">
                {(snapshot?.isComplete ? game.finishOrder : []).map((item) => (
                  <div key={item.seat} className="finish-item">
                    <span className="finish-place">#{item.place}</span>
                    <span>{SEAT_LABELS[item.seat]}</span>
                    <span className="finish-team">{TEAM_LABELS[item.seat]}</span>
                  </div>
                ))}
                {!snapshot?.isComplete && (
                  <p className="empty-hint">
                    游戏进行中。当前剩余：
                    {snapshot
                      ? (Object.entries(snapshot.remainingCounts) as Array<[Seat, number]>)
                          .filter(([, c]) => c > 0)
                          .map(([s, c]) => `${SEAT_LABELS[s]} ${c}张`)
                          .join('、')
                      : '—'}
                  </p>
                )}
              </div>
            </div>
            <div className="dialog-section">
              <h4>训练统计</h4>
              <div className="result-stats">
                <div><span>答题数</span><strong>{stats.attempted}</strong></div>
                <div><span>正确率</span><strong>{accuracy}%</strong></div>
                <div><span>连对</span><strong>{stats.streak}</strong></div>
                <div><span>最佳</span><strong>{stats.bestStreak}</strong></div>
              </div>
            </div>
            <div className="dialog-section">
              <h4>本局信息</h4>
              <p className="meta-text">
                级牌 {rankToText(game.levelRank)} · {SEAT_LABELS[game.startingSeat]}起手 · {game.actions.length}步 · {game.tricks.length}轮
                {gameMode === 'ai' ? ' · AI实时对局' : gameMode === 'strategy' ? ' · 策略实时对局' : ' · 本地预生成回放'}
              </p>
            </div>
            <button type="button" className="ctrl-btn accent full" onClick={() => startNewGame()}>开始新牌局</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
