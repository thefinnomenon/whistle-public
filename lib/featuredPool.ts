export const FEATURED_POOL_TIERS = [
  { players: 0, amount: 25 },
  { players: 50, amount: 50 },
  { players: 100, amount: 100 },
] as const

export type FeaturedPoolProgress = {
  amount: number
  nextAmount: number | null
  nextPlayerThreshold: number | null
  playersNeeded: number
  progress: number
}

export const getFeaturedPoolProgress = (
  playerCount: number,
  featuredPoolAmount?: number
): FeaturedPoolProgress => {
  const safePlayerCount = Math.max(0, Math.floor(playerCount))
  const unlockedByCount = FEATURED_POOL_TIERS.reduce(
    (amount, tier) => (safePlayerCount >= tier.players ? tier.amount : amount),
    25
  )
  const amount = Math.max(unlockedByCount, featuredPoolAmount ?? 25)
  const nextTier = FEATURED_POOL_TIERS.find((tier) => tier.amount > amount)

  if (!nextTier) {
    return {
      amount,
      nextAmount: null,
      nextPlayerThreshold: null,
      playersNeeded: 0,
      progress: 1,
    }
  }

  const previousTier = [...FEATURED_POOL_TIERS]
    .reverse()
    .find((tier) => tier.amount <= amount)
  const previousThreshold = previousTier?.players ?? 0
  const progress =
    (safePlayerCount - previousThreshold) /
    (nextTier.players - previousThreshold)

  return {
    amount,
    nextAmount: nextTier.amount,
    nextPlayerThreshold: nextTier.players,
    playersNeeded: Math.max(0, nextTier.players - safePlayerCount),
    progress: Math.min(1, Math.max(0, progress)),
  }
}
