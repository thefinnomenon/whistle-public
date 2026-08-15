export const FEATURED_POOL_TIERS = [
  { players: 0, amount: 25 },
  { players: 50, amount: 50 },
  { players: 100, amount: 100 },
] as const

export type FeaturedPoolAmount = (typeof FEATURED_POOL_TIERS)[number]['amount']

export type FeaturedPoolState = {
  amount: FeaturedPoolAmount
  nextAmount: FeaturedPoolAmount | null
  nextPlayerThreshold: number | null
  playersNeeded: number
}

export type FeaturedJoinRecord = {
  firstJoinedAtMs: number | null
  source: string
  referred: boolean
}

export type FeaturedAnnouncementTimes = Partial<
  Record<FeaturedPoolAmount, number>
>

export type FeaturedJoinAnalytics = {
  uniquePlayers: number
  timing: {
    moreThan24HoursBefore: number
    final24HoursExcludingFinalHour: number
    finalHour: number
    afterKickoff: number
    unknown: number
  }
  referredPlayers: number
  sources: { source: string; players: number }[]
  afterAnnouncements: {
    amount: FeaturedPoolAmount
    announcedAtMs: number
    players: number
  }[]
}

const isFeaturedPoolAmount = (value: number): value is FeaturedPoolAmount =>
  FEATURED_POOL_TIERS.some((tier) => tier.amount === value)

export const parseFeaturedPoolAmount = (
  value: number
): FeaturedPoolAmount | null => (isFeaturedPoolAmount(value) ? value : null)

export const getFeaturedPoolState = (
  playerCount: number,
  previouslyUnlockedAmount = 25
): FeaturedPoolState => {
  const safePlayerCount = Math.max(0, Math.floor(playerCount))
  const unlockedByCount = FEATURED_POOL_TIERS.reduce<FeaturedPoolAmount>(
    (amount, tier) => (safePlayerCount >= tier.players ? tier.amount : amount),
    25
  )
  const safePreviousAmount = isFeaturedPoolAmount(previouslyUnlockedAmount)
    ? previouslyUnlockedAmount
    : 25
  const amount = Math.max(
    unlockedByCount,
    safePreviousAmount
  ) as FeaturedPoolAmount
  const nextTier = FEATURED_POOL_TIERS.find((tier) => tier.amount > amount)

  return {
    amount,
    nextAmount: nextTier?.amount ?? null,
    nextPlayerThreshold: nextTier?.players ?? null,
    playersNeeded: nextTier
      ? Math.max(0, nextTier.players - safePlayerCount)
      : 0,
  }
}

export const getFeaturedWeekKey = (startTime: Date): string => {
  const tuesday = new Date(
    Date.UTC(
      startTime.getUTCFullYear(),
      startTime.getUTCMonth(),
      startTime.getUTCDate()
    )
  )
  // NFL slates conventionally run through Monday night. A Tuesday boundary
  // keeps Thursday, Sunday, and Monday games in the same featured week.
  const daysSinceTuesday = (tuesday.getUTCDay() + 5) % 7
  tuesday.setUTCDate(tuesday.getUTCDate() - daysSinceTuesday)
  return tuesday.toISOString().slice(0, 10)
}

const FEATURED_TIME_ZONE = 'America/New_York'
const featuredDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: FEATURED_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export const getFeaturedDayKey = (startTime: Date): string => {
  const parts = featuredDayFormatter.formatToParts(startTime)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) {
    throw new Error('Unable to determine Featured Game day')
  }
  return `${year}-${month}-${day}`
}

export const buildFeaturedJoinAnalytics = (
  joins: FeaturedJoinRecord[],
  kickoffAtMs: number,
  announcements: FeaturedAnnouncementTimes
): FeaturedJoinAnalytics => {
  const timing = {
    moreThan24HoursBefore: 0,
    final24HoursExcludingFinalHour: 0,
    finalHour: 0,
    afterKickoff: 0,
    unknown: 0,
  }
  const sources = new Map<string, number>()
  let referredPlayers = 0

  for (const join of joins) {
    if (join.firstJoinedAtMs === null) {
      timing.unknown += 1
    } else {
      const msBeforeKickoff = kickoffAtMs - join.firstJoinedAtMs
      if (msBeforeKickoff < 0) timing.afterKickoff += 1
      else if (msBeforeKickoff <= 60 * 60 * 1000) timing.finalHour += 1
      else if (msBeforeKickoff <= 24 * 60 * 60 * 1000)
        timing.final24HoursExcludingFinalHour += 1
      else timing.moreThan24HoursBefore += 1
    }

    const source = join.source || 'direct'
    sources.set(source, (sources.get(source) ?? 0) + 1)
    if (join.referred) referredPlayers += 1
  }

  const afterAnnouncements = FEATURED_POOL_TIERS.flatMap((tier) => {
    const announcedAtMs = announcements[tier.amount]
    if (typeof announcedAtMs !== 'number') return []
    return [
      {
        amount: tier.amount,
        announcedAtMs,
        players: joins.filter(
          (join) =>
            join.firstJoinedAtMs !== null &&
            join.firstJoinedAtMs >= announcedAtMs
        ).length,
      },
    ]
  })

  return {
    uniquePlayers: joins.length,
    timing,
    referredPlayers,
    sources: [...sources.entries()]
      .map(([source, players]) => ({ source, players }))
      .sort(
        (a, b) => b.players - a.players || a.source.localeCompare(b.source)
      ),
    afterAnnouncements,
  }
}
