'use client'

import { useAuth } from '@/components/AuthProvider'
import { apiRequest } from '@/lib/api'
import { db } from '@/lib/firebase'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type {
  Game,
  GameSimulationResponse,
  SimulationJsonValue,
} from '@/types'

const formatDateTime = (ms: number | null | undefined) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

const formatRelativeSeconds = (
  ms: number | null | undefined,
  baselineMs: number | null
) => {
  if (
    typeof ms !== 'number' ||
    !Number.isFinite(ms) ||
    baselineMs === null ||
    !Number.isFinite(baselineMs)
  ) {
    return '—'
  }
  return `${((ms - baselineMs) / 1000).toFixed(1)}s`
}

const formatClock = (clockMs: number | null | undefined) => {
  if (typeof clockMs !== 'number' || !Number.isFinite(clockMs)) return '—'
  const totalSeconds = Math.max(0, Math.floor(clockMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

const stringifyCompact = (value: SimulationJsonValue | undefined) => {
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const getStartContextEntries = (
  context: Record<string, SimulationJsonValue> | undefined
): [string, SimulationJsonValue][] => {
  if (!context) return []
  return Object.entries(context)
    .filter(([key]) => key.startsWith('start'))
    .sort(([a], [b]) => a.localeCompare(b))
}

export default function SimulatePage() {
  const { user, loading: authLoading, signInWithGoogle } = useAuth()
  const [games, setGames] = useState<Game[]>([])
  const [gamesLoading, setGamesLoading] = useState(true)
  const [selectedGameId, setSelectedGameId] = useState<string>('')
  const [simLoading, setSimLoading] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)
  const [simData, setSimData] = useState<GameSimulationResponse | null>(null)

  useEffect(() => {
    if (!user) {
      setGamesLoading(false)
      return
    }

    const gamesQuery = query(collection(db, 'games'), orderBy('startTime', 'desc'))

    const unsubscribe = onSnapshot(
      gamesQuery,
      (snapshot) => {
        const nextGames = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Game[]
        setGames(nextGames)
        setSelectedGameId((prev) => prev || nextGames[0]?.id || '')
        setGamesLoading(false)
      },
      (error) => {
        console.error('Error fetching games for simulation:', error)
        setGamesLoading(false)
      }
    )

    return () => unsubscribe()
  }, [user])

  const runSimulation = async () => {
    if (!selectedGameId) return

    setSimLoading(true)
    setSimError(null)
    try {
      const response = await apiRequest<GameSimulationResponse>(
        `/api/games/${selectedGameId}/simulate`
      )
      setSimData(response)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to simulate game'
      console.error('Simulation error', error)
      setSimError(message)
      setSimData(null)
    } finally {
      setSimLoading(false)
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold mb-4">Whistle Admin Simulator</h1>
          <p className="text-gray-600 mb-6">Sign in to replay an old game</p>
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

  const selectedGame = games.find((game) => game.id === selectedGameId) ?? null
  const simulatedQuestions = simData?.simulation.questions ?? []
  const originalQuestions = simData?.originalQuestions ?? []
  const originalBaselineMs =
    originalQuestions.find((q) => typeof q.triggeredAtMs === 'number')?.triggeredAtMs ??
    originalQuestions.find((q) => typeof q.createdAtMs === 'number')?.createdAtMs ??
    null

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold">Game Simulation</h1>
            <p className="text-sm text-gray-600">
              Replay stored event streams to inspect generated questions and resolutions
            </p>
          </div>
          <Link
            href="/"
            className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300"
          >
            Back to Dashboard
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select game (newest first)
              </label>
              <select
                value={selectedGameId}
                onChange={(e) => setSelectedGameId(e.target.value)}
                disabled={gamesLoading}
                className="w-full border border-gray-300 rounded px-3 py-2 bg-white"
              >
                <option value="">
                  {gamesLoading ? 'Loading games...' : 'Choose a game'}
                </option>
                {games.map((game) => (
                  <option key={game.id} value={game.id}>
                    {game.homeTeam} vs {game.awayTeam} •{' '}
                    {game.startTime?.toDate?.()?.toLocaleString() || 'No date'} • {game.id}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={runSimulation}
              disabled={!selectedGameId || simLoading}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {simLoading ? 'Simulating...' : 'Run Simulation'}
            </button>
          </div>

          {selectedGame && (
            <div className="text-sm text-gray-600">
              Selected: <span className="font-medium text-gray-900">{selectedGame.homeTeam} vs {selectedGame.awayTeam}</span>{' '}
              ({selectedGame.id})
            </div>
          )}

          {simError && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-red-700 text-sm">
              {simError}
            </div>
          )}
        </div>

        {simData && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white rounded-lg shadow p-4">
                <div className="text-xs uppercase text-gray-500">Events Replayed</div>
                <div className="text-2xl font-semibold">{simData.simulation.eventCount}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-4">
                <div className="text-xs uppercase text-gray-500">Sim Questions</div>
                <div className="text-2xl font-semibold">{simulatedQuestions.length}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-4">
                <div className="text-xs uppercase text-gray-500">Original Questions</div>
                <div className="text-2xl font-semibold">{simData.originalCounts.total}</div>
              </div>
              <div className="bg-white rounded-lg shadow p-4">
                <div className="text-xs uppercase text-gray-500">Sim Run Time</div>
                <div className="text-sm font-medium">{formatDateTime(simData.simulatedAtMs)}</div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b">
                <h2 className="text-lg font-semibold">Order Comparison (Sim vs Original)</h2>
                <p className="text-xs text-gray-600 mt-1">
                  Basic comparison by question order; useful for spotting drift after engine changes.
                </p>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Sim</th>
                      <th className="text-left px-3 py-2">Original</th>
                      <th className="text-left px-3 py-2">Match</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {Array.from({
                      length: Math.max(simulatedQuestions.length, originalQuestions.length),
                    }).map((_, index) => {
                      const simQuestion = simulatedQuestions[index]
                      const originalQuestion = originalQuestions[index]
                      const textMatch =
                        simQuestion && originalQuestion
                          ? simQuestion.question.trim() === originalQuestion.question.trim()
                          : false
                      const stateMatch =
                        simQuestion && originalQuestion
                          ? simQuestion.state === originalQuestion.state
                          : false

                      return (
                        <tr key={`cmp-${index}`}>
                          <td className="px-3 py-2 align-top text-gray-500">{index + 1}</td>
                          <td className="px-3 py-2 align-top">
                            {simQuestion ? (
                              <div>
                                <div className="font-medium">{simQuestion.question}</div>
                                <div className="text-xs text-gray-600 mt-1">
                                  {simQuestion.state}
                                  {simQuestion.answer ? ` • ans=${simQuestion.answer}` : ''}
                                  {simQuestion.templateId ? ` • ${simQuestion.templateId}` : ''}
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top">
                            {originalQuestion ? (
                              <div>
                                <div className="font-medium">{originalQuestion.question}</div>
                                <div className="text-xs text-gray-600 mt-1">
                                  {originalQuestion.state}
                                  {originalQuestion.answer
                                    ? ` • ans=${originalQuestion.answer}`
                                    : ''}
                                  {originalQuestion.engineTag
                                    ? ` • ${originalQuestion.engineTag}`
                                    : ''}
                                  {originalQuestion.engineVersion
                                    ? ` • engineVersion=${originalQuestion.engineVersion}`
                                    : ''}
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span
                              className={`inline-flex px-2 py-1 rounded text-xs font-medium ${
                                textMatch && stateMatch
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-yellow-100 text-yellow-800'
                              }`}
                            >
                              {textMatch && stateMatch ? 'text+state' : 'different'}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b">
                <h2 className="text-lg font-semibold">Simulated Questions</h2>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Question</th>
                      <th className="text-left px-3 py-2">State</th>
                      <th className="text-left px-3 py-2">Answer</th>
                      <th className="text-left px-3 py-2">Timing</th>
                      <th className="text-left px-3 py-2">Resolution Event</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {simulatedQuestions.map((question, index) => (
                      <tr key={question.id}>
                        <td className="px-3 py-2 align-top text-gray-500">{index + 1}</td>
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium">{question.question}</div>
                          <div className="text-xs text-gray-600 mt-1">
                            {question.templateId} • trigger={question.trigger}
                            {question.engineVersion
                              ? ` • engineVersion=${question.engineVersion}`
                              : ''}
                          </div>
                          {getStartContextEntries(question.resolutionContext).length > 0 && (
                            <div className="text-xs text-gray-600 mt-2">
                              <div>
                                <span className="font-medium">start:</span>{' '}
                                {getStartContextEntries(question.resolutionContext)
                                  .map(([key, value]) => `${key}=${stringifyCompact(value)}`)
                                  .join(' • ')}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div>{question.state}</div>
                          {question.cancelReason && (
                            <div className="text-xs text-gray-600">{question.cancelReason}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">{question.answer ?? '—'}</td>
                        <td className="px-3 py-2 align-top text-xs text-gray-700">
                          <div>created: {formatRelativeSeconds(question.createdAtMs, 0)}</div>
                          <div>timeout: {formatRelativeSeconds(question.timeoutAtMs, 0)}</div>
                          <div>
                            window: {typeof question.timeoutMs === 'number'
                              ? `${(question.timeoutMs / 1000).toFixed(0)}s`
                              : '—'}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-xs text-gray-700">
                          {question.resolvedEvent ? (
                            <>
                              <div>eventId: {question.resolvedEvent.eventId}</div>
                              <div>
                                action:{' '}
                                P{question.resolvedEvent.rawActionPeriod ?? '—'} •{' '}
                                {question.resolvedEvent.rawActionClock ?? '—'}
                              </div>
                              <div>
                                snapshot:{' '}
                                P{question.resolvedEvent.period ?? '—'} •{' '}
                                {formatClock(question.resolvedEvent.clockMs)}
                              </div>
                              <div className="max-w-md">{question.resolvedEvent.description}</div>
                              <div className="mt-1">
                                <span className="font-medium">actual:</span>{' '}
                                {stringifyCompact(question.result)}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b">
                <h2 className="text-lg font-semibold">Original Stored Questions</h2>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Question</th>
                      <th className="text-left px-3 py-2">State</th>
                      <th className="text-left px-3 py-2">Answer</th>
                      <th className="text-left px-3 py-2">Timing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {originalQuestions.map((question, index) => (
                      <tr key={question.id}>
                        <td className="px-3 py-2 align-top text-gray-500">{index + 1}</td>
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium">{question.question}</div>
                          <div className="text-xs text-gray-600 mt-1">
                            {question.engineTag ?? question.templateId ?? '—'}
                            {question.engineVersion
                              ? ` • commit=${question.engineVersion}`
                              : ''}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div>{question.state}</div>
                          {question.cancelReason && (
                            <div className="text-xs text-gray-600">{question.cancelReason}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">{question.answer ?? '—'}</td>
                        <td className="px-3 py-2 align-top text-xs text-gray-700">
                          <div>created: {formatDateTime(question.createdAtMs)}</div>
                          <div>triggered: {formatDateTime(question.triggeredAtMs)}</div>
                          <div>resolved: {formatDateTime(question.resolvedAtMs)}</div>
                          <div>
                            rel trigger:{' '}
                            {formatRelativeSeconds(question.triggeredAtMs, originalBaselineMs)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
