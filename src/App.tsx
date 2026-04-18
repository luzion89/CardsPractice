import { startTransition, useEffect, useState } from 'react'
import { getChallengeForAdvance } from './lib/guandan/challenges'
import {
  buildReplaySnapshot,
  DIFFICULTY_META,
  generateGame,
  powerValue,
  rankToText,
  SEAT_LABELS,
  TEAM_LABELS,
} from './lib/guandan/engine'
import type {
  Card,
  ChallengeQuestion,
  Difficulty,
  GuandanGame,
  PatternPlay,
  ReplaySnapshot,
  Seat,
  Suit,
} from './lib/guandan/types'
import { CardGroup } from './components/PlayingCard'
import './App.css'

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
  game: GuandanGame
  stepIndex: number
  difficulty: Difficulty
  challengedTrickIndexes: number[]
  stats: TrainingStats
  endedManually: boolean
}

type ModalKind = 'none' | 'settings' | 'info' | 'result'
type TablePosition = 'top' | 'bottom' | 'left' | 'right'

const STORAGE_KEY = 'guandan-memory-lab-v1'
const SELF_SEAT: Seat = 'south'
const SUIT_ORDER: Record<Suit, number> = {
  clubs: 0,
  diamonds: 1,
  spades: 2,
  hearts: 3,
  black: 4,
  red: 5,
}
const POSITION_BY_SEAT: Record<Seat, TablePosition> = {
  north: 'top',
  west: 'left',
  east: 'right',
  south: 'bottom',
}
const TABLE_SEATS: Seat[] = ['north', 'west', 'east', 'south']

function challengeTagLabel(tag: string) {
  switch (tag) {
    case 'focus-count':
      return '重点计数'
    case 'last-trick-pattern':
    case 'last-trick-winner':
      return '立即回忆'
    case 'big-card-count':
    case 'wild-count':
    case 'any-rank-count':
      return '全局计数'
    case 'recent-trick-detail':
      return '延迟回忆'
    case 'partner-awareness':
      return '搭档判断'
    default:
      return '轮次检索'
  }
}

function loadPersistedState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PersistedState
  } catch {
    return null
  }
}

function makeFreshStats(): TrainingStats {
  return { attempted: 0, correct: 0, streak: 0, bestStreak: 0 }
}

function makeFreshGame() {
  return generateGame(Date.now() + Math.floor(Math.random() * 1000))
}

function persist(state: PersistedState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function sortHandCards(cards: Card[], levelRank: number) {
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

function remainingHandForSeat(game: GuandanGame, snapshot: ReplaySnapshot, seat: Seat) {
  const playedCardIds = new Set(
    snapshot.visibleActions
      .filter((action) => action.seat === seat)
      .flatMap((action) => action.play?.cards ?? [])
      .map((card) => card.id),
  )

  return sortHandCards(
    game.players[seat].filter((card) => !playedCardIds.has(card.id)),
    game.levelRank,
  )
}

function PlayDisplay({ play, levelRank, size = 'sm' }: { play: PatternPlay | null; levelRank: number; size?: 'sm' | 'md' }) {
  if (!play) return <span className="pass-text">过</span>
  return <CardGroup cards={play.cards} levelRank={levelRank} size={size} />
}

function SeatBadge({
  seat,
  remaining,
  isNext,
  isFinished,
  position,
}: {
  seat: Seat
  remaining: number
  isNext: boolean
  isFinished: boolean
  position: TablePosition
}) {
  const teamClass = seat === 'south' || seat === 'north' ? 'team-ns' : 'team-ew'
  const metaText = isFinished ? '已出完' : `剩余 ${remaining} 张`

  return (
    <div className={`seat-badge ${position} ${teamClass} ${isNext ? 'is-next' : ''} ${isFinished ? 'is-finished' : ''}`}>
      <span className="seat-role">{SEAT_LABELS[seat]}</span>
      <span className="seat-meta">{metaText}</span>
      {isNext ? <span className="seat-status">轮到出牌</span> : null}
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
  if (play === undefined) {
    return null
  }

  const displaySize = position === 'left' || position === 'right' ? 'sm' : 'md'

  return (
    <div className={`table-play-slot ${position} ${play ? 'has-play' : 'is-pass'}`}>
      <PlayDisplay play={play} levelRank={levelRank} size={displaySize} />
    </div>
  )
}

function App() {
  const persisted = loadPersistedState()
  const [game, setGame] = useState<GuandanGame>(() => persisted?.game ?? makeFreshGame())
  const [stepIndex, setStepIndex] = useState(() => persisted?.stepIndex ?? 0)
  const [difficulty, setDifficulty] = useState<Difficulty>(() => persisted?.difficulty ?? 'starter')
  const [challengedTrickIndexes, setChallengedTrickIndexes] = useState<number[]>(() => persisted?.challengedTrickIndexes ?? [])
  const [stats, setStats] = useState<TrainingStats>(() => persisted?.stats ?? makeFreshStats())
  const [endedManually, setEndedManually] = useState(() => persisted?.endedManually ?? false)
  const [activeChallenge, setActiveChallenge] = useState<ActiveChallenge | null>(null)
  const [modal, setModal] = useState<ModalKind>('none')

  const snapshot = buildReplaySnapshot(game, stepIndex)
  const progress = game.actions.length === 0 ? 0 : Math.round((snapshot.stepIndex / game.actions.length) * 100)
  const accuracy = stats.attempted === 0 ? 0 : Math.round((stats.correct / stats.attempted) * 100)
  const isGameOver = snapshot.isComplete || endedManually
  const pressureSeat = snapshot.currentTrick?.winningSeat ?? snapshot.currentTrick?.leader ?? snapshot.nextSeat ?? null
  const roundLabel = snapshot.currentTrick
    ? `第 ${snapshot.currentTrick.index + 1} 轮`
    : snapshot.completedTricks.length > 0
      ? `已完成 ${snapshot.completedTricks.length} 轮`
      : '等待开局'
  const tableNote = isGameOver
    ? '本局牌谱已经封盘，可以打开战报查看排名与答题表现。'
    : snapshot.lastAction
      ? `${SEAT_LABELS[snapshot.lastAction.seat]} · ${snapshot.lastAction.note}`
      : '整局合法牌谱已预生成，按“下一步”开始回放。'
  const ownHand = remainingHandForSeat(game, snapshot, SELF_SEAT)

  const currentTrickPlays: Partial<Record<Seat, PatternPlay | null>> = {}
  if (snapshot.currentTrick) {
    for (const action of snapshot.currentTrick.actions) {
      currentTrickPlays[action.seat] = action.play
    }
  }

  const latestTricks = snapshot.completedTricks.slice(-5).reverse()
  const finishedSeats = (Object.entries(snapshot.remainingCounts) as Array<[Seat, number]>)
    .filter(([, count]) => count === 0)
    .map(([seat]) => seat)

  useEffect(() => {
    persist({ game, stepIndex: snapshot.stepIndex, difficulty, challengedTrickIndexes, stats, endedManually })
  }, [challengedTrickIndexes, difficulty, endedManually, game, snapshot.stepIndex, stats])

  function handleNewGame() {
    startTransition(() => {
      setGame(makeFreshGame())
      setStepIndex(0)
      setChallengedTrickIndexes([])
      setEndedManually(false)
      setActiveChallenge(null)
      setModal('none')
    })
  }

  function handleEndGame() {
    setEndedManually(true)
    setActiveChallenge(null)
    setModal('result')
  }

  function handlePrevious() {
    if (activeChallenge || snapshot.stepIndex <= 0) return
    setStepIndex((value) => Math.max(0, value - 1))
  }

  function handleNext() {
    if (activeChallenge || endedManually || snapshot.isComplete) return

    const nextStep = Math.min(game.actions.length, snapshot.stepIndex + 1)
    const plannedChallenge = getChallengeForAdvance(
      game,
      snapshot.stepIndex,
      nextStep,
      difficulty,
      challengedTrickIndexes,
    )

    setStepIndex(nextStep)

    if (plannedChallenge) {
      setChallengedTrickIndexes((value) => [...value, plannedChallenge.trickIndex])
      setActiveChallenge({
        trickIndex: plannedChallenge.trickIndex,
        question: plannedChallenge.question,
        selectedIndex: null,
        isCorrect: null,
      })
      return
    }

    if (nextStep >= game.actions.length) {
      setModal('result')
    }
  }

  function handleSelectAnswer(index: number) {
    if (!activeChallenge || activeChallenge.selectedIndex !== null) return
    const isCorrect = index === activeChallenge.question.correctIndex
    setActiveChallenge({ ...activeChallenge, selectedIndex: index, isCorrect })
    setStats((value) => {
      const nextStreak = isCorrect ? value.streak + 1 : 0
      return {
        attempted: value.attempted + 1,
        correct: value.correct + (isCorrect ? 1 : 0),
        streak: nextStreak,
        bestStreak: Math.max(value.bestStreak, nextStreak),
      }
    })
  }

  function handleContinueAfterChallenge() {
    if (!activeChallenge || activeChallenge.selectedIndex === null) return
    setActiveChallenge(null)
    if (stepIndex >= game.actions.length) {
      setModal('result')
    }
  }

  return (
    <div className="app-root">
      <header className="top-bar">
        <div className="title-block">
          <span className="kicker">MEMORY TABLE</span>
          <div className="title-row">
            <strong className="app-title">掼蛋记牌台</strong>
            <span className="difficulty-chip">{DIFFICULTY_META[difficulty].label}</span>
          </div>
          <p className="title-copy">保留真实牌桌视角：桌中只看出牌，自己的手牌常驻底部，挑战与统计退到边缘和弹窗。</p>
        </div>
        <div className="toolbar-block">
          <div className="top-right">
            <button type="button" className="top-action" onClick={() => setModal(modal === 'settings' ? 'none' : 'settings')}>
              设置
            </button>
            <button type="button" className="top-action" onClick={() => setModal(modal === 'info' ? 'none' : 'info')}>
              回顾
            </button>
            {isGameOver ? (
              <button type="button" className="top-action accent-glow" onClick={() => setModal('result')}>
                战报
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <section className="table-scene">
        <div className="scene-head">
          <div className="scene-copy">
            <span className="scene-title">回放牌桌</span>
            <p>{isGameOver ? '牌局已结束，可以回看最近轮次或直接开新局。' : '四家座位改为自己 / 上家 / 下家 / 对家，牌桌中心只保留真正的出牌位置。'}</p>
          </div>
          <div className="scene-pills">
            <span className="tag">{roundLabel}</span>
            <span className="tag">{pressureSeat ? `${SEAT_LABELS[pressureSeat]}掌牌` : '等待领牌'}</span>
            <span className="tag">{SEAT_LABELS[game.startingSeat]}起手</span>
            <span className="tag">#{game.seed.toString(36).slice(-6)}</span>
          </div>
        </div>

        <div className="table-stage">
          {TABLE_SEATS.map((seat) => (
            <SeatBadge
              key={seat}
              seat={seat}
              remaining={snapshot.remainingCounts[seat]}
              position={POSITION_BY_SEAT[seat]}
              isNext={snapshot.nextSeat === seat && !isGameOver}
              isFinished={finishedSeats.includes(seat)}
            />
          ))}

          <div className="table-felt">
            <span className="table-level-badge">级牌 {rankToText(game.levelRank)}</span>
            <div className="table-orbit" />
            {TABLE_SEATS.map((seat) => (
              <TablePlaySlot
                key={`${seat}-play`}
                position={POSITION_BY_SEAT[seat]}
                play={currentTrickPlays[seat]}
                levelRank={game.levelRank}
              />
            ))}
          </div>
        </div>

        <div className="table-status-row">
          <p className="table-status">{tableNote}</p>
          <div className="progress-block">
            <span className="progress-label">牌局进度 {progress}%</span>
            <div className="progress-container">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <section className="hand-panel">
          <div className="hand-head">
            <div>
              <span className="hand-kicker">自己的视角</span>
              <h3 className="hand-title">我的本局手牌</h3>
              <p className="hand-copy">
                {ownHand.length > 0 ? '这排手牌会随回放实时扣除已打出的牌，方便你一边看桌面一边对照记牌。' : '这一局里，你的 27 张牌已经全部打完。'}
              </p>
            </div>
            <span className="hand-count">{ownHand.length}/{game.players[SELF_SEAT].length} 张</span>
          </div>
          {ownHand.length > 0 ? (
            <div className="hand-scroll">
              <CardGroup cards={ownHand} levelRank={game.levelRank} size="md" />
            </div>
          ) : (
            <p className="hand-empty">当前自己已经出完所有牌，可以直接看战报或重新开一局。</p>
          )}
        </section>
      </section>

      <section className="control-dock">
        <div className="mini-stats">
          <span><strong>{stats.attempted}</strong> 已答题</span>
          <span><strong>{accuracy}%</strong> 正确率</span>
          <span><strong>{stats.streak}</strong> 当前连对</span>
          <span><strong>{snapshot.completedTricks.length}</strong> 已收轮</span>
        </div>

        <section className="controls">
          <button type="button" className="ctrl-btn" onClick={handlePrevious} disabled={snapshot.stepIndex <= 0 || !!activeChallenge}>上一步</button>
          <button type="button" className="ctrl-btn primary" onClick={handleNext} disabled={isGameOver || !!activeChallenge}>下一步</button>
          <button type="button" className="ctrl-btn" onClick={handleEndGame} disabled={isGameOver}>结束</button>
          <button type="button" className="ctrl-btn accent" onClick={handleNewGame}>新牌局</button>
        </section>
      </section>

      {activeChallenge && (
        <div className="overlay">
          <div className="dialog challenge-dialog">
            <h3>记牌挑战</h3>
            <div className="challenge-meta">
              <p className="challenge-tag">{challengeTagLabel(activeChallenge.question.tag)} · 第 {activeChallenge.trickIndex + 1} 轮后暂停</p>
              <p className="challenge-difficulty">题型难度 · {DIFFICULTY_META[activeChallenge.question.difficulty].label}</p>
            </div>
            <p className="q-prompt">{activeChallenge.question.prompt}</p>
            <div className="choice-grid">
              {activeChallenge.question.options.map((option, index) => {
                const chosen = activeChallenge.selectedIndex === index
                const correct = activeChallenge.selectedIndex !== null && index === activeChallenge.question.correctIndex
                const wrong = chosen && !activeChallenge.isCorrect
                return (
                  <button
                    type="button"
                    key={`${option}-${index}`}
                    className={`choice ${chosen ? 'chosen' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`}
                    onClick={() => handleSelectAnswer(index)}
                    disabled={activeChallenge.selectedIndex !== null}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
            {activeChallenge.selectedIndex !== null && (
              <div className={`result-box ${activeChallenge.isCorrect ? 'ok' : 'fail'}`}>
                <strong>{activeChallenge.isCorrect ? '✓ 正确' : '✗ 错误'}</strong>
                <p>{activeChallenge.question.explanation}</p>
                <button type="button" className="ctrl-btn primary full" onClick={handleContinueAfterChallenge}>继续</button>
              </div>
            )}
          </div>
        </div>
      )}

      {modal === 'settings' && (
        <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>训练设置</h3><button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button></div>
            <div className="dialog-section compact-top">
              <h4>题型难度</h4>
              <p className="settings-copy">当前为 {DIFFICULTY_META[difficulty].label}。入门难度下，如果本轮出现 A、K、王或级牌，收轮后会优先追问对应剩余张数。</p>
            </div>
            <div className="diff-list">
              {(Object.entries(DIFFICULTY_META) as Array<[Difficulty, (typeof DIFFICULTY_META)[Difficulty]]>).map(([key, meta]) => (
                <button type="button" key={key} className={`diff-item ${difficulty === key ? 'active' : ''}`}
                  onClick={() => setDifficulty(key)}>
                  <strong>{meta.label}</strong>
                  <small>{meta.summary}</small>
                </button>
              ))}
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

      {modal === 'info' && (
        <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>轮次回顾</h3><button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button></div>
            {snapshot.currentTrick && snapshot.currentTrick.actions.length > 0 && (
              <div className="dialog-section">
                <h4>当前轮</h4>
                <div className="action-flow">
                  {snapshot.currentTrick.actions.map((action) => (
                    <div key={action.index} className="action-item">
                      <span className="action-who">{SEAT_LABELS[action.seat]}</span>
                      <PlayDisplay play={action.play} levelRank={game.levelRank} size="sm" />
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
                          <PlayDisplay play={action.play} levelRank={game.levelRank} size="sm" />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {latestTricks.length === 0 && !snapshot.currentTrick && (
              <p className="empty-hint">至少看完一轮后才有回顾内容。</p>
            )}
          </div>
        </div>
      )}

      {modal === 'result' && (
        <div className="overlay" onClick={(event) => { if (event.target === event.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>本局总结</h3><button type="button" className="close-btn" onClick={() => setModal('none')}>✕</button></div>
            <div className="dialog-section">
              <h4>完成排名</h4>
              <div className="finish-list">
                {(snapshot.isComplete ? game.finishOrder : []).map((item) => (
                  <div key={item.seat} className="finish-item">
                    <span className="finish-place">#{item.place}</span>
                    <span>{SEAT_LABELS[item.seat]}</span>
                    <span className="finish-team">{TEAM_LABELS[item.seat]}</span>
                  </div>
                ))}
                {!snapshot.isComplete && (
                  <p className="empty-hint">手动结束，未产生完整排名。当前剩余：
                    {(Object.entries(snapshot.remainingCounts) as Array<[Seat, number]>)
                      .filter(([, count]) => count > 0).map(([seat, count]) => `${SEAT_LABELS[seat]} ${count}张`).join('、')}</p>
                )}
              </div>
            </div>
            <div className="dialog-section">
              <h4>训练统计</h4>
              <div className="result-stats">
                <div><span>答题数</span><strong>{stats.attempted}</strong></div>
                <div><span>正确率</span><strong>{accuracy}%</strong></div>
                <div><span>当前连对</span><strong>{stats.streak}</strong></div>
                <div><span>最佳连对</span><strong>{stats.bestStreak}</strong></div>
              </div>
            </div>
            <div className="dialog-section">
              <h4>本局信息</h4>
              <p className="meta-text">级牌 {rankToText(game.levelRank)} · {SEAT_LABELS[game.startingSeat]}起手 · {game.actions.length}步 · {game.tricks.length}轮 · #{game.seed.toString(36).slice(-6)}</p>
            </div>
            <button type="button" className="ctrl-btn accent full" onClick={handleNewGame}>开始新牌局</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App