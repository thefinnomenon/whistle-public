'use client'

import { useAuth } from '@/components/AuthProvider'
import { apiRequest } from '@/lib/api'
import Link from 'next/link'
import { useEffect, useState } from 'react'

type BreakdownItem = {
  key: string
  sent: number
  opened: number
  answered: number
  resolved: number
  voided: number
  send_to_answer_rate: number | null
  open_rate: number | null
  void_rate: number | null
  median_time_to_answer_ms: number | null
}

type LatencyBreakdownItem = {
  latency_bucket: string
  sent: number
  answered: number
  send_to_answer_rate: number | null
  median_time_to_answer_ms: number | null
}

type AnalyticsSummary = {
  range_days: number
  from_date: string
  to_date: string
  generated_at: string
  cache: 'hit' | 'miss'
  totals: {
    question_sent: number
    question_opened: number
    question_answered: number
    question_resolved: number
    send_to_open_rate: number | null
    send_to_answer_rate: number | null
    median_time_to_answer_ms: number | null
    avg_answers_per_user_per_game: number | null
    pct_user_games_with_5_plus_answers: number | null
    users_with_2_plus_games_7d: number | null
  }
  by_question_type: BreakdownItem[]
  by_trigger_type: BreakdownItem[]
  by_latency_bucket: LatencyBreakdownItem[]
}

const formatPct = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`

const formatMs = (value: number | null) =>
  value === null ? '—' : `${Math.round(value).toLocaleString()} ms`

const formatNum = (value: number | null) =>
  value === null ? '—' : value.toLocaleString()

export default function AnalyticsPage() {
  const { user, loading: authLoading, signInWithGoogle, signOut } = useAuth()
  const [range, setRange] = useState<'7d' | '30d'>('7d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false

    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await apiRequest<AnalyticsSummary>(
          `/api/admin/mixpanel/summary?range=${range}`
        )
        if (!cancelled) setSummary(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [user, range])

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-8">Whistle Admin Analytics</h1>
          <p className="text-gray-600 mb-8">Sign in to view analytics</p>
          <button
            onClick={signInWithGoogle}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-4xl font-bold">Analytics</h1>
            <p className="text-sm text-gray-600 mt-1">Signed in as {user.email}</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/"
              className="bg-gray-100 text-gray-800 px-4 py-2 rounded hover:bg-gray-200"
            >
              Back
            </Link>
            <button
              onClick={() => setRange('7d')}
              className={`px-4 py-2 rounded ${range === '7d' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'}`}
            >
              Last 7d
            </button>
            <button
              onClick={() => setRange('30d')}
              className={`px-4 py-2 rounded ${range === '30d' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'}`}
            >
              Last 30d
            </button>
            <button
              onClick={signOut}
              className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300"
            >
              Sign Out
            </button>
          </div>
        </div>

        {loading && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">Loading summary...</div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6 text-red-700">
            {error}
          </div>
        )}

        {summary && !loading && (
          <>
            <div className="text-sm text-gray-600 mb-4">
              Range: {summary.from_date} to {summary.to_date} • Generated:{' '}
              {new Date(summary.generated_at).toLocaleString()} • Cache: {summary.cache}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              <MetricCard label="Sent" value={formatNum(summary.totals.question_sent)} />
              <MetricCard label="Opened" value={formatNum(summary.totals.question_opened)} />
              <MetricCard label="Answered" value={formatNum(summary.totals.question_answered)} />
              <MetricCard
                label="Send→Open"
                value={formatPct(summary.totals.send_to_open_rate)}
              />
              <MetricCard
                label="Send→Answer"
                value={formatPct(summary.totals.send_to_answer_rate)}
              />
              <MetricCard
                label="Median TTA"
                value={formatMs(summary.totals.median_time_to_answer_ms)}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-3">Investor Metrics</h2>
                <ul className="space-y-2 text-sm">
                  <li>
                    Avg answers per user/game:{' '}
                    <strong>{formatNum(summary.totals.avg_answers_per_user_per_game)}</strong>
                  </li>
                  <li>
                    % user-games with 5+ answers:{' '}
                    <strong>{formatPct(summary.totals.pct_user_games_with_5_plus_answers)}</strong>
                  </li>
                  <li>
                    Users with 2+ games (7d):{' '}
                    <strong>{formatNum(summary.totals.users_with_2_plus_games_7d)}</strong>
                  </li>
                </ul>
              </div>
              <BreakdownTable
                title="Latency Buckets"
                rows={summary.by_latency_bucket.map((item) => ({
                  key: item.latency_bucket,
                  sent: item.sent,
                  answered: item.answered,
                  send_to_answer_rate: item.send_to_answer_rate,
                  median_time_to_answer_ms: item.median_time_to_answer_ms,
                }))}
              />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <BreakdownTable title="By Question Type" rows={summary.by_question_type} />
              <BreakdownTable title="By Trigger Type" rows={summary.by_trigger_type} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-sm text-gray-600">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  )
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string
  rows: {
    key: string
    sent: number
    answered: number
    send_to_answer_rate: number | null
    median_time_to_answer_ms: number | null
  }[]
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6 overflow-x-auto">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2 pr-4">Key</th>
            <th className="py-2 pr-4">Sent</th>
            <th className="py-2 pr-4">Answered</th>
            <th className="py-2 pr-4">Send→Answer</th>
            <th className="py-2 pr-4">Median TTA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-b-0">
              <td className="py-2 pr-4">{row.key}</td>
              <td className="py-2 pr-4">{row.sent.toLocaleString()}</td>
              <td className="py-2 pr-4">{row.answered.toLocaleString()}</td>
              <td className="py-2 pr-4">{formatPct(row.send_to_answer_rate)}</td>
              <td className="py-2 pr-4">{formatMs(row.median_time_to_answer_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

