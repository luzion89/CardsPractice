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
  const isLevel = card.rank === levelRank && !isJoker
  const w = size === 'sm' ? 40 : 54
  const h = size === 'sm' ? 58 : 78
  const fontSize = size === 'sm' ? 13 : 17
  const suitSize = size === 'sm' ? 12 : 16

  if (isJoker) {
    const jokerColor = card.rank === 17 ? '#c0392b' : '#1a1a2e'
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="playing-card joker">
        <defs>
          <linearGradient id={`joker-fill-${card.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fffefa" />
            <stop offset="100%" stopColor="#f0ece4" />
          </linearGradient>
        </defs>
        <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="6" fill={`url(#joker-fill-${card.id})`}
          stroke={jokerColor} strokeWidth="1.2" />
        <rect x="3" y="3" width={w - 6} height={h - 6} rx="4" fill="none" stroke="rgba(0,0,0,0.08)" />
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
  const fillId = `card-fill-${card.id}`
  const cornerX = 7
  const topRankY = size === 'sm' ? 13 : 16
  const topSuitY = topRankY + suitSize
  const bottomCornerX = w - 7
  const bottomSuitY = h - 7
  const bottomRankY = bottomSuitY - suitSize - 4
  const badgeCenterY = size === 'sm' ? 10 : 11
  const badgeTextY = size === 'sm' ? 13 : 14.5
  const badgeRx = size === 'sm' ? 8 : 9
  const badgeRy = size === 'sm' ? 4.8 : 5.6

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`playing-card ${isWild ? 'wild' : ''} ${isLevel ? 'level' : ''}`}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isWild ? '#fff4c8' : isLevel ? '#fff6dc' : '#fffefa'} />
          <stop offset="100%" stopColor={isWild ? '#f2deb0' : isLevel ? '#efe0b6' : '#f2eee5'} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="6"
        fill={`url(#${fillId})`}
        stroke={isWild ? '#d99714' : isLevel ? '#bf8a21' : '#b9b2a5'} strokeWidth={isWild || isLevel ? 1.5 : 0.9} />
      <rect x="3" y="3" width={w - 6} height={h - 6} rx="4" fill="none" stroke="rgba(0,0,0,0.08)" />
      {isWild ? (
        <g>
          <text x={w / 2} y={badgeTextY} textAnchor="middle" fill="#f4cb71"
            stroke="#c6404d" strokeWidth={size === 'sm' ? 1.1 : 1.25} paintOrder="stroke"
            fontSize={size === 'sm' ? 11 : 13} fontWeight="800">
            ♥
          </text>
        </g>
      ) : (
        <g>
          <ellipse cx={w / 2} cy={badgeCenterY} rx={badgeRx} ry={badgeRy}
            fill={isLevel ? 'rgba(247, 224, 164, 0.96)' : 'rgba(255, 255, 255, 0.9)'}
            stroke={isLevel ? 'rgba(191, 138, 33, 0.72)' : 'rgba(0, 0, 0, 0.08)'} strokeWidth="0.9" />
          <text x={w / 2} y={badgeTextY} textAnchor="middle" fill={info.color}
            fontSize={size === 'sm' ? 8.5 : 10.5} fontWeight="700">
            {info.symbol}
          </text>
        </g>
      )}
      <text x={cornerX} y={topRankY} fill={info.color}
        fontSize={fontSize} fontWeight="800" fontFamily="Trebuchet MS, Segoe UI, sans-serif">
        {label}
      </text>
      <text x={cornerX} y={topSuitY} fill={info.color}
        fontSize={suitSize} fontFamily="Trebuchet MS, Segoe UI, sans-serif">
        {info.symbol}
      </text>
      <text x={bottomCornerX} y={bottomRankY} textAnchor="end" fill={info.color}
        fontSize={fontSize} fontWeight="800" fontFamily="Trebuchet MS, Segoe UI, sans-serif">
        {label}
      </text>
      <text x={bottomCornerX} y={bottomSuitY} textAnchor="end" fill={info.color}
        fontSize={suitSize} fontFamily="Trebuchet MS, Segoe UI, sans-serif">
        {info.symbol}
      </text>
      <text x={w / 2} y={h * 0.58} textAnchor="middle" fill={info.color}
        fillOpacity="0.1" fontSize={suitSize + 18}>
        {info.symbol}
      </text>
      <text x={w / 2} y={h * 0.62} textAnchor="middle" fill={info.color}
        fontSize={suitSize + 7}>
        {info.symbol}
      </text>
      {(isWild || isLevel) && (
        <text x={w / 2} y={h - 4} textAnchor="middle" fill={isWild ? '#c6404d' : '#bf8a21'}
          fontSize={fontSize - 4} fontWeight="800">{isWild ? '配' : '级'}</text>
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
  const overlap = size === 'sm' ? 21 : 31
  const w = size === 'sm' ? 40 : 54
  const totalWidth = cards.length === 0 ? 0 : w + (cards.length - 1) * overlap

  return (
    <div className="card-group" style={{ width: totalWidth, height: size === 'sm' ? 58 : 78, position: 'relative' }}>
      {cards.map((card, i) => (
        <div key={card.id} style={{ position: 'absolute', left: i * overlap, zIndex: i }}>
          <PlayingCard card={card} levelRank={levelRank} size={size} />
        </div>
      ))}
    </div>
  )
}
