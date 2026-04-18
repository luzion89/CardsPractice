import { startTransition, useEffect, useState } from 'react'
import { getChallengeForAdvance } from './lib/guandan/challenges'
import {
  buildReplaySnapshot,
  DIFFICULTY_META,
  generateGame,
  rankToText,
  SEAT_LABELS,
  TEAM_LABELS,
} from './lib/guandan/engine'
import type { ChallengeQuestion, Difficulty, GuandanGame, PatternPlay, Seat } from './lib/guandan/types'
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

const STORAGE_KEY = 'guandan-memory-lab-v1'

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

/* Render a play as card group or pass text */
function PlayDisplay({ play, levelRank, size = 'sm' }: { play: PatternPlay | null; levelRank: number; size?: 'sm' | 'md' }) {
  if (!play) return <span className="pass-text">过</span>
  return <CardGroup cards={play.cards} levelRank={levelRank} size={size} />
}

/* ─── Seat on the table ────────────────────────────────── */
function SeatArea({
  seat, remaining, isNext, lastPlay, isFinished, levelRank, position,
}: {
  seat: Seat; remaining: number; isNext: boolean; lastPlay: PatternPlay | null | undefined
  isFinished: boolean; levelRank: number; position: 'top' | 'bottom' | 'left' | 'right'
}) {
  const teamClass = seat === 'south' || seat === 'north' ? 'team-ns' : 'team-ew'
  return (
    <div className={`seat-area ${position} ${teamClass} ${isNext ? 'is-next' : ''} ${isFinished ? 'is-finished' : ''}`}>
      <div className="seat-label">
        <span className="seat-name">{SEAT_LABELS[seat]}</span>
        <span className="seat-remain">{remaining}张</span>
        {isNext && <span className="badge-next">▶</span>}
        {isFinished && <span className="badge-done">✓</span>}
      </div>
      <div className="seat-play">
        {lastPlay !== undefined ? <PlayDisplay play={lastPlay} levelRank={levelRank} /> : null}
      </div>
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
  const leadSeat = snapshot.currentTrick?.winningSeat ?? snapshot.currentTrick?.leader ?? null
  const tableNote = isGameOver
    ? '本局牌谱已经封盘，可以打开战报复盘排名与答题表现。'
    : snapshot.lastAction
      ? `${SEAT_LABELS[snapshot.lastAction.seat]} · ${snapshot.lastAction.note}`
      : '系统已预生成整局合法牌谱；每轮收轮后都会暂停提问 1 题。'

  // Current trick plays per seat
  const currentTrickPlays: Partial<Record<Seat, PatternPlay | null>> = {}
  if (snapshot.currentTrick) {
    for (const action of snapshot.currentTrick.actions) {
      currentTrickPlays[action.seat] = action.play
    }
  }

  // Latest completed tricks for the modal
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
    setStepIndex((v) => Math.max(0, v - 1))
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
      setChallengedTrickIndexes((v) => [...v, plannedChallenge.trickIndex])
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
          <p className="title-copy">用完整牌局回放训练轮次感、牌型记忆与大牌去向判断；每轮收轮后都会立即检索一次。</p>
        </div>
        <div className="toolbar-block">
          <div className="table-badges">
            <span className="tag level-focus-tag">本局级牌 {rankToText(game.levelRank)}</span>
            <span className="tag">{SEAT_LABELS[game.startingSeat]}起手</span>
            <span className="tag">#{game.seed.toString(36).slice(-6)}</span>
          </div>
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
        <div className="table-felt">
          <SeatArea seat="north" remaining={snapshot.remainingCounts.north} position="top"
            isNext={snapshot.nextSeat === 'north' && !isGameOver}
            lastPlay={currentTrickPlays.north}
            isFinished={finishedSeats.includes('north')} levelRank={game.levelRank} />
          <SeatArea seat="west" remaining={snapshot.remainingCounts.west} position="left"
            isNext={snapshot.nextSeat === 'west' && !isGameOver}
            lastPlay={currentTrickPlays.west}
            isFinished={finishedSeats.includes('west')} levelRank={game.levelRank} />
          <SeatArea seat="east" remaining={snapshot.remainingCounts.east} position="right"
            isNext={snapshot.nextSeat === 'east' && !isGameOver}
            lastPlay={currentTrickPlays.east}
            isFinished={finishedSeats.includes('east')} levelRank={game.levelRank} />
          <SeatArea seat="south" remaining={snapshot.remainingCounts.south} position="bottom"
            isNext={snapshot.nextSeat === 'south' && !isGameOver}
            lastPlay={currentTrickPlays.south}
            isFinished={finishedSeats.includes('south')} levelRank={game.levelRank} />

          <div className="table-center">
            <div className="center-medallion">
              {isGameOver ? (
                <span className="center-msg over">本局结束</span>
              ) : snapshot.currentTrick ? (
                <>
                  <span className="center-round">第 {snapshot.currentTrick.index + 1} 轮</span>
                  <span className="center-step">{snapshot.stepIndex}/{game.actions.length}</span>
                </>
              ) : (
                <span className="center-msg">准备开始</span>
              )}
              {leadSeat ? <span className="center-owner">当前压桌：{SEAT_LABELS[leadSeat]}</span> : null}
            </div>
            <p className="table-note">{tableNote}</p>
          </div>
        </div>

        <div className="progress-container">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </section>

      <section className="control-dock">
        <div className="mini-stats">
          <span><strong>{stats.attempted}</strong> 题</span>
          <span><strong>{accuracy}%</strong> 正确率</span>
          <span><strong>{stats.streak}</strong> 连对</span>
          <span><strong>{progress}%</strong> 进度</span>
        </div>

        <section className="controls">
          <button type="button" className="ctrl-btn" onClick={handlePrevious} disabled={snapshot.stepIndex <= 0 || !!activeChallenge}>上一步</button>
          <button type="button" className="ctrl-btn primary" onClick={handleNext} disabled={isGameOver || !!activeChallenge}>下一步</button>
          <button type="button" className="ctrl-btn" onClick={handleEndGame} disabled={isGameOver}>结束</button>
          <button type="button" className="ctrl-btn accent" onClick={handleNewGame}>新牌局</button>
        </section>
      </section>

      {/* ══════ Challenge Overlay ══════ */}
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
              {activeChallenge.question.options.map((opt, i) => {
                const chosen = activeChallenge.selectedIndex === i
                const correct = activeChallenge.selectedIndex !== null && i === activeChallenge.question.correctIndex
                const wrong = chosen && !activeChallenge.isCorrect
                return (
                  <button key={`${opt}-${i}`} className={`choice ${chosen ? 'chosen' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`}
                    onClick={() => handleSelectAnswer(i)} disabled={activeChallenge.selectedIndex !== null}>
                    {opt}
                  </button>
                )
              })}
            </div>
            {activeChallenge.selectedIndex !== null && (
              <div className={`result-box ${activeChallenge.isCorrect ? 'ok' : 'fail'}`}>
                <strong>{activeChallenge.isCorrect ? '✓ 正确' : '✗ 错误'}</strong>
                <p>{activeChallenge.question.explanation}</p>
                <button className="ctrl-btn primary full" onClick={handleContinueAfterChallenge}>继续</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════ Settings Modal ══════ */}
      {modal === 'settings' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>训练设置</h3><button className="close-btn" onClick={() => setModal('none')}>✕</button></div>
            <div className="dialog-section compact-top">
              <h4>题型难度</h4>
              <p className="settings-copy">当前为 {DIFFICULTY_META[difficulty].label}。入门难度下，如果本轮出现 A、K、王或级牌，收轮后会优先追问对应剩余张数。</p>
            </div>
            <div className="diff-list">
              {(Object.entries(DIFFICULTY_META) as Array<[Difficulty, (typeof DIFFICULTY_META)[Difficulty]]>).map(([key, meta]) => (
                <button key={key} className={`diff-item ${difficulty === key ? 'active' : ''}`}
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
              <button className="ctrl-btn small" onClick={() => setStats(makeFreshStats())}>清空统计</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ Info (trick history) Modal ══════ */}
      {modal === 'info' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>轮次回顾</h3><button className="close-btn" onClick={() => setModal('none')}>✕</button></div>
            {snapshot.currentTrick && snapshot.currentTrick.actions.length > 0 && (
              <div className="dialog-section">
                <h4>当前轮</h4>
                <div className="action-flow">
                  {snapshot.currentTrick.actions.map((a) => (
                    <div key={a.index} className="action-item">
                      <span className="action-who">{SEAT_LABELS[a.seat]}</span>
                      <PlayDisplay play={a.play} levelRank={game.levelRank} size="sm" />
                      <span className="action-rem">余{a.handCountAfter}</span>
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
                      {trick.actions.map((a) => (
                        <div key={a.index} className="action-item">
                          <span className="action-who">{SEAT_LABELS[a.seat]}</span>
                          <PlayDisplay play={a.play} levelRank={game.levelRank} size="sm" />
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

      {/* ══════ Result Modal ══════ */}
      {modal === 'result' && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal('none') }}>
          <div className="dialog">
            <div className="dialog-head"><h3>本局总结</h3><button className="close-btn" onClick={() => setModal('none')}>✕</button></div>
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
                      .filter(([, c]) => c > 0).map(([s, c]) => `${SEAT_LABELS[s]} ${c}张`).join('、')}</p>
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
            <button className="ctrl-btn accent full" onClick={handleNewGame}>开始新牌局</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
