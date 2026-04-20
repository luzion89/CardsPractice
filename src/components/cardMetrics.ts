export const CARD_SIZE_METRICS = {
  xs: { w: 36, h: 52, rankFs: 11, suitFs: 10, centerFs: 18, gap: 1, r: 4, pad: 3 },
  sm: { w: 46, h: 66, rankFs: 13, suitFs: 12, centerFs: 22, gap: 2, r: 5, pad: 4 },
  md: { w: 60, h: 86, rankFs: 15, suitFs: 14, centerFs: 28, gap: 2, r: 6, pad: 5 },
  lg: { w: 72, h: 102, rankFs: 17, suitFs: 16, centerFs: 32, gap: 3, r: 7, pad: 6 },
} as const

export type CardSize = keyof typeof CARD_SIZE_METRICS