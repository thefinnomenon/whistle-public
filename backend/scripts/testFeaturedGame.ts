import assert from 'node:assert/strict'
import {
  buildFeaturedJoinAnalytics,
  getFeaturedDayKey,
  getFeaturedPoolState,
  getFeaturedWeekKey,
} from '../src/lib/featuredGame'

const hour = 60 * 60 * 1000
const kickoffAtMs = Date.UTC(2026, 8, 10, 0, 20)

assert.deepEqual(getFeaturedPoolState(0), {
  amount: 25,
  nextAmount: 50,
  nextPlayerThreshold: 50,
  playersNeeded: 50,
})
assert.equal(getFeaturedPoolState(49).amount, 25)
assert.equal(getFeaturedPoolState(50).amount, 50)
assert.equal(getFeaturedPoolState(99).amount, 50)
assert.equal(getFeaturedPoolState(100).amount, 100)
assert.equal(getFeaturedPoolState(10, 100).amount, 100)
assert.equal(getFeaturedPoolState(10, 100).nextAmount, null)

assert.equal(
  getFeaturedWeekKey(new Date('2026-09-10T00:20:00.000Z')),
  '2026-09-08'
)
assert.equal(
  getFeaturedWeekKey(new Date('2026-09-14T23:59:00.000Z')),
  '2026-09-08'
)
assert.equal(
  getFeaturedWeekKey(new Date('2026-09-15T00:01:00.000Z')),
  '2026-09-15'
)

assert.equal(
  getFeaturedDayKey(new Date('2026-08-15T03:59:59.999Z')),
  '2026-08-14'
)
assert.equal(
  getFeaturedDayKey(new Date('2026-08-15T04:00:00.000Z')),
  '2026-08-15'
)
assert.equal(
  getFeaturedDayKey(new Date('2026-11-01T05:30:00.000Z')),
  '2026-11-01'
)
assert.equal(
  getFeaturedDayKey(new Date('2026-11-01T06:30:00.000Z')),
  '2026-11-01'
)

const analytics = buildFeaturedJoinAnalytics(
  [
    {
      firstJoinedAtMs: kickoffAtMs - 30 * hour,
      source: 'player_share',
      referred: true,
    },
    {
      firstJoinedAtMs: kickoffAtMs - 12 * hour,
      source: 'featured_pool_25',
      referred: false,
    },
    {
      firstJoinedAtMs: kickoffAtMs - 30 * 60 * 1000,
      source: 'player_share',
      referred: true,
    },
    {
      firstJoinedAtMs: kickoffAtMs + 1,
      source: '',
      referred: false,
    },
    {
      firstJoinedAtMs: null,
      source: 'pre_feature_existing',
      referred: false,
    },
  ],
  kickoffAtMs,
  {
    25: kickoffAtMs - 20 * hour,
    50: kickoffAtMs - hour,
  }
)

assert.deepEqual(analytics.timing, {
  moreThan24HoursBefore: 1,
  final24HoursExcludingFinalHour: 1,
  finalHour: 1,
  afterKickoff: 1,
  unknown: 1,
})
assert.equal(analytics.uniquePlayers, 5)
assert.equal(analytics.referredPlayers, 2)
assert.deepEqual(analytics.sources, [
  { source: 'player_share', players: 2 },
  { source: 'direct', players: 1 },
  { source: 'featured_pool_25', players: 1 },
  { source: 'pre_feature_existing', players: 1 },
])
assert.deepEqual(
  analytics.afterAnnouncements.map(({ amount, players }) => ({
    amount,
    players,
  })),
  [
    { amount: 25, players: 3 },
    { amount: 50, players: 2 },
  ]
)

console.log('[featured-game-test] result=pass')
