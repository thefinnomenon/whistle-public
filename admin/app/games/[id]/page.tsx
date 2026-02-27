'use client'

import { useAuth } from '@/components/AuthProvider'
import { apiRequest } from '@/lib/api'
import { db } from '@/lib/firebase'
import {
  Timestamp,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  updateDoc
} from 'firebase/firestore'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

// Import types from parent project
import type { Game, Prediction, Question } from '@/types'

const getPercentile = (sortedArray: number[], percentile: number): number => {
  if (sortedArray.length === 0) return 0
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
  return sortedArray[Math.max(0, index)]
}

const timestampToMs = (value: { toMillis?: () => number } | undefined): number | null => {
  if (!value || typeof value.toMillis !== 'function') return null
  const ms = value.toMillis()
  return Number.isFinite(ms) ? ms : null
}

const formatMsDateTime = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Date(value).toLocaleString()
}

const parseTimeoutToMs = (timeoutAt: string | undefined): number | null => {
  if (!timeoutAt) return null
  const numeric = Number(timeoutAt)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(timeoutAt)
  return Number.isFinite(parsed) ? parsed : null
}

const formatRelativeSeconds = (
  valueMs: number | null | undefined,
  baselineMs: number | null
): string => {
  if (
    typeof valueMs !== 'number' ||
    !Number.isFinite(valueMs) ||
    baselineMs === null ||
    !Number.isFinite(baselineMs)
  ) {
    return '—'
  }
  return `${((valueMs - baselineMs) / 1000).toFixed(1)}s`
}

const formatMetricMs = (value: number | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${(value / 1000).toFixed(2)}s`
}

export default function GamePage() {
  const params = useParams()
  const { user } = useAuth()
  const gameId = params.id as string

  const [game, setGame] = useState<Game | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)
  const [changingAnswerId, setChangingAnswerId] = useState<string | null>(null)
  const [selectedEngineTag, setSelectedEngineTag] = useState<string | null>(null)
  const [livePredictions, setLivePredictions] = useState<Prediction[]>([])
  const [isStatsExpanded, setIsStatsExpanded] = useState(false)
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(new Set())
  const timerRef = React.useRef<HTMLDivElement>(null)
  const triggeredTimeRef = React.useRef<number>(0)
  const [playerCountHistory, setPlayerCountHistory] = useState<
    {
      t: number
      count: number
      ios: number
      android: number
      byPlatform?: { ios: number; android: number; unknown?: number }
    }[]
  >([])

  const getQuestionStats = React.useCallback((question: Question) => {
    const stats: any = (question as any).statistics || {}
    const totalResponses = stats.totalResponses ?? 0
    const playerCount = stats.playerCount ?? 0
    const responseRate =
      stats.responseRate ??
      (playerCount > 0 ? totalResponses / playerCount : 0)

    return {
      ...stats,
      totalResponses,
      playerCount,
      responseRate,
    }
  }, [])

  // Calculate real-time game statistics from questions
  const gameStats = React.useMemo(() => {
    if (questions.length === 0) return null

    const resolvedQuestions = questions.filter((q) => q.state === 'resolved')
    const cancelledQuestions = questions.filter((q) => q.state === 'cancelled')

    if (resolvedQuestions.length === 0) {
      return {
        totalQuestionsAsked: questions.length,
        totalResolved: resolvedQuestions.length,
        totalCancelled: cancelledQuestions.length,
        totalResponses: 0,
      }
    }

    let totalResponses = 0
    let totalCorrect = 0
    let totalIncorrect = 0
    const deliveryAvgs: number[] = []
    const openAvgs: number[] = []
    const respondAvgs: number[] = []
    const responseRates: number[] = []
    const platformTotals: Record<string, { responses: number }> = {}

    resolvedQuestions.forEach((q) => {
      const stats: any = getQuestionStats(q)
      totalResponses += stats.totalResponses || 0

      if (typeof stats.correctCount === 'number') totalCorrect += stats.correctCount
      if (typeof stats.incorrectCount === 'number')
        totalIncorrect += stats.incorrectCount

      if (typeof stats.delivery?.avg === 'number')
        deliveryAvgs.push(stats.delivery.avg)

      if (typeof stats.open?.avg === 'number') openAvgs.push(stats.open.avg)

      if (typeof stats.respond?.avg === 'number') respondAvgs.push(stats.respond.avg)

      if (typeof stats.responseRate === 'number')
        responseRates.push(stats.responseRate)

      if (stats.responseByPlatform) {
        Object.entries(stats.responseByPlatform as Record<string, any>).forEach(
          ([platform, platStats]: any) => {
            const existing = (platformTotals[platform] ||= { responses: 0 })
            existing.responses += platStats.totalResponses || 0
          }
        )
      }
    })

    const totalQuestionsAsked = questions.length
    const avgResponsesPerQuestion =
      totalQuestionsAsked > 0 ? totalResponses / totalQuestionsAsked : 0

    const totalPredictions = totalCorrect + totalIncorrect
    const accuracyRate =
      totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0

    const currentPlayerCount =
      playerCountHistory[playerCountHistory.length - 1]?.count ??
      (game as any)?.playerCount ?? 0
      0
    const currentPlayerCountByPlatform =
      playerCountHistory[playerCountHistory.length - 1]?.byPlatform ||
      (game as any)?.playerCountByPlatform ||
      {}
    const peakFromHistory =
      playerCountHistory.length > 0
        ? Math.max(...playerCountHistory.map((p) => p.count))
        : 0
    const peakPlayerCount =
      Math.max(
        peakFromHistory,
        (game as any)?.statistics?.highestPlayerCount ?? 0
      ) || undefined

    const buildMetric = (arr: number[]) =>
      arr.length
        ? {
            avg: arr.reduce((a, b) => a + b, 0) / arr.length,
            p50: getPercentile([...arr].sort((a, b) => a - b), 50),
            p95: getPercentile([...arr].sort((a, b) => a - b), 95),
          }
        : undefined

    return {
      totalQuestionsAsked,
      totalResolved: resolvedQuestions.length,
      totalCancelled: cancelledQuestions.length,
      totalResponses,
      avgResponsesPerQuestion: Math.round(avgResponsesPerQuestion * 100) / 100,
      totalCorrect,
      totalIncorrect,
      accuracyRate: Math.round(accuracyRate * 100) / 100,
      platformResponses:
        Object.keys(platformTotals).length > 0 ? platformTotals : undefined,
      currentPlayerCount,
      playerCountByPlatform: currentPlayerCountByPlatform,
      peakPlayerCount,
      delivery: buildMetric(deliveryAvgs),
      open: buildMetric(openAvgs),
      respond: buildMetric(respondAvgs),
      responseRateMetric: buildMetric(responseRates),
    }
  }, [getQuestionStats, questions, playerCountHistory, game])

  // Calculate statistics by engine tag
  const engineTagStats = React.useMemo(() => {
    const tagStats: Record<
      string,
      {
        count: number
        totalResponses: number
        totalPlayers: number
        avgResponseRate: number
        correctCount: number
        incorrectCount: number
      }
    > = {}

    questions
      .filter((q) => q.state === 'resolved' && q.engineTag)
      .forEach((q) => {
        const stats = getQuestionStats(q)
        const tag = q.engineTag!
        if (!tagStats[tag]) {
          tagStats[tag] = {
            count: 0,
            totalResponses: 0,
            totalPlayers: 0,
            avgResponseRate: 0,
            correctCount: 0,
            incorrectCount: 0,
          }
        }

        tagStats[tag].count++
        tagStats[tag].totalResponses += stats.totalResponses || 0
        tagStats[tag].totalPlayers += stats.playerCount || 0
        tagStats[tag].correctCount += stats.correctCount || 0
        tagStats[tag].incorrectCount += stats.incorrectCount || 0
      })

    // Calculate average response rate for each tag
    Object.keys(tagStats).forEach((tag) => {
      const stats = tagStats[tag]
      stats.avgResponseRate =
        stats.totalPlayers > 0
          ? (stats.totalResponses / stats.totalPlayers) * 100
          : 0
    })

    return tagStats
  }, [getQuestionStats, questions])

  // Prepare chart data from questions
  const chartData = React.useMemo(() => {
    const resolvedWithStats = questions
      .filter((q) => q.state === 'resolved' && q.statistics)
      .sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || 0
        const bTime = b.createdAt?.toMillis?.() || 0
        return aTime - bTime
      })

    return resolvedWithStats.map((q, index) => {
      const stats = getQuestionStats(q)
      const totalResponses = stats.totalResponses || 0
      const totalPlayers = stats.playerCount || 0
      const responseSourceCounts = stats.responseSourceCounts || {}
      const responseRate =
        stats.responseRate !== undefined
          ? stats.responseRate * 100
          : totalPlayers > 0
            ? (totalResponses / totalPlayers) * 100
            : 0
      const flattenedSources: Record<string, number> = {}
      Object.entries(responseSourceCounts).forEach(([key, value]) => {
        flattenedSources[`source__${key}`] = typeof value === 'number' ? value : 0
      })
      const iosResponses = stats.responseByPlatform?.ios?.totalResponses || 0
      const androidResponses =
        stats.responseByPlatform?.android?.totalResponses || 0

      return {
        questionNum: index + 1,
        questionName: `Q${index + 1}`,
        responseRate,
        ...flattenedSources,
        iosResponses,
        androidResponses,
        avgResponseTime:
          stats.respond?.avg !== undefined ? stats.respond.avg / 1000 : 0,
        avgDeliveryTime:
          stats.delivery?.avg !== undefined ? stats.delivery.avg / 1000 : 0,
        medianDeliveryTime:
          stats.delivery?.p50 !== undefined ? stats.delivery.p50 / 1000 : 0,
        p95DeliveryTime:
          stats.delivery?.p95 !== undefined ? stats.delivery.p95 / 1000 : 0,
        medianResponseTime:
          stats.respond?.p50 !== undefined ? stats.respond.p50 / 1000 : 0,
        p95ResponseTime:
          stats.respond?.p95 !== undefined ? stats.respond.p95 / 1000 : 0,
        accuracy:
        totalResponses > 0
            ? ((stats.correctCount || 0) / totalResponses) * 100
            : 0,
        totalResponses,
        responseSourceCounts: stats.responseSourceCounts || {},
      }
    })
  }, [getQuestionStats, questions])

  const responseSourceKeys = React.useMemo(() => {
    const set = new Set<string>()
    chartData.forEach((d) => {
      Object.keys(d).forEach((k) => {
        if (k.startsWith('source__')) set.add(k.replace('source__', ''))
      })
    })
    return Array.from(set)
  }, [chartData])

  const chartDataWithSources = React.useMemo(() => {
    if (responseSourceKeys.length === 0) return chartData
    return chartData.map((d) => {
      const filled: Record<string, number> = {}
      responseSourceKeys.forEach((key) => {
        const prop = `source__${key}`
        filled[prop] = typeof (d as any)[prop] === 'number' ? (d as any)[prop] : 0
      })
      return { ...filled, ...d }
    })
  }, [chartData, responseSourceKeys])

  // Calculate last question stats
const lastQuestionStats = React.useMemo(() => {
  if (questions.length === 0) return null

  const lastQuestion = questions[0] // Already sorted by createdAt desc
  const triggeredTime =
    lastQuestion.triggeredAt?.toMillis?.() || lastQuestion.createdAt?.toMillis?.() || 0

  // Update ref for timer (doesn't cause re-render)
  triggeredTimeRef.current = triggeredTime

  const stats: any = getQuestionStats(lastQuestion)

  let totalResponses = stats.totalResponses || 0
  const totalPlayers = stats.playerCount || 0
  let responseRate =
    stats.responseRate !== undefined
      ? stats.responseRate * 100
      : totalPlayers > 0
        ? (totalResponses / totalPlayers) * 100
        : 0
  const correctCount = stats.correctCount || 0
  const incorrectCount = stats.incorrectCount || 0
  let accuracy = 0

  const avgResponseMs =
    typeof stats.respond?.avg === 'number'
      ? stats.respond.avg
      : typeof (lastQuestion as any).avgResponseTimeMs === 'number'
        ? (lastQuestion as any).avgResponseTimeMs
        : undefined
  const avgResponseTime =
    typeof avgResponseMs === 'number' ? (avgResponseMs / 1000).toFixed(1) : '—'

  if (lastQuestion.state === 'open' || lastQuestion.state === 'closed') {
    // Calculate live stats from predictions
    totalResponses = livePredictions.length || totalResponses
    responseRate = totalPlayers > 0 ? (totalResponses / totalPlayers) * 100 : 0
  } else if (lastQuestion.state === 'resolved') {
    if (correctCount + incorrectCount > 0) {
      accuracy = (correctCount / (correctCount + incorrectCount)) * 100
    }
  }

  return {
    question: lastQuestion.question,
    engineTag: lastQuestion.engineTag || 'No tag',
    state: lastQuestion.state,
    responseRate,
    avgResponseTime,
    totalResponses,
    totalPlayers,
    triggeredTime, // Return triggeredTime instead of calculating timeSince here
    correctCount,
    incorrectCount,
    accuracy,
    statistics: stats,
  }
}, [getQuestionStats, livePredictions, questions])

  useEffect(() => {
    if (!user || !gameId) return

    // Listen to game document for live updates
    const gameUnsubscribe = onSnapshot(doc(db, 'games', gameId), (snapshot) => {
      if (snapshot.exists()) {
        const nextGame = { id: snapshot.id, ...snapshot.data() } as Game
        setGame(nextGame)
      }
    })

    // Listen to questions
    const q = query(
      collection(db, 'games', gameId, 'questions'),
      orderBy('createdAt', 'desc')
    )

    const questionsUnsubscribe = onSnapshot(q, (snapshot) => {
      const questionsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Question[]

      setQuestions(questionsData)
      setLoading(false)
    })

    return () => {
      gameUnsubscribe()
      questionsUnsubscribe()
    }
  }, [user, gameId])

  // Player count history (from backend writer)
  useEffect(() => {
    if (!user || !gameId) return

    const q = query(
      collection(db, 'games', gameId, 'playerCounts'),
      orderBy('createdAt', 'asc')
    )

    const unsub = onSnapshot(q, (snapshot) => {
      const history = snapshot.docs.map((doc) => {
        const data = doc.data() as any
        const ts =
          data.createdAt?.toMillis?.() ??
          Number(doc.id) ??
          Date.now()
        const ios = data.ios ?? 0
        const android = data.android ?? 0
        return {
          t: ts,
          count: data.count || 0,
          ios,
          android,
          byPlatform: {
            ios,
            android,
            unknown: data.unknown ?? 0,
          },
        }
      })
      setPlayerCountHistory(history)
    })

    return () => unsub()
  }, [user, gameId])

  // Listen to predictions for the last question (for live stats)
  useEffect(() => {
    if (!user || !gameId || questions.length === 0) return

    const lastQuestion = questions[0]
    if (!lastQuestion?.id) return

    const q = query(
      collection(db, 'games', gameId, 'questions', lastQuestion.id, 'predictions')
    )

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const predictionsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Prediction),
      }))
      setLivePredictions(predictionsData)
    })

    return () => unsubscribe()
  }, [user, gameId, questions])

  // Update timer display every second (without triggering re-renders)
  useEffect(() => {
    const updateTimer = () => {
      if (timerRef.current && triggeredTimeRef.current > 0) {
        const timeSinceLastMs = Date.now() - triggeredTimeRef.current
        const minutes = Math.floor(timeSinceLastMs / 60000)
        const seconds = String(Math.floor((timeSinceLastMs % 60000) / 1000)).padStart(2, '0')
        timerRef.current.textContent = `${minutes}:${seconds} ago`
      }
    }

    const interval = setInterval(updateTimer, 1000)
    return () => clearInterval(interval)
  }, [])

  const updateGameState = async (newState: Game['state']) => {
    if (!game) return

    try {
      if (newState === 'open') {
        await apiRequest('/api/games/' + gameId + '/start', { method: 'POST' })
      } else if (newState === 'resolved') {
        await apiRequest('/api/games/' + gameId + '/end', { method: 'POST' })
      } else {
        await updateDoc(doc(db, 'games', gameId), {
          state: newState,
        })
      }
    } catch (error: any) {
      console.error('Error updating game state:', error)
      alert(`Failed to update game state: ${error.message || error}`)
    }
  }

  const updateQuestionState = async (
    questionId: string,
    newState: Question['state']
  ) => {
    try {
      if (newState === 'closed') {
        await apiRequest(`/api/games/${gameId}/questions/${questionId}/close`, {
          method: 'POST',
        })
      } else if (newState === 'cancelled') {
        await apiRequest(`/api/games/${gameId}/questions/${questionId}/cancel`, {
          method: 'POST',
        })
      } else {
        await updateDoc(doc(db, 'games', gameId, 'questions', questionId), {
          state: newState,
          ...(newState === 'resolved' ? { resolvedAt: Timestamp.now() } : {}),
        })
      }
    } catch (error) {
      console.error('Error updating question state:', error)
      alert('Failed to update question state')
    }
  }

  const resolveQuestion = async (questionId: string, answer: string) => {
    try {
      await apiRequest(`/api/games/${gameId}/questions/${questionId}/resolve`, {
        method: 'POST',
        body: { answer },
      })
    } catch (error) {
      console.error('Error resolving question:', error)
      alert('Failed to resolve question')
    }
  }

  const createQuickQuestion = async (template: string) => {
    if (!game) return

    const questionText = template
      .replace('[HOMETEAM]', game.homeTeam)
      .replace('[AWAYTEAM]', game.awayTeam)

    try {
      await apiRequest(`/api/games/${gameId}/questions`, {
        method: 'POST',
        body: {
          question: questionText,
          choices: [
            { id: 'yes', value: 'Yes' },
            { id: 'no', value: 'No' },
          ],
          timeoutAt: (Date.now() + 30 * 1000).toString(),
          engineTag: selectedEngineTag || '',
          type: 'YESNO',
        },
      })
    } catch (error) {
      console.error('Error creating question:', error)
      alert('Failed to create question')
    }
  }

  const createResultQuestion = async () => {
    if (!game) return
    try {
      await apiRequest(`/api/games/${gameId}/questions`, {
        method: 'POST',
        body: {
          question: 'Result of game?',
          choices: [
            { id: 'home', value: `${game.homeTeam} wins` },
            { id: 'away', value: `${game.awayTeam} wins` },
            { id: 'tie', value: 'Tie' },
          ],
          timeoutAt: (Date.now() + 30 * 1000).toString(),
          engineTag: selectedEngineTag || '',
          type: 'MULTIPLE_CHOICE',
        },
      })
    } catch (error) {
      console.error('Error creating result question:', error)
      alert('Failed to create result question')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Game not found</div>
      </div>
    )
  }

  const questionTimelineBaselineMs = questions.reduce<number | null>((minMs, question) => {
    const candidateMs = timestampToMs(question.triggeredAt) ?? timestampToMs(question.createdAt)
    if (candidateMs === null) return minMs
    if (minMs === null) return candidateMs
    return candidateMs < minMs ? candidateMs : minMs
  }, null)

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <Link href="/" className="text-blue-600 hover:underline">
            ← Back to games
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-3xl font-bold mb-2">
                {game.homeTeam} vs {game.awayTeam}
              </h1>
              <div className="text-gray-600">
                {game.startTime?.toDate?.()?.toLocaleString() || 'No date'}
              </div>
            </div>
            <div className="flex gap-2">
              <span
                className={`px-3 py-1 rounded text-sm font-semibold ${
                  game.state === 'scheduled'
                    ? 'bg-gray-200 text-gray-700'
                    : game.state === 'open'
                      ? 'bg-green-200 text-green-700'
                      : game.state === 'resolved'
                        ? 'bg-blue-200 text-blue-700'
                        : 'bg-red-200 text-red-700'
                }`}
              >
                {game.state}
              </span>
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            {game.state === 'scheduled' && (
              <button
                onClick={() => updateGameState('open')}
                className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 cursor-pointer"
              >
                Start Game
              </button>
            )}
            {game.state === 'open' && (
              <button
                onClick={() => updateGameState('resolved')}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 cursor-pointer"
              >
                End Game
              </button>
            )}
            {game.state !== 'cancelled' && (
              <button
                onClick={() => updateGameState('cancelled')}
                className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 cursor-pointer"
              >
                Cancel Game
              </button>
            )}
          </div>

          {/* Global Game Statistics */}
          {gameStats && (
            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-4">
                📊 Game Statistics
                {game.state !== 'resolved' && (
                  <span className="ml-2 text-sm font-normal text-gray-600 dark:text-gray-400">
                    (Live)
                  </span>
                )}
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Question counts */}
                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Total Questions
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.totalQuestionsAsked}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Resolved
                  </div>
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {gameStats.totalResolved}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Cancelled
                  </div>
                  <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                    {gameStats.totalCancelled}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Total Responses
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.totalResponses}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Current Players
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.currentPlayerCount ?? '—'}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    iOS Players
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.playerCountByPlatform?.ios ?? '—'}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Android Players
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.playerCountByPlatform?.android ?? '—'}
                  </div>
                </div>

                {gameStats.platformResponses && (
                  <>
                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        iOS Responses
                      </div>
                      <div className="text-2xl font-bold text-gray-900 dark:text-white">
                        {gameStats.platformResponses.ios?.responses ?? '—'}
                      </div>
                    </div>
                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        Android Responses
                      </div>
                      <div className="text-2xl font-bold text-gray-900 dark:text-white">
                        {gameStats.platformResponses.android?.responses ?? '—'}
                      </div>
                    </div>
                  </>
                )}

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Current Players
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.currentPlayerCount ?? '—'}
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                    Peak Players
                  </div>
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {gameStats.peakPlayerCount ?? '—'}
                  </div>
                </div>

                {/* Engagement metrics */}
                {gameStats.avgResponsesPerQuestion !== undefined && (
                  <>
                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        Avg Responses/Question
                      </div>
                      <div className="text-2xl font-bold text-gray-900 dark:text-white">
                        {gameStats.avgResponsesPerQuestion}
                      </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        Avg Response Rate
                      </div>
                      <div className="text-2xl font-bold text-gray-900 dark:text-white">
                        {gameStats.responseRateMetric?.avg !== undefined
                          ? `${(gameStats.responseRateMetric.avg * 100).toFixed(1)}%`
                          : '—'}
                      </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        Player Accuracy
                      </div>
                      <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                        {gameStats.accuracyRate}%
                      </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                        Correct/Incorrect
                      </div>
                      <div className="text-lg font-bold text-gray-900 dark:text-white">
                        {gameStats.totalCorrect} / {gameStats.totalIncorrect}
                      </div>
                    </div>

                    {/* Timing metrics */}
                    {gameStats.delivery && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Delivery (avg/p50/p95)
                        </div>
                        <div className="text-lg font-semibold text-gray-900 dark:text-white">
                          {(gameStats.delivery.avg / 1000).toFixed(2)}s /{' '}
                          {(gameStats.delivery.p50 / 1000).toFixed(2)}s /{' '}
                          {(gameStats.delivery.p95 / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {gameStats.open && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Open (avg/p50/p95)
                        </div>
                        <div className="text-lg font-semibold text-gray-900 dark:text-white">
                          {(gameStats.open.avg / 1000).toFixed(2)}s /{' '}
                          {(gameStats.open.p50 / 1000).toFixed(2)}s /{' '}
                          {(gameStats.open.p95 / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {gameStats.respond && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Respond (avg/p50/p95)
                        </div>
                        <div className="text-lg font-semibold text-gray-900 dark:text-white">
                          {(gameStats.respond.avg / 1000).toFixed(2)}s /{' '}
                          {(gameStats.respond.p50 / 1000).toFixed(2)}s /{' '}
                          {(gameStats.respond.p95 / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {gameStats.responseRateMetric && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Response Rate (avg/p50/p95)
                        </div>
                        <div className="text-lg font-semibold text-gray-900 dark:text-white">
                          {(gameStats.responseRateMetric.avg * 100).toFixed(1)}% /{' '}
                          {(gameStats.responseRateMetric.p50 * 100).toFixed(1)}% /{' '}
                          {(gameStats.responseRateMetric.p95 * 100).toFixed(1)}%
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Engine Tag Statistics */}
              {Object.keys(engineTagStats).length > 0 && (
                <div className="mt-6">
                  <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                    📌 Engine Tag Performance
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Object.entries(engineTagStats)
                      .sort((a, b) => b[1].count - a[1].count)
                      .map(([tag, stats]) => (
                        <div
                          key={tag}
                          className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700"
                        >
                          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                            {tag.replace(/_/g, ' ')}
                          </div>
                          <div className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                            <div className="flex justify-between">
                              <span>Questions:</span>
                              <span className="font-medium">{stats.count}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Avg Response Rate:</span>
                              <span className="font-medium text-blue-600 dark:text-blue-400">
                                {stats.avgResponseRate.toFixed(1)}%
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span>Total Responses:</span>
                              <span className="font-medium">{stats.totalResponses}</span>
                            </div>
                            {stats.correctCount + stats.incorrectCount > 0 && (
                              <div className="flex justify-between">
                                <span>Accuracy:</span>
                                <span className="font-medium text-green-600 dark:text-green-400">
                                  {(
                                    (stats.correctCount /
                                      (stats.correctCount + stats.incorrectCount)) *
                                    100
                                  ).toFixed(1)}
                                  %
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Charts Section */}
              {chartData.length > 0 && (
                <div className="mt-6">
                  <button
                    onClick={() => setIsStatsExpanded(!isStatsExpanded)}
                    className="w-full flex items-center justify-between bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 p-4 rounded-lg cursor-pointer transition-colors mb-4"
                  >
                    <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
                      📊 Per-Question Statistics & Charts
                    </h3>
                    <span className="text-2xl text-gray-600 dark:text-gray-400">
                      {isStatsExpanded ? '−' : '+'}
                    </span>
                  </button>

                  {isStatsExpanded && (
                    <div className="space-y-6">
                      {/* Response Rate & Engagement Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Response Rate & Engagement
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartDataWithSources}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis yAxisId="left" label={{ value: 'Response Rate (%)', angle: -90, position: 'insideLeft' }} />
                        <YAxis yAxisId="right" orientation="right" label={{ value: 'Responses', angle: 90, position: 'insideRight' }} />
                        <Tooltip />
                        <Legend />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="responseRate"
                          stroke="#3b82f6"
                          name="Response Rate (%)"
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalResponses"
                          stroke="#10b981"
                          name="Total Responses"
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="iosResponses"
                          stroke="#6366f1"
                          name="iOS Responses"
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="androidResponses"
                          stroke="#f97316"
                          name="Android Responses"
                          strokeWidth={2}
                        />
                        {responseSourceKeys.map((sourceKey, idx) => {
                          const colors = ['#6366f1', '#f97316', '#06b6d4', '#a855f7', '#ef4444']
                          return (
                            <Line
                              key={sourceKey}
                              yAxisId="right"
                              type="monotone"
                              dataKey={`source__${sourceKey}`}
                              stroke={colors[idx % colors.length]}
                              name={`${sourceKey} Responses`}
                              strokeWidth={2}
                              strokeDasharray={idx % 2 === 0 ? '4 4' : '2 6'}
                            />
                          )
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Player Count */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Player Count
                    </h4>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={playerCountHistory}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="t"
                          tickFormatter={(t) =>
                            new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                          }
                        />
                        <YAxis allowDecimals={false} />
                        <Tooltip
                          labelFormatter={(t) =>
                            new Date(t as number).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })
                          }
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="count"
                          stroke="#6366f1"
                          name="Total"
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="ios"
                          stroke="#2563eb"
                          name="iOS"
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="android"
                          stroke="#f59e0b"
                          name="Android"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Response Time Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Response Times (seconds)
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis label={{ value: 'Time (seconds)', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="avgResponseTime"
                          stroke="#8b5cf6"
                          name="Average"
                          strokeWidth={2}
                        />
                        <Line
                          type="monotone"
                          dataKey="medianResponseTime"
                          stroke="#06b6d4"
                          name="Median"
                          strokeWidth={2}
                        />
                        <Line
                          type="monotone"
                          dataKey="p95ResponseTime"
                          stroke="#f59e0b"
                          name="95th Percentile"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Delivery Time Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Notification Delivery Times (seconds)
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis label={{ value: 'Time (seconds)', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="avgDeliveryTime"
                          stroke="#14b8a6"
                          name="Avg Delivery Time"
                          strokeWidth={2}
                        />
                        <Line
                          type="monotone"
                          dataKey="medianDeliveryTime"
                          stroke="#0ea5e9"
                          name="Median Delivery Time"
                          strokeWidth={2}
                        />
                        <Line
                          type="monotone"
                          dataKey="p95DeliveryTime"
                          stroke="#f97316"
                          name="95th Percentile"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Accuracy Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Player Accuracy
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis domain={[0, 100]} label={{ value: 'Accuracy (%)', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="accuracy"
                          stroke="#ef4444"
                          name="Accuracy (%)"
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Quick Question Triggers */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">
            Quick Question Triggers
          </h2>

          {/* Engine Tags */}
          <div className="mb-6 space-y-3">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">
                GAME MOMENT TAGS
              </h3>
              <div className="flex flex-wrap gap-2">
                {['SCORE_EVENT', 'BIG_PLAY', 'START_OF_DRIVE', 'DEAD_TIME', 'RED_ZONE', 'FIELD_GOAL_SETUP', '4TH_DOWN', 'TWO_MINUTE_WARNING', 'CHALLENGE_REVIEW', 'RETURN_PLAY', 'TURNOVER', 'INJURY_TIMEOUT', 'HALFTIME', 'START_OF_QUARTER'].map(
                  (tag) => (
                    <button
                      key={tag}
                      onClick={() =>
                        setSelectedEngineTag(selectedEngineTag === tag ? null : tag)
                      }
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                        selectedEngineTag === tag
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {tag.replace(/_/g, ' ')}
                    </button>
                  )
                )}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">
                PACING TAGS
              </h3>
              <div className="flex flex-wrap gap-2">
                {['ENGAGEMENT_BOOSTER', 'TIME_BASED_CADENCE'].map((tag) => (
                  <button
                    key={tag}
                    onClick={() =>
                      setSelectedEngineTag(selectedEngineTag === tag ? null : tag)
                    }
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                      selectedEngineTag === tag
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {tag.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">
                CONTENT TAGS
              </h3>
              <div className="flex flex-wrap gap-2">
                {['LONGTERM', 'FUN_BREAK', 'DIFFICULTY_SPIKE'].map((tag) => (
                  <button
                    key={tag}
                    onClick={() =>
                      setSelectedEngineTag(selectedEngineTag === tag ? null : tag)
                    }
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                      selectedEngineTag === tag
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {tag.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>

            {selectedEngineTag && (
              <div className="text-sm text-blue-600 font-medium">
                Selected: {selectedEngineTag.replace(/_/g, ' ')}
              </div>
            )}
          </div>

          {/* Kickoff / Pre-Game */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Kickoff / Pre-Game
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] win?')
                }
                className="bg-blue-100 hover:bg-blue-200 text-blue-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏆 Home team win?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the coin toss be heads?')
                }
                className="bg-amber-100 hover:bg-amber-200 text-amber-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🪙 Coin toss heads?
              </button>
              <button
                onClick={createResultQuestion}
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏁 Result of game (Home/Away/Tie)
              </button>
            </div>
          </div>

          {/* Game/Half/Quarter */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Game / Half / Quarter
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will there be a score in this quarter?')
                }
                className="bg-purple-100 hover:bg-purple-200 text-purple-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⏱️ Score this quarter?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] score before halftime?')
                }
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏁 Home score before half?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] score before halftime?')
                }
                className="bg-pink-100 hover:bg-pink-200 text-pink-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏁 Away score before half?
              </button>
            </div>
          </div>

          {/* Drive */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Drive
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will this drive result in a score?')
                }
                className="bg-blue-100 hover:bg-blue-200 text-blue-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                📊 Score on drive?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] score on this drive?')
                }
                className="bg-green-100 hover:bg-green-200 text-green-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏠 Home team score?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] score on this drive?')
                }
                className="bg-teal-100 hover:bg-teal-200 text-teal-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ✈️ Away team score?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this red zone drive end in a TD?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔴 Red zone TD?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] go 3-and-out?')
                }
                className="bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔥 Home 3-and-out?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] stop them here?')
                }
                className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                💪 Away team stop?
              </button>
            </div>
          </div>

          {/* Play - Scoring */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Play - Scoring
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play result in a touchdown?')
                }
                className="bg-green-100 hover:bg-green-200 text-green-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏈 Touchdown?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the field goal be good?')
                }
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🎯 Field goal good?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the extra point be good?')
                }
                className="bg-amber-100 hover:bg-amber-200 text-amber-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🎊 Extra point?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the 2-point conversion succeed?')
                }
                className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏁 2-point conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play result in a safety?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🛡️ Safety?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the defense score on the next play?')
                }
                className="bg-rose-100 hover:bg-rose-200 text-rose-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔙 Defensive score?
              </button>
            </div>
          </div>

          {/* Play - Downs & Yardage */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Play - Downs & Yardage
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play be a first down?')
                }
                className="bg-lime-100 hover:bg-lime-200 text-lime-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⬇️ First down?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will they convert this 3rd down?')
                }
                className="bg-emerald-100 hover:bg-emerald-200 text-emerald-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⚡ 3rd down conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will they convert this 4th down?')
                }
                className="bg-cyan-100 hover:bg-cyan-200 text-cyan-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🎲 4th down conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play gain 20+ yards?')
                }
                className="bg-sky-100 hover:bg-sky-200 text-sky-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                💨 Big play (20+ yards)?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next run gain 10+ yards?')
                }
                className="bg-violet-100 hover:bg-violet-200 text-violet-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏃 Run 10+ yards?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next pass gain 15+ yards?')
                }
                className="bg-fuchsia-100 hover:bg-fuchsia-200 text-fuchsia-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                📡 Pass 15+ yards?
              </button>
            </div>
          </div>

          {/* Play - Outcomes */}
          <div>
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Play - Outcomes
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() => createQuickQuestion('Will the next pass be completed?')}
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ✅ Completion?
              </button>
              <button
                onClick={() => createQuickQuestion('Will the next play be a sack?')}
                className="bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                💥 Sack?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play result in a turnover?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔄 Turnover?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play result in an interception?')
                }
                className="bg-rose-100 hover:bg-rose-200 text-rose-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🎯 Interception?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the next play result in a fumble?')
                }
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔁 Fumble?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will there be a penalty on the next play?')
                }
                className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🚩 Penalty?
              </button>
              <button
                onClick={() => createQuickQuestion('Will they punt?')}
                className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🦵 Punt?
              </button>
            </div>
          </div>

          {/* Special Situations */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-600 mb-2 uppercase">
              Special Situations
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <button
                onClick={() =>
                  createQuickQuestion('Will the kickoff return go 25+ yards?')
                }
                className="bg-purple-100 hover:bg-purple-200 text-purple-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🚀 Kickoff return 25+?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the punt return gain 10+ yards?')
                }
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⚡ Punt return 10+?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will there be a score in the final 2-minutes?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⏰ Score in 2-min drill?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the challenge be successful?')
                }
                className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🚩 Challenge successful?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will play resume in under 5 minutes?')
                }
                className="bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🏥 Quick injury timeout?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will there be a turnover on the return?')
                }
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                🔄 Return turnover?
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Questions</h2>
            <Link
              href={`/games/${gameId}/questions/new`}
              className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300 text-sm cursor-pointer"
            >
              Custom Question
            </Link>
          </div>

          {questions.length > 0 && (
            <div className="px-6 py-4 border-b bg-gray-50">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="text-sm font-semibold text-gray-800">
                  Debug Question Table
                </h3>
                <span className="text-xs text-gray-500">
                  Includes resolution, reason, and timing fields
                </span>
              </div>
              <div className="overflow-auto border border-gray-200 rounded-md bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Question</th>
                      <th className="text-left px-3 py-2">Resolution</th>
                      <th className="text-left px-3 py-2">Reason</th>
                      <th className="text-left px-3 py-2">Timing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {[...questions].reverse().map((question, index) => {
                      const stats = question.statistics
                      const createdAtMs = timestampToMs(question.createdAt)
                      const triggeredAtMs = timestampToMs(question.triggeredAt)
                      const closedAtMs = timestampToMs(question.closedAt)
                      const resolvedAtMs = timestampToMs(question.resolvedAt)
                      const cancelledAtMs = timestampToMs(question.cancelledAt)
                      const timeoutAtMs = parseTimeoutToMs(question.timeoutAt)
                      const answerLabel = question.answer
                        ? (question.choices.find((choice) =>
                            typeof choice === 'string'
                              ? choice === question.answer
                              : choice.id === question.answer || choice.value === question.answer
                          ) ?? question.answer)
                        : null
                      const answerText =
                        typeof answerLabel === 'string'
                          ? answerLabel
                          : answerLabel && typeof answerLabel !== 'string'
                            ? answerLabel.value
                            : null

                      return (
                        <tr key={`debug-${question.id}`}>
                          <td className="px-3 py-2 align-top text-gray-500">{index + 1}</td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-sm text-gray-900">
                              {question.question}
                            </div>
                            <div className="text-gray-600 mt-1">
                              {question.choices
                                .map((choice) =>
                                  typeof choice === 'string' ? choice : choice.value
                                )
                                .join(', ')}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium">{question.state}</div>
                            <div className="text-gray-600 mt-1">
                              ans={answerText ?? question.answer ?? '—'}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-gray-700">
                            <div>engineTag: {question.engineTag ?? '—'}</div>
                            <div>cancel: {question.cancelReason ?? '—'}</div>
                            <div>window: {question.windowType ?? '—'}</div>
                          </td>
                          <td className="px-3 py-2 align-top text-gray-700">
                            <div>created: {formatMsDateTime(createdAtMs)}</div>
                            <div>triggered: {formatMsDateTime(triggeredAtMs)}</div>
                            <div>timeout: {formatMsDateTime(timeoutAtMs)}</div>
                            <div>
                              done:{' '}
                              {formatMsDateTime(
                                resolvedAtMs ?? cancelledAtMs ?? closedAtMs
                              )}
                            </div>
                            <div>
                              rel trigger:{' '}
                              {formatRelativeSeconds(
                                triggeredAtMs ?? createdAtMs,
                                questionTimelineBaselineMs
                              )}
                            </div>
                            <div className="mt-1 text-gray-500">
                              delivery/open/respond:{' '}
                              {formatMetricMs(stats?.delivery?.avg)} /{' '}
                              {formatMetricMs(stats?.open?.avg)} /{' '}
                              {formatMetricMs(stats?.respond?.avg)}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

              <div className="divide-y">
            {questions.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No questions yet. Create your first question!
              </div>
            ) : (
              questions.map((question) => {
                const stats = getQuestionStats(question)
                const totalResponses = stats.totalResponses ?? 0
                const playerCount = stats.playerCount
                const totalPlayers = playerCount ?? 0
                const responseRate =
                  stats.responseRate !== undefined
                    ? stats.responseRate * 100
                    : totalPlayers > 0
                      ? (totalResponses / totalPlayers) * 100
                      : 0
                const unanswered =
                  stats.unanswered !== undefined
                    ? stats.unanswered
                    : playerCount !== undefined
                      ? Math.max(totalPlayers - totalResponses, 0)
                      : undefined
                const accuracy =
                  stats && totalResponses > 0
                    ? ((stats.correctCount || 0) / totalResponses) * 100
                    : undefined
                const choiceBreakdown: { choiceId: string; count: number; label: string }[] =
                  stats?.choiceCounts
                    ? (Object.entries(stats.choiceCounts as Record<string, number>)
                        .sort((a, b) => b[1] - a[1])
                        .map(([choiceId, count]) => {
                          const match = question.choices.find((c) =>
                            typeof c === 'string'
                              ? c === choiceId
                              : c.id === choiceId || c.value === choiceId
                          )
                          const label =
                            typeof match === 'string'
                              ? match
                              : match?.value || choiceId

                          return {
                            choiceId,
                            count,
                            label,
                          }
                        }) as { choiceId: string; count: number; label: string }[])
                    : []

                return (
                  <div key={question.id} className="px-6 py-4">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-semibold">
                            {question.question}
                          </span>
                          <span
                            className={`px-2 py-1 rounded text-xs ${
                              question.state === 'open'
                                ? 'bg-green-200 text-green-700'
                                : question.state === 'closed'
                                  ? 'bg-yellow-200 text-yellow-700'
                                  : question.state === 'resolved'
                                    ? 'bg-blue-200 text-blue-700'
                                    : 'bg-red-200 text-red-700'
                            }`}
                          >
                            {question.state}
                          </span>
                        </div>
                        <div className="text-sm text-gray-600">
                          Choices:{' '}
                          {question.choices
                            .map((c) => (typeof c === 'string' ? c : c.value))
                            .join(', ')}
                        </div>
                        {question.answer !== undefined && (
                          <div className="text-sm text-green-600 mt-1">
                            Answer:{' '}
                            {(() => {
                              const match = question.choices.find((c) =>
                                typeof c === 'string'
                                  ? c === question.answer
                                  : c.id === question.answer || c.value === question.answer
                              )
                              if (!match) return question.answer
                              return typeof match === 'string' ? match : match.value
                            })()}
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mt-1">
                          Created:{' '}
                          {question.createdAt?.toDate?.()?.toLocaleString()}
                        </div>
                        {question.engineTag && (
                          <div className="mt-1">
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200">
                              🏷️ {question.engineTag.replace(/_/g, ' ')}
                            </span>
                          </div>
                        )}

                        {/* Show statistics for resolved or cancelled questions */}
                        {(question.state === 'resolved' ||
                          question.state === 'cancelled') &&
                          stats && (
                            <div className="mt-3">
                              <button
                                onClick={() => {
                                  const newExpanded = new Set(expandedQuestions)
                                  if (newExpanded.has(question.id)) {
                                    newExpanded.delete(question.id)
                                  } else {
                                    newExpanded.add(question.id)
                                  }
                                  setExpandedQuestions(newExpanded)
                                }}
                                className="w-full flex items-center justify-between p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs cursor-pointer transition-colors"
                              >
                                <span className="font-semibold text-gray-700 dark:text-gray-300">
                                  📊 Statistics
                                </span>
                                <span className="text-lg text-gray-600 dark:text-gray-400">
                                  {expandedQuestions.has(question.id) ? '−' : '+'}
                                </span>
                              </button>

                              {expandedQuestions.has(question.id) && (
                                <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded text-xs space-y-2">
                                  {/* Response metrics */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <span className="text-gray-600 dark:text-gray-400">
                                        Responses:
                                      </span>{' '}
                                      <span className="font-medium">
                                        {totalResponses} / {playerCount ?? '—'} (
                                        {responseRate.toFixed(1)}%)
                                      </span>
                                    </div>
                                    {unanswered !== undefined && (
                                      <div>
                                        <span className="text-gray-600 dark:text-gray-400">
                                          Unanswered:
                                        </span>{' '}
                                        <span className="font-medium">
                                          {unanswered}
                                        </span>
                                      </div>
                                    )}
                                    {accuracy !== undefined && (
                                      <div className="col-span-2">
                                        <span className="text-gray-600 dark:text-gray-400">
                                          Accuracy:
                                        </span>{' '}
                                        <span className="font-medium text-green-700 dark:text-green-300">
                                          {accuracy.toFixed(1)}% ({stats?.correctCount || 0} /{' '}
                                          {stats?.incorrectCount || 0})
                                        </span>
                                      </div>
                                    )}
                                    {stats?.nseMissingCount !== undefined &&
                                      stats.nseMissingCount > 0 && (
                                        <div className="col-span-2">
                                          <span className="text-gray-600 dark:text-gray-400">
                                            NSE missing notificationReceivedAt:
                                          </span>{' '}
                                          <span className="font-medium text-red-700 dark:text-red-300">
                                            {stats.nseMissingCount}
                                          </span>
                                        </div>
                                      )}
                                  </div>

                                  {choiceBreakdown.length > 0 && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Choice Breakdown:
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        {choiceBreakdown.map((choice) => (
                                          <span
                                            key={choice.choiceId}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
                                          >
                                            <span className="text-gray-700 dark:text-gray-200">
                                              {choice.label}:
                                            </span>
                                            <span className="font-semibold text-gray-900 dark:text-white">
                                              {choice.count}
                                            </span>
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {stats.delivery && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Delivery (avg/p50/p95):
                                      </div>
                                      <div className="text-lg font-semibold">
                                        {(stats.delivery.avg / 1000).toFixed(2)}s /{' '}
                                        {(stats.delivery.p50 / 1000).toFixed(2)}s /{' '}
                                        {(stats.delivery.p95 / 1000).toFixed(2)}s
                                      </div>
                                    </div>
                                  )}

                                  {stats.open && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Open (avg/p50/p95):
                                      </div>
                                      <div className="text-lg font-semibold">
                                        {(stats.open.avg / 1000).toFixed(2)}s /{' '}
                                        {(stats.open.p50 / 1000).toFixed(2)}s /{' '}
                                        {(stats.open.p95 / 1000).toFixed(2)}s
                                      </div>
                                    </div>
                                  )}

                                  {stats.respond && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Respond (avg/p50/p95):
                                      </div>
                                      <div className="text-lg font-semibold">
                                        {(stats.respond.avg / 1000).toFixed(2)}s /{' '}
                                        {(stats.respond.p50 / 1000).toFixed(2)}s /{' '}
                                        {(stats.respond.p95 / 1000).toFixed(2)}s
                                      </div>
                                    </div>
                                  )}

                                  {stats.timeRemainingAtReceive && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Time Remaining at Receive (avg/p50/p95):
                                      </div>
                                      <div className="text-lg font-semibold">
                                        {(stats.timeRemainingAtReceive.avg / 1000).toFixed(2)}s /{' '}
                                        {(stats.timeRemainingAtReceive.p50 / 1000).toFixed(2)}s /{' '}
                                        {(stats.timeRemainingAtReceive.p95 / 1000).toFixed(2)}s
                                      </div>
                                    </div>
                                  )}

                                  {stats.timeRemainingAtOpen && (
                                    <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                      <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                        Time Remaining at Open (avg/p50/p95):
                                      </div>
                                      <div className="text-lg font-semibold">
                                        {(stats.timeRemainingAtOpen.avg / 1000).toFixed(2)}s /{' '}
                                        {(stats.timeRemainingAtOpen.p50 / 1000).toFixed(2)}s /{' '}
                                        {(stats.timeRemainingAtOpen.p95 / 1000).toFixed(2)}s
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                      </div>
                      <div className="flex gap-2">
                        {question.state === 'open' && (
                          <button
                            onClick={() =>
                              updateQuestionState(question.id, 'closed')
                            }
                            className="bg-yellow-600 text-white px-3 py-1 rounded text-sm hover:bg-yellow-700 cursor-pointer"
                          >
                            Close
                          </button>
                        )}
                      {question.state === 'closed' && (
                        <>
                          <button
                            onClick={() =>
                              updateQuestionState(question.id, 'open')
                            }
                            className="bg-gray-400 text-white px-3 py-1 rounded text-sm hover:bg-gray-500 cursor-pointer"
                          >
                            Reopen
                          </button>
                          {question.choices.map((choice) => {
                            const label =
                              typeof choice === 'string' ? choice : choice.value
                            const choiceId =
                              typeof choice === 'string' ? choice : choice.id
                            return (
                              <button
                                key={choiceId}
                                onClick={() => resolveQuestion(question.id, choiceId)}
                                className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 cursor-pointer"
                              >
                                {label}
                              </button>
                            )
                          })}
                        </>
                      )}
                        {question.state === 'resolved' && (
                          <>
                          {changingAnswerId === question.id ? (
                            <>
                              {question.choices.map((choice) => {
                                const label =
                                  typeof choice === 'string' ? choice : choice.value
                                const choiceId =
                                  typeof choice === 'string' ? choice : choice.id
                                return (
                                  <button
                                    key={choiceId}
                                    onClick={() => {
                                      resolveQuestion(question.id, choiceId)
                                      setChangingAnswerId(null)
                                    }}
                                    className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 cursor-pointer"
                                  >
                                    {label}
                                  </button>
                                )
                              })}
                              <button
                                onClick={() => setChangingAnswerId(null)}
                                className="bg-gray-400 text-white px-3 py-1 rounded text-sm hover:bg-gray-500 cursor-pointer"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setChangingAnswerId(question.id)}
                              className="bg-orange-600 text-white px-3 py-1 rounded text-sm hover:bg-orange-700 cursor-pointer"
                            >
                              Change Answer
                            </button>
                          )}
                        </>
                      )}
                        {question.state !== 'cancelled' && (
                          <button
                            onClick={() =>
                              updateQuestionState(question.id, 'cancelled')
                            }
                            className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 cursor-pointer"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Last Question Bar */}
      {lastQuestionStats && (
        <div className="fixed top-4 right-4 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center gap-2 shadow-lg rounded-md">
          <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide">
            Last Question
          </span>
          <span ref={timerRef} className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400">
            0:00 ago
          </span>
        </div>
      )}
    </div>
  )
}
