import type { Card } from '../lib/guandan/types'
import { isWildCard, rankToText } from '../lib/guandan/engine'

/* ------------------------------------------------------------------ */
/*  Visual config                                                      */
/* ------------------------------------------------------------------ */

const SUIT_STYLE: Record<string, { symbol: string; color: string }> = {
  spades:   { symbol: '♠', color: '#1a1a2e' },
  hearts:   { symbol: '♥', color: '#c0392b' },
  diamonds: { symbol: '♦', color: '#c0392b' },
  clubs:    { symbol: '♣', color: '#1a1a2e' },
  black:    { symbol: '★', color: '#1a1a2e' },
  red:      { symbol: '★', color: '#c0392b' },
}

/* Card dimensions per size preset */
const SIZES = {
  xs: { w: 36, h: 52, rankFs: 11, suitFs: 10, centerFs: 18, gap: 1, r: 4, pad: 3 },
  sm: { w: 46, h: 66, rankFs: 13, suitFs: 12, centerFs: 22, gap: 2, r: 5, pad: 4 },
  md: { w: 60, h: 86, rankFs: 15, suitFs: 14, centerFs: 28, gap: 2, r: 6, pad: 5 },
  lg: { w: 72, h: 102, rankFs: 17, suitFs: 16, centerFs: 32, gap: 3, r: 7, pad: 6 },
} as const

export type CardSize = keyof typeof SIZES

/* ------------------------------------------------------------------ */
/*  Card back (face-down)                                              */
/* ------------------------------------------------------------------ */

export function CardBack({ size = 'md' }: { size?: CardSize }) {
  const s = SIZES[size]
  return (
    <div
      className="card-back"
      style={{
        width: s.w,
        height: s.h,
        borderRadius: s.r,
      }}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Single card face                                                   */
/* ------------------------------------------------------------------ */

interface PlayingCardProps {
  card: Card
  levelRank: number
  size?: CardSize
  dimmed?: boolean
}

export function PlayingCard({ card, levelRank, size = 'md', dimmed }: PlayingCardProps) {
  const s = SIZES[size]
  const info = SUIT_STYLE[card.suit] ?? SUIT_STYLE.spades
  const isJoker = card.rank === 16 || card.rank === 17
  const isWild = isWildCard(card, levelRank)
  const isLevel = card.rank === levelRank && !isJoker
  const label = rankToText(card.rank)

  const borderColor = isWild ? '#e6a817' : isLevel ? '#d4a017' : '#bbb'
  const bgColor = isWild ? '#fffbe6' : isLevel ? '#fffde8' : '#fff'

  const cls = [
    'playing-card',
    isJoker ? 'joker' : '',
    isWild ? 'wild' : '',
    isLevel ? 'level' : '',
    dimmed ? 'dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  if (isJoker) {
    const jLabel = card.rank === 17 ? '大' : '小'
    const jSub = card.rank === 17 ? '王' : '王'
    return (
      <div
        className={cls}
        style={{
          width: s.w,
          height: s.h,
          borderRadius: s.r,
          borderColor,
          background: bgColor,
        }}
      >
        <span className="card-corner top-left" style={{ color: info.color }}>
          <span className="card-rank" style={{ fontSize: s.rankFs }}>{jLabel}</span>
          <span className="card-suit-small" style={{ fontSize: s.suitFs }}>{info.symbol}</span>
        </span>
        <span className="card-center" style={{ color: info.color, fontSize: s.centerFs * 1.1 }}>
          {jLabel}{jSub}
        </span>
        <span className="card-corner bottom-right" style={{ color: info.color }}>
          <span className="card-rank" style={{ fontSize: s.rankFs }}>{jLabel}</span>
          <span className="card-suit-small" style={{ fontSize: s.suitFs }}>{info.symbol}</span>
        </span>
        {isWild && <span className="card-badge wild-badge">配</span>}
      </div>
    )
  }

  return (
    <div
      className={cls}
      style={{
        width: s.w,
        height: s.h,
        borderRadius: s.r,
        borderColor,
        background: bgColor,
      }}
    >
      <span className="card-corner top-left" style={{ color: info.color }}>
        <span className="card-rank" style={{ fontSize: s.rankFs }}>{label}</span>
        <span className="card-suit-small" style={{ fontSize: s.suitFs }}>{info.symbol}</span>
      </span>
      <span className="card-center" style={{ color: info.color, fontSize: s.centerFs }}>
        {info.symbol}
      </span>
      <span className="card-corner bottom-right" style={{ color: info.color }}>
        <span className="card-rank" style={{ fontSize: s.rankFs }}>{label}</span>
        <span className="card-suit-small" style={{ fontSize: s.suitFs }}>{info.symbol}</span>
      </span>
      {isWild && <span className="card-badge wild-badge">配</span>}
      {isLevel && !isWild && <span className="card-badge level-badge">级</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Card group (overlapping fan)                                       */
/* ------------------------------------------------------------------ */

interface CardGroupProps {
  cards: Card[]
  levelRank: number
  size?: CardSize
  maxWidth?: number
}

export function CardGroup({ cards, levelRank, size = 'md', maxWidth }: CardGroupProps) {
  const s = SIZES[size]
  const count = cards.length
  if (count === 0) return null

  // Calculate overlap to fit within maxWidth if provided
  let overlap = Math.round(s.w * 0.45)
  if (maxWidth && count > 1) {
    const neededWidth = s.w + (count - 1) * overlap
    if (neededWidth > maxWidth) {
      overlap = Math.max(Math.round(s.w * 0.2), Math.floor((maxWidth - s.w) / (count - 1)))
    }
  }

  const totalWidth = count === 1 ? s.w : s.w + (count - 1) * overlap

  return (
    <div
      className="card-group"
      style={{
        width: totalWidth,
        height: s.h,
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {cards.map((card, i) => (
        <div
          key={card.id}
          style={{
            position: 'absolute',
            left: i * overlap,
            zIndex: i + 1,
          }}
        >
          <PlayingCard card={card} levelRank={levelRank} size={size} />
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Card count badge (for other players)                               */
/* ------------------------------------------------------------------ */

export function CardCountBadge({ count }: { count: number }) {
  return (
    <span className="card-count-badge">{count}</span>
  )
}
