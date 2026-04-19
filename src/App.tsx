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
import { GameManager } from './lib/guandan/gameManager'
import { DEFAULT_AI_CONFIG, testOpenRouterConnection } from './lib/guandan/aiService'
import type {
  AIConfig,
  Card,
  ChallengeQuestion,
  Difficulty,
  GuandanGame,
  PatternPlay,
  ReplaySnapshot,
  Seat,
} from './lib/guandan/types'
import { CardGroup, PlayingCard, type CardSize } from './components/PlayingCard'
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
}

type ModalKind = 'none' | 'settings' | 'info' | 'result'
type TablePosition = 'top' | 'bottom' | 'left' | 'right'

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const STORAGE_KEY = 'guandan-memory-lab-v2'
const SELF_SEAT: Seat = 'south'
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
  return (
    <div className="hand-scroll">
      <div className="hand-rack hand-rack-flat">
        {cards.map((card) => (
          <div key={card.id} className="hand-card-shell">
            <PlayingCard card={card} levelRank={levelRank} size="md" />
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
  const [aiThinking, setAiThinking] = useState(false)
  const [lastAIReason, setLastAIReason] = useState('')
  const [thinkingSeat, setThinkingSeat] = useState<Seat | null>(null)

  /* ---- AI config ---- */
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(() => persisted?.aiConfig ?? null)
  const [apiKeyInput, setApiKeyInput] = useState(() => persisted?.aiConfig?.apiKey ?? '')
  const [modelInput, setModelInput] = useState(() => persisted?.aiConfig?.model ?? DEFAULT_AI_CONFIG.model)
  const [aiConnectionStatus, setAiConnectionStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [aiConnectionMessage, setAiConnectionMessage] = useState('')

  /* ---- Game mode: 'ai' (live AI) or 'local' (pre-generated) ---- */
  const [gameMode, setGameMode] = useState<'ai' | 'local'>(() => (persisted?.aiConfig?.apiKey ? 'ai' : 'local'))

  /* ---- Refs ---- */
  const managerRef = useRef<GameManager | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---- Derived ---- */
  const snapshot = useMemo(
    () => (game ? buildReplaySnapshot(game, stepIndex) : null),
    [game, stepIndex],
  )
  const progress = !game ? 0 : game.actions.length > 0 ? Math.round((stepIndex / game.actions.length) * 100) : 0
  const accuracy = stats.attempted === 0 ? 0 : Math.round((stats.correct / stats.attempted) * 100)
  const isGameOver = !game || (snapshot?.isComplete ?? false)
  const pressureSeat = snapshot?.currentTrick?.winningSeat ?? snapshot?.currentTrick?.leader ?? snapshot?.nextSeat ?? null
  const ownHand = useMemo(
    () => (game && snapshot ? remainingHandForSeat(game, snapshot, SELF_SEAT) : []),
    [game, snapshot],
  )

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
    debouncedPersist({ difficulty, stats, aiConfig })
  }, [debouncedPersist, difficulty, stats, aiConfig])

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

  function startNewGame(options?: { mode?: 'ai' | 'local'; config?: AIConfig | null }) {
    const resolvedMode = options?.mode ?? gameMode
    const resolvedConfig = options?.config ?? aiConfig

    setError(null)
    setActiveChallenge(null)
    setChallengedTrickIndexes([])
    setLastAIReason('')
    setAiThinking(false)
    setThinkingSeat(null)

    if (resolvedMode === 'ai' && resolvedConfig?.apiKey) {
      const mgr = new GameManager(resolvedConfig)
      managerRef.current = mgr
      const state = mgr.getState()
      setGame(state.game)
      setStepIndex(0)
      setModal('none')
    } else {
      // Local fallback mode
      managerRef.current = null
      const g = generateGame(Date.now() + Math.floor(Math.random() * 1000))
      setGame(g)
      setStepIndex(0)
      setModal('none')

      if (resolvedMode === 'ai') {
        setError('未检测到可用 AI 配置，已切换为本地模式。')
      }
    }
  }

  async function handleNext() {
    if (activeChallenge || isGameOver || aiThinking) return

    if (managerRef.current && gameMode === 'ai') {
      // AI mode: generate next move
      const mgr = managerRef.current
      setAiThinking(true)
      setThinkingSeat(mgr.getState().currentSeat)
      setError(null)
      try {
        await mgr.playNextMove()
        const state = mgr.getState()
        setLastAIReason(state.lastAIReason)

        const newGame = state.game
        const newStep = newGame.actions.length

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
    if (game && stepIndex >= game.actions.length) {
      setModal('result')
    }
  }

  function handleSaveAIConfig() {
    const config = buildAIConfigFromInputs()
    if (!config) {
      setAiConfig(null)
      setGameMode('local')
      setAiConnectionStatus('idle')
      setAiConnectionMessage('已切换为本地模式。')
      return
    }

    setAiConfig(config)
    setGameMode('ai')
    setAiConnectionStatus('idle')
    setAiConnectionMessage(`已保存 AI 设置：${config.model}`)
  }

  /* ---- Computed display ---- */
  const roundLabel = snapshot?.currentTrick
    ? `第 ${snapshot.currentTrick.index + 1} 轮`
    : snapshot && snapshot.completedTricks.length > 0
      ? `已完成 ${snapshot.completedTricks.length} 轮`
      : '等待开局'

  const allyRemaining = (snapshot?.remainingCounts.south ?? 27) + (snapshot?.remainingCounts.north ?? 27)
  const rivalRemaining = (snapshot?.remainingCounts.west ?? 27) + (snapshot?.remainingCounts.east ?? 27)

  const latestTricks = snapshot?.completedTricks.slice(-5).reverse() ?? []
  const finishedSeats = snapshot
    ? (Object.entries(snapshot.remainingCounts) as Array<[Seat, number]>)
        .filter(([, c]) => c === 0)
        .map(([s]) => s)
    : []

  const tableNote = aiThinking
    ? `${pressureSeat ? SEAT_LABELS[pressureSeat] : 'AI'} 正在思考...`
    : lastAIReason
      ? `AI: ${lastAIReason}`
      : isGameOver && game
        ? '本局已结束，可查看战报或开始新牌局。'
        : !game
          ? '点击"新牌局"开始游戏。'
          : snapshot?.lastAction
            ? `${SEAT_LABELS[snapshot.lastAction.seat]} · ${snapshot.lastAction.note}`
            : gameMode === 'ai'
              ? '牌局已开始，点击"下一步"让AI出牌。'
              : '整局牌谱已预生成，按"下一步"开始回放。'

  /* ---- Landing screen (no game) ---- */
  if (!game) {
    return (
      <div className="app-root landing">
        <div className="landing-card">
          <div className="landing-icon">🃏</div>
          <h1 className="landing-title">掼蛋记牌训练</h1>
          <p className="landing-sub">AI驱动的掼蛋牌局回放 · 记牌挑战训练</p>

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
                className="ctrl-btn"
                onClick={handleTestAIConnection}
                disabled={aiConnectionStatus === 'testing'}
              >
                {aiConnectionStatus === 'testing' ? '检测中...' : '检测连通性'}
              </button>
              <button
                type="button"
                className="ctrl-btn primary"
                onClick={() => {
                  const config = buildAIConfigFromInputs()
                  if (config) {
                    setAiConfig(config)
                    setGameMode('ai')
                    startNewGame({ mode: 'ai', config })
                  } else {
                    setAiConfig(null)
                    setGameMode('local')
                    startNewGame({ mode: 'local', config: null })
                  }
                }}
              >
                {apiKeyInput.trim() ? '开始AI对局' : '本地模式开始'}
              </button>
            </div>
            {aiConnectionMessage && (
              <p className={`conn-status ${aiConnectionStatus}`}>{aiConnectionMessage}</p>
            )}
            <p className="landing-hint">
              {apiKeyInput.trim()
                ? '将使用OpenRouter AI驱动四家出牌'
                : '无API Key将使用本地预生成牌局（离线可用）'}
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
              <strong className="score-value">{(snapshot?.completedTricks.length ?? 0) + (snapshot?.currentTrick ? 1 : 0)}</strong>
            </div>
          </div>
          <div className="game-info">
            <strong className="app-title">掼蛋记牌台</strong>
            <div className="info-tags">
              <span className="tag">{roundLabel}</span>
              <span className="tag level-tag">级牌 {rankToText(game.levelRank)}</span>
              <span className="tag diff-tag">{DIFFICULTY_META[difficulty].label}</span>
              {gameMode === 'ai' && <span className="tag ai-tag">AI</span>}
              {progress > 0 && <span className="tag">{progress}%</span>}
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

      {/* Hand panel */}
      <section className="hand-panel">
        <div className="hand-head">
          <h3>手牌</h3>
          <span className="hand-count">{ownHand.length} / {game.players[SELF_SEAT].length}</span>
        </div>
        {ownHand.length > 0 ? (
          <HandRack cards={ownHand} levelRank={game.levelRank} />
        ) : (
          <p className="hand-empty">已出完所有牌</p>
        )}
      </section>

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
                {aiConfig?.apiKey ? `当前模式: AI (${aiConfig.model})` : '当前模式: 本地离线'}
              </p>
            </div>

            <div className="dialog-section">
              <h4>题型难度</h4>
              <div className="diff-list">
                {(Object.entries(DIFFICULTY_META) as Array<[Difficulty, (typeof DIFFICULTY_META)[Difficulty]]>).map(([key, meta]) => (
                  <button
                    type="button"
                    key={key}
                    className={`diff-item ${difficulty === key ? 'active' : ''}`}
                    onClick={() => setDifficulty(key)}
                  >
                    <strong>{meta.label}</strong>
                    <small>{meta.summary}</small>
                  </button>
                ))}
              </div>
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
                {gameMode === 'ai' ? ' · AI驱动' : ' · 本地模式'}
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
