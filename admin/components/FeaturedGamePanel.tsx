'use client'

import { apiRequest } from '@/lib/api'
import type { Game } from '@/types'
import { useCallback, useEffect, useState } from 'react'

type FeaturedPoolAmount = 25 | 50 | 100

type FeaturedAnalytics = {
  gameId: string
  isFeatured: boolean
  activePlayers: number
  uniquePlayers: number
  referredPlayers: number
  kickoffAtMs: number
  pool: {
    amount: FeaturedPoolAmount
    nextAmount: FeaturedPoolAmount | null
    nextPlayerThreshold: number | null
    playersNeeded: number
  }
  timing: {
    moreThan24HoursBefore: number
    final24HoursExcludingFinalHour: number
    finalHour: number
    afterKickoff: number
    unknown: number
  }
  sources: { source: string; players: number }[]
  afterAnnouncements: {
    amount: FeaturedPoolAmount
    announcedAtMs: number
    players: number
  }[]
}

type FeaturedAnnouncementResponse = {
  ok: boolean
  amount: FeaturedPoolAmount
  announcedAtMs: number
  text: string
  url: string
}

type FeaturedGamePanelProps = {
  game: Game
  gameId: string
}

const FEATURED_POOL_AMOUNTS: FeaturedPoolAmount[] = [25, 50, 100]

const featuredAnnouncementKey = (
  amount: FeaturedPoolAmount
): '25' | '50' | '100' => {
  if (amount === 25) return '25'
  if (amount === 50) return '50'
  return '100'
}

export function FeaturedGamePanel({ game, gameId }: FeaturedGamePanelProps) {
  const [analytics, setAnalytics] = useState<FeaturedAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const loadAnalytics = useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiRequest<FeaturedAnalytics>(
        `/api/games/${gameId}/featured/analytics`
      )
      setAnalytics(result)
    } catch (error) {
      console.error('Error loading featured analytics:', error)
      setStatus('Unable to load featured analytics')
    } finally {
      setLoading(false)
    }
  }, [gameId])

  useEffect(() => {
    if (!game.isFeatured) {
      setAnalytics(null)
      return
    }
    void loadAnalytics()
  }, [game.isFeatured, loadAnalytics])

  const updateFeaturedState = async (featured: boolean) => {
    setLoading(true)
    setStatus(null)
    try {
      await apiRequest(`/api/games/${gameId}/featured`, {
        method: 'POST',
        body: { featured },
      })
      setStatus(
        featured
          ? 'Featured game enabled with a $25 guaranteed pool'
          : 'Featured game removed and its previous prize restored'
      )
    } catch (error) {
      console.error('Error updating featured game:', error)
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`Unable to update featured game: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const announcePool = async (amount: FeaturedPoolAmount) => {
    setLoading(true)
    setStatus(null)
    try {
      const announcement = await apiRequest<FeaturedAnnouncementResponse>(
        `/api/games/${gameId}/featured/announce`,
        { method: 'POST', body: { amount } }
      )
      const shareCopy = `${announcement.text}\n${announcement.url}`
      try {
        await navigator.clipboard.writeText(shareCopy)
        setStatus(`$${amount} announcement recorded and copied to the clipboard`)
      } catch {
        window.prompt('Copy this announcement', shareCopy)
        setStatus(`$${amount} announcement recorded`)
      }
      await loadAnalytics()
    } catch (error) {
      console.error('Error announcing featured pool:', error)
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`Unable to record announcement: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const currentPool = game.featuredPoolAmount ?? game.prizeAmount

  return (
    <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-blue-950 dark:text-blue-100">
            Featured Game
          </h3>
          {game.isFeatured ? (
            <p className="mt-1 text-sm text-blue-800 dark:text-blue-200">
              ${currentPool} pool with {game.playerCount || 0} active players
              {analytics?.pool.nextAmount
                ? `. ${analytics.pool.playersNeeded} more unlock $${analytics.pool.nextAmount}.`
                : '. Top pool unlocked.'}
            </p>
          ) : (
            <p className="mt-1 max-w-2xl text-sm text-blue-800 dark:text-blue-200">
              Guarantee $25, unlock $50 at 50 players, and unlock $100 at 100
              players. Enabling this will replace another featured game
              scheduled for the same day.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => updateFeaturedState(!game.isFeatured)}
          disabled={loading || game.state !== 'scheduled'}
          className="rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading
            ? 'Updating...'
            : game.isFeatured
              ? 'Remove Featured'
              : 'Make Featured'}
        </button>
      </div>

      {status && (
        <p className="mt-3 text-sm font-medium text-blue-900 dark:text-blue-100">
          {status}
        </p>
      )}

      {game.isFeatured && (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label="Payout status" value={game.payoutStatus ?? 'Pending'} />
            <Metric
              label="Prize eligible"
              value={game.payoutEligiblePlayerCount ?? '—'}
            />
            <Metric label="Winners" value={game.payoutWinnerCount ?? '—'} />
            <Metric
              label="Payout total"
              value={
                typeof game.payoutTotalUnits === 'number'
                  ? game.payoutPrizeType === 'USD'
                    ? `$${(game.payoutTotalUnits / 100).toFixed(2)}`
                    : game.payoutTotalUnits
                  : '—'
              }
            />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="font-semibold text-gray-900 dark:text-white">
                Threshold announcements
              </h4>
              <button
                type="button"
                onClick={loadAnalytics}
                disabled={loading}
                className="text-sm font-medium text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300"
              >
                Refresh analytics
              </button>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {FEATURED_POOL_AMOUNTS.map((amount) => {
                const announcement =
                  game.featuredPoolAnnouncements?.[
                    featuredAnnouncementKey(amount)
                  ]
                const isUnlocked = currentPool >= amount
                return (
                  <button
                    key={amount}
                    type="button"
                    onClick={() => announcePool(amount)}
                    disabled={loading || !isUnlocked}
                    className="rounded-lg border border-blue-200 bg-white px-3 py-3 text-left hover:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-gray-900"
                  >
                    <span className="block font-semibold text-gray-900 dark:text-white">
                      Copy ${amount} announcement
                    </span>
                    <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                      {announcement
                        ? `Last recorded ${announcement.toDate().toLocaleString()}`
                        : isUnlocked
                          ? 'Not announced yet'
                          : 'Not unlocked yet'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {analytics && (
            <div>
              <h4 className="mb-2 font-semibold text-gray-900 dark:text-white">
                Join attribution
              </h4>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                <Metric
                  label="More than 24h before"
                  value={analytics.timing.moreThan24HoursBefore}
                />
                <Metric
                  label="24h to 1h before"
                  value={analytics.timing.final24HoursExcludingFinalHour}
                />
                <Metric label="Final hour" value={analytics.timing.finalHour} />
                <Metric
                  label="After kickoff"
                  value={analytics.timing.afterKickoff}
                />
                <Metric label="Referred players" value={analytics.referredPlayers} />
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded bg-white p-3 dark:bg-gray-900">
                  <div className="mb-2 text-sm font-semibold">First join source</div>
                  {analytics.sources.length > 0 ? (
                    <div className="space-y-1 text-sm">
                      {analytics.sources.map((source) => (
                        <div
                          key={source.source}
                          className="flex justify-between gap-4"
                        >
                          <span>{source.source}</span>
                          <strong>{source.players}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">
                      No joins recorded yet
                    </div>
                  )}
                </div>
                <div className="rounded bg-white p-3 dark:bg-gray-900">
                  <div className="mb-2 text-sm font-semibold">
                    Joined after announcement
                  </div>
                  {analytics.afterAnnouncements.length > 0 ? (
                    <div className="space-y-1 text-sm">
                      {analytics.afterAnnouncements.map((announcement) => (
                        <div
                          key={announcement.amount}
                          className="flex justify-between gap-4"
                        >
                          <span>After ${announcement.amount}</span>
                          <strong>{announcement.players}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">
                      Record an announcement to start this comparison
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded bg-white p-3 dark:bg-gray-900">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  )
}
