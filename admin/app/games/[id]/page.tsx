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
import { useEffect, useState } from 'react'

// Import types from parent project
import type { Game, Question } from '@/types'

export default function GamePage() {
  const params = useParams()
  const { user } = useAuth()
  const gameId = params.id as string

  const [game, setGame] = useState<Game | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)

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

  const resolveQuestion = async (questionId: string, answer: string) => {
    try {
      await updateDoc(doc(db, 'games', gameId, 'questions', questionId), {
        state: 'resolved',
        answer: answer,
        resolvedAt: Timestamp.now(),
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
      await addDoc(collection(db, 'games', gameId, 'questions'), {
        question: questionText,
        type: 'YESNO',
        choices: ['Yes', 'No'],
        state: 'open',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      })
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
                className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
              >
                Start Game
              </button>
            )}
            {game.state === 'open' && (
              <button
                onClick={() => updateGameState('resolved')}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                End Game
              </button>
            )}
            {game.state !== 'cancelled' && (
              <button
                onClick={() => updateGameState('cancelled')}
                className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
              >
                Cancel Game
              </button>
            )}
          </div>
        </div>

        {/* Quick Question Triggers */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">
            Quick Question Triggers
          </h2>

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
                className="bg-purple-100 hover:bg-purple-200 text-purple-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                ⏱️ Score this quarter?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] score before halftime?')
                }
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🏁 Home score before half?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] score before halftime?')
                }
                className="bg-pink-100 hover:bg-pink-200 text-pink-800 px-3 py-2 rounded text-sm font-medium text-left"
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
                className="bg-blue-100 hover:bg-blue-200 text-blue-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                📊 Score on drive?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] score on this drive?')
                }
                className="bg-green-100 hover:bg-green-200 text-green-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🏠 Home team score?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] score on this drive?')
                }
                className="bg-teal-100 hover:bg-teal-200 text-teal-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                ✈️ Away team score?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this red zone drive end in a TD?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🔴 Red zone TD?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [HOMETEAM] go 3-and-out?')
                }
                className="bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🔥 Home 3-and-out?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will [AWAYTEAM] stop them here?')
                }
                className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm font-medium text-left"
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
                  createQuickQuestion('Will this play result in a touchdown?')
                }
                className="bg-green-100 hover:bg-green-200 text-green-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🏈 Touchdown?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this field goal be good?')
                }
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🎯 Field goal good?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the extra point be good?')
                }
                className="bg-amber-100 hover:bg-amber-200 text-amber-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🎊 Extra point?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the 2-point conversion succeed?')
                }
                className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🏁 2-point conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this result in a safety?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🛡️ Safety?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will the defense score on this play?')
                }
                className="bg-rose-100 hover:bg-rose-200 text-rose-800 px-3 py-2 rounded text-sm font-medium text-left"
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
                  createQuickQuestion('Will this be a first down?')
                }
                className="bg-lime-100 hover:bg-lime-200 text-lime-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                ⬇️ First down?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will they convert this 3rd down?')
                }
                className="bg-emerald-100 hover:bg-emerald-200 text-emerald-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                ⚡ 3rd down conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will they convert this 4th down?')
                }
                className="bg-cyan-100 hover:bg-cyan-200 text-cyan-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🎲 4th down conversion?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this play gain 20+ yards?')
                }
                className="bg-sky-100 hover:bg-sky-200 text-sky-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                💨 Big play (20+ yards)?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this run gain 10+ yards?')
                }
                className="bg-violet-100 hover:bg-violet-200 text-violet-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🏃 Run 10+ yards?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this pass gain 15+ yards?')
                }
                className="bg-fuchsia-100 hover:bg-fuchsia-200 text-fuchsia-800 px-3 py-2 rounded text-sm font-medium text-left"
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
                onClick={() => createQuickQuestion('Will this be completed?')}
                className="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                ✅ Completion?
              </button>
              <button
                onClick={() => createQuickQuestion('Will this be a sack?')}
                className="bg-gray-100 hover:bg-gray-200 text-gray-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                💥 Sack?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this result in a turnover?')
                }
                className="bg-red-100 hover:bg-red-200 text-red-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🔄 Turnover?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this result in an interception?')
                }
                className="bg-rose-100 hover:bg-rose-200 text-rose-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🎯 Interception?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will this result in a fumble?')
                }
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🔁 Fumble?
              </button>
              <button
                onClick={() =>
                  createQuickQuestion('Will there be a penalty on this play?')
                }
                className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🚩 Penalty?
              </button>
              <button
                onClick={() => createQuickQuestion('Will they punt?')}
                className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm font-medium text-left"
              >
                🦵 Punt?
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b flex justify-between items-center">
            <h2 className="text-2xl font-semibold">Questions</h2>
            <Link
              href={`/games/${gameId}/questions/new`}
              className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300 text-sm"
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
                      {question.answer && (
                        <div className="text-sm text-green-600 mt-1">
                          Answer: {question.answer}
                        </div>
                      )}
                      <div className="text-xs text-gray-500 mt-1">
                        Created:{' '}
                        {question.createdAt?.toDate?.()?.toLocaleString()}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {question.state === 'open' && (
                        <button
                          onClick={() =>
                            updateQuestionState(question.id, 'closed')
                          }
                          className="bg-yellow-600 text-white px-3 py-1 rounded text-sm hover:bg-yellow-700"
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
                            className="bg-gray-400 text-white px-3 py-1 rounded text-sm hover:bg-gray-500"
                          >
                            Reopen
                          </button>
                          <button
                            onClick={() => resolveQuestion(question.id, 'Yes')}
                            className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                          >
                            ✓ Yes
                          </button>
                          <button
                            onClick={() => resolveQuestion(question.id, 'No')}
                            className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
                          >
                            ✗ No
                          </button>
                        </>
                      )}
                      {question.state !== 'cancelled' && (
                        <button
                          onClick={() =>
                            updateQuestionState(question.id, 'cancelled')
                          }
                          className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
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
    </div>
  )
}
