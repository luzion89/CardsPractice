import type { Card } from '../lib/guandan/types'
import { isWildCard, rankToText } from '../lib/guandan/engine'

const SUIT_INFO: Record<string, { symbol: string; color: string }> = {
  spades: { symbol: '♠', color: '#1a1a2e' },
  hearts: { symbol: '♥', color: '#c0392b' },
  diamonds: { symbol: '♦', color: '#c0392b' },
  clubs: { symbol: '♣', color: '#1a1a2e' },
  black: { symbol: '🃏', color: '#1a1a2e' },
  red: { symbol: '🃏', color: '#c0392b' },
}

interface PlayingCardProps {
  card: Card
  levelRank: number
  size?: 'sm' | 'md'
}

export function PlayingCard({ card, levelRank, size = 'md' }: PlayingCardProps) {
  const info = SUIT_INFO[card.suit] ?? SUIT_INFO.spades
  const isJoker = card.rank === 16 || card.rank === 17
  const isWild = isWildCard(card, levelRank)
  const w = size === 'sm' ? 36 : 48
  const h = size === 'sm' ? 52 : 70
  const fontSize = size === 'sm' ? 11 : 14
  const suitSize = size === 'sm' ? 12 : 16

  if (isJoker) {
    const jokerColor = card.rank === 17 ? '#c0392b' : '#1a1a2e'
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="playing-card joker">
        <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="4" fill="#fffef8"
          stroke={jokerColor} strokeWidth="1.2" />
        <text x={w / 2} y={h * 0.42} textAnchor="middle" fill={jokerColor}
          fontSize={suitSize + 4} fontWeight="bold">🃏</text>
        <text x={w / 2} y={h * 0.72} textAnchor="middle" fill={jokerColor}
          fontSize={fontSize - 2} fontWeight="700">
          {card.rank === 17 ? '大王' : '小王'}
        </text>
      </svg>
    )
  }

  const label = rankToText(card.rank)

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      className={`playing-card ${isWild ? 'wild' : ''}`}>
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="4"
        fill={isWild ? '#fff8e1' : '#fffef8'}
        stroke={isWild ? '#e6a817' : '#bbb'} strokeWidth={isWild ? 1.6 : 0.8} />
      <text x="4" y={fontSize + 3} fill={info.color}
        fontSize={fontSize} fontWeight="700" fontFamily="monospace">
        {label}
      </text>
      <text x="4" y={fontSize + 3 + suitSize} fill={info.color}
        fontSize={suitSize} fontFamily="monospace">
        {info.symbol}
      </text>
      <text x={w / 2} y={h * 0.62} textAnchor="middle" fill={info.color}
        fontSize={suitSize + 6}>
        {info.symbol}
      </text>
      {isWild && (
        <text x={w / 2} y={h - 4} textAnchor="middle" fill="#e6a817"
          fontSize={fontSize - 3} fontWeight="700">配</text>
      )}
    </svg>
  )
}

interface CardGroupProps {
  cards: Card[]
  levelRank: number
  size?: 'sm' | 'md'
}

export function CardGroup({ cards, levelRank, size = 'md' }: CardGroupProps) {
  const overlap = size === 'sm' ? 20 : 28
  const w = size === 'sm' ? 36 : 48
  const totalWidth = cards.length === 0 ? 0 : w + (cards.length - 1) * overlap

  return (
    <div className="card-group" style={{ width: totalWidth, height: size === 'sm' ? 52 : 70, position: 'relative' }}>
      {cards.map((card, i) => (
        <div key={card.id} style={{ position: 'absolute', left: i * overlap, zIndex: i }}>
          <PlayingCard card={card} levelRank={levelRank} size={size} />
        </div>
      ))}
    </div>
  )
}
