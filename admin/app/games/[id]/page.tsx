'use client'

import { useAuth } from '@/components/AuthProvider'
import { db } from '@/lib/firebase'
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import React, { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

// Import types from parent project
import type { Game, Question } from '@/types'

export default function GamePage() {
  const params = useParams()
  const { user } = useAuth()
  const gameId = params.id as string

  const [game, setGame] = useState<Game | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)
  const [changingAnswerId, setChangingAnswerId] = useState<string | null>(null)
  const [selectedEngineTag, setSelectedEngineTag] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [livePredictions, setLivePredictions] = useState<any[]>([])

  // Calculate real-time game statistics from questions
  const gameStats = React.useMemo(() => {
    if (questions.length === 0) return null

    const resolvedQuestions = questions.filter((q) => q.state === 'resolved')
    const cancelledQuestions = questions.filter((q) => q.state === 'cancelled')
    const resolvedWithStats = resolvedQuestions.filter(
      (q) => q.totalResponses !== undefined
    )

    if (resolvedWithStats.length === 0) {
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
    let totalResponseTime = 0
    let totalDeliveryTime = 0
    let totalQuestionOpenTime = 0
    let questionsWithResponseTime = 0
    let questionsWithDeliveryTime = 0
    let questionsWithOpenTime = 0
    const allResponseRates: number[] = []
    const allResolutionTimes: number[] = []

    resolvedWithStats.forEach((q) => {
      totalResponses += q.totalResponses || 0

      if (q.correctCount !== undefined) {
        totalCorrect += q.correctCount
      }
      if (q.incorrectCount !== undefined) {
        totalIncorrect += q.incorrectCount
      }

      if (q.avgResponseTimeMs !== undefined && q.avgResponseTimeMs > 0) {
        totalResponseTime += q.avgResponseTimeMs
        questionsWithResponseTime++
      }

      if (q.avgDeliveryTimeMs !== undefined && q.avgDeliveryTimeMs > 0) {
        totalDeliveryTime += q.avgDeliveryTimeMs
        questionsWithDeliveryTime++
      }

      if (q.questionOpenTimeMs !== undefined && q.questionOpenTimeMs > 0) {
        totalQuestionOpenTime += q.questionOpenTimeMs
        questionsWithOpenTime++
      }

      if (q.questionResolutionTimeMs !== undefined && q.questionResolutionTimeMs > 0) {
        allResolutionTimes.push(q.questionResolutionTimeMs)
      }

      if (q.responseRate !== undefined) {
        allResponseRates.push(q.responseRate)
      }
    })

    // Helper function to calculate percentile
    const getPercentile = (sortedArray: number[], percentile: number): number => {
      if (sortedArray.length === 0) return 0
      const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
      return sortedArray[Math.max(0, index)]
    }

    const avgResponsesPerQuestion =
      resolvedWithStats.length > 0 ? totalResponses / resolvedWithStats.length : 0
    const avgResponseRate =
      allResponseRates.length > 0
        ? allResponseRates.reduce((a, b) => a + b, 0) / allResponseRates.length
        : 0
    const avgResponseTimeMs =
      questionsWithResponseTime > 0
        ? totalResponseTime / questionsWithResponseTime
        : 0
    const avgDeliveryTimeMs =
      questionsWithDeliveryTime > 0
        ? totalDeliveryTime / questionsWithDeliveryTime
        : 0
    const avgQuestionOpenTimeMs =
      questionsWithOpenTime > 0 ? totalQuestionOpenTime / questionsWithOpenTime : 0

    // Calculate resolution time statistics
    allResolutionTimes.sort((a, b) => a - b)
    const avgResolutionTimeMs =
      allResolutionTimes.length > 0
        ? allResolutionTimes.reduce((a, b) => a + b, 0) / allResolutionTimes.length
        : 0
    const medianResolutionTimeMs = getPercentile(allResolutionTimes, 50)
    const p95ResolutionTimeMs = getPercentile(allResolutionTimes, 95)

    const totalPredictions = totalCorrect + totalIncorrect
    const accuracyRate =
      totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0

    return {
      totalQuestionsAsked: questions.length,
      totalResolved: resolvedQuestions.length,
      totalCancelled: cancelledQuestions.length,
      totalResponses,
      avgResponsesPerQuestion: Math.round(avgResponsesPerQuestion * 100) / 100,
      avgResponseRate: Math.round(avgResponseRate * 100) / 100,
      totalCorrect,
      totalIncorrect,
      accuracyRate: Math.round(accuracyRate * 100) / 100,
      avgResponseTimeMs: Math.round(avgResponseTimeMs),
      avgDeliveryTimeMs: Math.round(avgDeliveryTimeMs),
      avgQuestionOpenTimeMs: Math.round(avgQuestionOpenTimeMs),
      avgResolutionTimeMs: Math.round(avgResolutionTimeMs),
      medianResolutionTimeMs: Math.round(medianResolutionTimeMs),
      p95ResolutionTimeMs: Math.round(p95ResolutionTimeMs),
    }
  }, [questions])

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
        tagStats[tag].totalResponses += q.totalResponses || 0
        tagStats[tag].totalPlayers += q.totalPlayers || 0
        tagStats[tag].correctCount += q.correctCount || 0
        tagStats[tag].incorrectCount += q.incorrectCount || 0
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
  }, [questions])

  // Prepare chart data from questions
  const chartData = React.useMemo(() => {
    const resolvedWithStats = questions
      .filter((q) => q.state === 'resolved' && q.totalResponses !== undefined)
      .sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || 0
        const bTime = b.createdAt?.toMillis?.() || 0
        return aTime - bTime
      })

    return resolvedWithStats.map((q, index) => ({
      questionNum: index + 1,
      questionName: `Q${index + 1}`,
      responseRate: q.responseRate || 0,
      questionOpenTime: q.questionOpenTimeMs ? q.questionOpenTimeMs / 1000 : 0,
      questionResolutionTime: q.questionResolutionTimeMs
        ? q.questionResolutionTimeMs / 1000
        : 0,
      avgResponseTime: q.avgResponseTimeMs ? q.avgResponseTimeMs / 1000 : 0,
      avgDeliveryTime: q.avgDeliveryTimeMs ? q.avgDeliveryTimeMs / 1000 : 0,
      medianResponseTime: q.medianResponseTimeMs
        ? q.medianResponseTimeMs / 1000
        : 0,
      p95ResponseTime: q.p95ResponseTimeMs ? q.p95ResponseTimeMs / 1000 : 0,
      accuracy:
        q.totalResponses && q.totalResponses > 0
          ? ((q.correctCount || 0) / q.totalResponses) * 100
          : 0,
      totalResponses: q.totalResponses || 0,
    }))
  }, [questions])

  // Calculate last question stats
  const lastQuestionStats = React.useMemo(() => {
    if (questions.length === 0) return null

    const lastQuestion = questions[0] // Already sorted by createdAt desc
    const triggeredTime = lastQuestion.triggeredAt?.toMillis?.() || lastQuestion.createdAt?.toMillis?.() || 0
    const timeSinceLastMs = triggeredTime > 0 ? currentTime - triggeredTime : 0

    // Use live predictions for open/closed questions, otherwise use stored stats
    let totalResponses = lastQuestion.totalResponses || 0
    let responseRate = lastQuestion.responseRate || 0
    let avgResponseTime = lastQuestion.avgResponseTimeMs ? (lastQuestion.avgResponseTimeMs / 1000).toFixed(1) : 'N/A'
    const totalPlayers = game?.userCount || lastQuestion.totalPlayers || 0
    const correctCount = lastQuestion.correctCount || 0
    const incorrectCount = lastQuestion.incorrectCount || 0
    let accuracy = 0

    if (lastQuestion.state === 'open' || lastQuestion.state === 'closed') {
      // Calculate live stats from predictions
      totalResponses = livePredictions.length
      responseRate = totalPlayers > 0 ? (totalResponses / totalPlayers) * 100 : 0

      // Calculate average response time (from when notification was received to when user answered)
      // This is the most meaningful metric - how quickly users respond after seeing the notification
      const validResponseTimes = livePredictions
        .map((p: any) => {
          const predictionCreatedAt = p.createdAt?.toMillis?.() || 0
          const receivedAt = p.receivedAt || 0
          // Response time = time from notification received to answer
          return receivedAt > 0 && predictionCreatedAt > receivedAt ? predictionCreatedAt - receivedAt : 0
        })
        .filter((time: number) => time > 0)

      if (validResponseTimes.length > 0) {
        const avgMs = validResponseTimes.reduce((a: number, b: number) => a + b, 0) / validResponseTimes.length
        avgResponseTime = (avgMs / 1000).toFixed(1)
      } else if (totalResponses > 0) {
        // If we have responses but no valid times, show 0 instead of N/A
        avgResponseTime = '0.0'
      }
    } else if (lastQuestion.state === 'resolved') {
      // For resolved questions, calculate accuracy
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
      timeSinceLastMs,
      correctCount,
      incorrectCount,
      accuracy,
    }
  }, [questions, currentTime, livePredictions, game])

  useEffect(() => {
    if (!user || !gameId) return

    // Fetch game
    getDoc(doc(db, 'games', gameId)).then((snapshot) => {
      if (snapshot.exists()) {
        setGame({ id: snapshot.id, ...snapshot.data() } as Game)
      }
    })

    // Listen to questions
    const q = query(
      collection(db, 'games', gameId, 'questions'),
      orderBy('createdAt', 'desc')
    )

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const questionsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as Question[]

      setQuestions(questionsData)
      setLoading(false)
    })

    return () => unsubscribe()
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
        ...doc.data(),
      }))
      setLivePredictions(predictionsData)
    })

    return () => unsubscribe()
  }, [user, gameId, questions])

  // Update current time every second for live timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const updateGameState = async (newState: Game['state']) => {
    if (!game) return

    try {
      await updateDoc(doc(db, 'games', gameId), {
        state: newState,
        ...(newState === 'open' ? { openedAt: Timestamp.now() } : {}),
        ...(newState === 'resolved' ? { closedAt: Timestamp.now() } : {}),
      })
    } catch (error) {
      console.error('Error updating game state:', error)
      alert('Failed to update game state')
    }
  }

  const updateQuestionState = async (
    questionId: string,
    newState: Question['state']
  ) => {
    try {
      await updateDoc(doc(db, 'games', gameId, 'questions', questionId), {
        state: newState,
        ...(newState === 'closed' ? { closedAt: Timestamp.now() } : {}),
        ...(newState === 'resolved' ? { resolvedAt: Timestamp.now() } : {}),
      })
    } catch (error) {
      console.error('Error updating question state:', error)
      alert('Failed to update question state')
    }
  }

  const resolveQuestion = async (questionId: string, answer: boolean) => {
    try {
      await updateDoc(doc(db, 'games', gameId, 'questions', questionId), {
        state: 'resolved',
        answer: answer,
        resolvedAt: Timestamp.now(),
        changedAt: Timestamp.now(),
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
      const questionData: any = {
        question: questionText,
        type: 'YESNO',
        choices: ['Yes', 'No'],
        state: 'open',
        triggeredAt: Timestamp.now(),
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }

      if (selectedEngineTag) {
        questionData.engineTag = selectedEngineTag
      }

      await addDoc(collection(db, 'games', gameId, 'questions'), questionData)
    } catch (error) {
      console.error('Error creating question:', error)
      alert('Failed to create question')
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
                        {gameStats.avgResponseRate}%
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
                    {gameStats.avgResponseTimeMs > 0 && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Avg Response Time
                        </div>
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          {(gameStats.avgResponseTimeMs / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {gameStats.avgDeliveryTimeMs > 0 && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Avg Delivery Time
                        </div>
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          {(gameStats.avgDeliveryTimeMs / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {gameStats.avgQuestionOpenTimeMs > 0 && (
                      <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                          Avg Question Open Time
                        </div>
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">
                          {(gameStats.avgQuestionOpenTimeMs / 1000).toFixed(2)}s
                        </div>
                      </div>
                    )}

                    {/* Resolution Time metrics */}
                    {gameStats.avgResolutionTimeMs > 0 && (
                      <>
                        <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                          <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                            Avg Resolution Time
                          </div>
                          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                            {(gameStats.avgResolutionTimeMs / 1000).toFixed(2)}s
                          </div>
                        </div>

                        <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                          <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                            Median Resolution Time
                          </div>
                          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                            {(gameStats.medianResolutionTimeMs / 1000).toFixed(2)}s
                          </div>
                        </div>

                        <div className="bg-white dark:bg-gray-800 p-3 rounded shadow-sm">
                          <div className="text-xs text-gray-500 dark:text-gray-400 uppercase mb-1">
                            P95 Resolution Time
                          </div>
                          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                            {(gameStats.p95ResolutionTimeMs / 1000).toFixed(2)}s
                          </div>
                        </div>
                      </>
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
                <div className="mt-6 space-y-6">
                  {/* Response Rate & Engagement Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Response Rate & Engagement Over Time
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
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
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Response Time Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Response Times Over Time (seconds)
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
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis label={{ value: 'Time (seconds)', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Legend />
                        <Bar
                          dataKey="avgDeliveryTime"
                          fill="#14b8a6"
                          name="Avg Delivery Time"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Accuracy Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Player Accuracy Over Time
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

                  {/* Question Open Time vs Response Rate Correlation */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Question Open Time vs Response Rate (Correlation)
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis
                          yAxisId="left"
                          label={{
                            value: 'Open Time (seconds)',
                            angle: -90,
                            position: 'insideLeft',
                          }}
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          label={{
                            value: 'Response Rate (%)',
                            angle: 90,
                            position: 'insideRight',
                          }}
                        />
                        <Tooltip />
                        <Legend />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="questionOpenTime"
                          stroke="#f97316"
                          name="Question Open Time (s)"
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="responseRate"
                          stroke="#3b82f6"
                          name="Response Rate (%)"
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 italic">
                      This chart shows how long questions were open versus player response rates.
                      Generally, shorter open times may lead to lower response rates as players have less time to respond.
                    </div>
                  </div>

                  {/* Resolution Time Chart */}
                  <div className="bg-white dark:bg-gray-800 p-4 rounded-lg">
                    <h4 className="text-md font-semibold text-gray-800 dark:text-gray-200 mb-4">
                      Question Resolution Times (Close to Resolve)
                    </h4>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="questionName" />
                        <YAxis
                          label={{
                            value: 'Time (seconds)',
                            angle: -90,
                            position: 'insideLeft',
                          }}
                        />
                        <Tooltip />
                        <Legend />
                        <Bar
                          dataKey="questionResolutionTime"
                          fill="#a855f7"
                          name="Resolution Time (s)"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 italic">
                      Time taken to resolve each question after closing (determining the correct answer).
                      Helps identify how quickly you&apos;re able to determine outcomes.
                    </div>
                  </div>
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
                  createQuickQuestion('Will the next red zone drive end in a TD?')
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
                  createQuickQuestion('Will the next field goal be good?')
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
                  createQuickQuestion('Will they convert the next 3rd down?')
                }
                className="bg-emerald-100 hover:bg-emerald-200 text-emerald-800 px-3 py-2 rounded text-sm font-medium text-left cursor-pointer"
              >
                ⚡ 3rd down conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will they convert the next 4th down?')
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
                  createQuickQuestion('Will [HOMETEAM] score in the 2-minute drill?')
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

          <div className="divide-y">
            {questions.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No questions yet. Create your first question!
              </div>
            ) : (
              questions.map((question) => (
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
                        Choices: {question.choices.join(', ')}
                      </div>
                      {question.answer !== undefined && (
                        <div className="text-sm text-green-600 mt-1">
                          Answer: {question.answer === true ? 'Yes' : 'No'}
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
                        question.totalResponses !== undefined && (
                          <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900 rounded text-xs space-y-2">
                            <div className="font-semibold text-gray-700 dark:text-gray-300 mb-2">
                              📊 Statistics
                            </div>

                            {/* Response metrics */}
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <span className="text-gray-600 dark:text-gray-400">
                                  Responses:
                                </span>{' '}
                                <span className="font-medium">
                                  {question.totalResponses} / {question.totalPlayers} (
                                  {question.responseRate}%)
                                </span>
                              </div>
                              <div>
                                <span className="text-gray-600 dark:text-gray-400">
                                  Yes/No:
                                </span>{' '}
                                <span className="font-medium">
                                  {question.yesCount} / {question.noCount}
                                </span>
                              </div>
                              {question.correctCount !== undefined && (
                                <>
                                  <div>
                                    <span className="text-green-600 dark:text-green-400">
                                      Correct:
                                    </span>{' '}
                                    <span className="font-medium text-green-700 dark:text-green-300">
                                      {question.correctCount}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-red-600 dark:text-red-400">
                                      Incorrect:
                                    </span>{' '}
                                    <span className="font-medium text-red-700 dark:text-red-300">
                                      {question.incorrectCount}
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>

                            {/* Question open time */}
                            {question.questionOpenTimeMs !== undefined &&
                              question.questionOpenTimeMs > 0 && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                    Question Open Time:
                                  </div>
                                  <div className="text-lg font-semibold">
                                    {(question.questionOpenTimeMs / 1000).toFixed(2)}s
                                  </div>
                                </div>
                              )}

                            {/* Question resolution time */}
                            {question.questionResolutionTimeMs !== undefined &&
                              question.questionResolutionTimeMs > 0 && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                    Resolution Time (Close → Resolve):
                                  </div>
                                  <div className="text-lg font-semibold text-purple-600 dark:text-purple-400">
                                    {(question.questionResolutionTimeMs / 1000).toFixed(2)}s
                                  </div>
                                </div>
                              )}

                            {/* Response time metrics */}
                            {question.avgResponseTimeMs !== undefined &&
                              question.avgResponseTimeMs > 0 && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                    Response Times:
                                  </div>
                                  <div className="grid grid-cols-3 gap-2">
                                    <div>
                                      <span className="text-gray-500">Avg:</span>{' '}
                                      {(question.avgResponseTimeMs / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Median:</span>{' '}
                                      {((question.medianResponseTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">P95:</span>{' '}
                                      {((question.p95ResponseTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Min:</span>{' '}
                                      {((question.minResponseTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Max:</span>{' '}
                                      {((question.maxResponseTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                  </div>
                                </div>
                              )}

                            {/* Delivery time metrics */}
                            {question.avgDeliveryTimeMs !== undefined &&
                              question.avgDeliveryTimeMs > 0 && (
                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  <div className="text-gray-600 dark:text-gray-400 font-medium mb-1">
                                    Delivery Times:
                                  </div>
                                  <div className="grid grid-cols-3 gap-2">
                                    <div>
                                      <span className="text-gray-500">Avg:</span>{' '}
                                      {(question.avgDeliveryTimeMs / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Median:</span>{' '}
                                      {((question.medianDeliveryTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">P95:</span>{' '}
                                      {((question.p95DeliveryTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Min:</span>{' '}
                                      {((question.minDeliveryTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Max:</span>{' '}
                                      {((question.maxDeliveryTimeMs ?? 0) / 1000).toFixed(2)}s
                                    </div>
                                  </div>
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
                          <button
                            onClick={() => resolveQuestion(question.id, true)}
                            className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700 cursor-pointer"
                          >
                            ✓ Yes
                          </button>
                          <button
                            onClick={() => resolveQuestion(question.id, false)}
                            className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 cursor-pointer"
                          >
                            ✗ No
                          </button>
                        </>
                      )}
                      {question.state === 'resolved' && (
                        <>
                          {changingAnswerId === question.id ? (
                            <>
                              <button
                                onClick={() => {
                                  resolveQuestion(question.id, true)
                                  setChangingAnswerId(null)
                                }}
                                className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700 cursor-pointer"
                              >
                                ✓ Yes
                              </button>
                              <button
                                onClick={() => {
                                  resolveQuestion(question.id, false)
                                  setChangingAnswerId(null)
                                }}
                                className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 cursor-pointer"
                              >
                                ✗ No
                              </button>
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
              ))
            )}
          </div>
        </div>
      </div>

      {/* Floating Stats Display */}
      {lastQuestionStats && (
        <div className="fixed bottom-4 right-4 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border-2 border-gray-300 dark:border-gray-600 p-4 w-80 z-50">
          <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-2">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                ⏱️ Last Question
              </h3>
              <div className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400">
                {Math.floor(lastQuestionStats.timeSinceLastMs / 60000)}:
                {String(Math.floor((lastQuestionStats.timeSinceLastMs % 60000) / 1000)).padStart(2, '0')} ago
              </div>
            </div>

            {/* Question Text */}
            <div className="bg-gray-50 dark:bg-gray-900 rounded p-2">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 line-clamp-2">
                {lastQuestionStats.question}
              </p>
            </div>

            {/* Engine Tag */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">Tag:</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200">
                {lastQuestionStats.engineTag.replace(/_/g, ' ')}
              </span>
            </div>

            {/* State */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">State:</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                lastQuestionStats.state === 'open'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200'
                  : lastQuestionStats.state === 'closed'
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-200'
              }`}>
                {lastQuestionStats.state.toUpperCase()}
              </span>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-200 dark:border-gray-700">
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Response Rate</div>
                <div className="text-lg font-bold text-blue-600 dark:text-blue-400">
                  {lastQuestionStats.responseRate.toFixed(1)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Avg Response Time</div>
                <div className="text-lg font-bold text-green-600 dark:text-green-400">
                  {lastQuestionStats.avgResponseTime}s
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Responses</div>
                <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                  {lastQuestionStats.totalResponses}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Players</div>
                <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                  {lastQuestionStats.totalPlayers}
                </div>
              </div>

              {/* Show accuracy stats for resolved questions */}
              {lastQuestionStats.state === 'resolved' && (lastQuestionStats.correctCount + lastQuestionStats.incorrectCount) > 0 && (
                <>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Accuracy</div>
                    <div className="text-lg font-bold text-green-600 dark:text-green-400">
                      {lastQuestionStats.accuracy.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Correct / Incorrect</div>
                    <div className="text-lg font-bold text-gray-700 dark:text-gray-300">
                      {lastQuestionStats.correctCount} / {lastQuestionStats.incorrectCount}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
