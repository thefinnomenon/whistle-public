'use client'

import { useAuth } from '@/components/AuthProvider'
import { apiRequest } from '@/lib/api'
import { db } from '@/lib/firebase'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { Game } from '@/types'

export default function HomePage() {
  const { user, loading: authLoading, signInWithGoogle, signOut } = useAuth()
  const [games, setGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)
  const [sendingTest, setSendingTest] = useState(false)
  const [testStatus, setTestStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    const q = query(collection(db, 'games'), orderBy('startTime', 'desc'))

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const gamesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Game[]

      setGames(gamesData)
      setLoading(false)
    }, (error) => {
      console.error('Error fetching games:', error)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [user])

  const sendTestQuestion = async () => {
    if (!user) return
    setSendingTest(true)
    setTestStatus(null)
    try {
      const body = await apiRequest<{ sent?: number; failed?: number }>(
        '/api/games/test-question',
        {
          method: 'POST',
        }
      )
      setTestStatus(`Sent: ${body.sent || 0}, Failed: ${body.failed || 0}`)
    } catch (err: any) {
      console.error('Failed to send test question', err)
      setTestStatus(`Error: ${err.message || err}`)
    } finally {
      setSendingTest(false)
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-8">Whistle Admin</h1>
          <p className="text-gray-600 mb-8">Sign in to manage games and questions</p>
          <button
            onClick={signInWithGoogle}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 flex items-center gap-3 mx-auto"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading games...</div>
      </div>
    )
  }

  const environment = process.env.NEXT_PUBLIC_APP_ENV === 'development' ? 'Development' : 'Production'
  const envColor = process.env.NEXT_PUBLIC_APP_ENV === 'development' ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-800'

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold">Whistle Admin</h1>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${envColor}`}>
                {environment}
              </span>
            </div>
            <p className="text-sm text-gray-600 mt-1">Signed in as {user.email}</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/games/new"
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
              Create Game
            </Link>
            <button
              onClick={sendTestQuestion}
              disabled={sendingTest}
              className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 disabled:opacity-50"
            >
              {sendingTest ? 'Sending...' : 'Send Test Question'}
            </button>
            <button
              onClick={signOut}
              className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300"
            >
              Sign Out
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b">
            <h2 className="text-2xl font-semibold">Games</h2>
            {testStatus && (
              <p className="text-sm text-gray-600 mt-2">{testStatus}</p>
            )}
          </div>

          <div className="divide-y">
            {games.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500">
                No games found. Create your first game!
              </div>
            ) : (
              games.map((game) => (
                <Link
                  key={game.id}
                  href={`/games/${game.id}`}
                  className="block px-6 py-4 hover:bg-gray-50 transition"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-4">
                        <span className="text-lg font-semibold">
                          {game.homeTeam} vs {game.awayTeam}
                        </span>
                        <span className={`px-2 py-1 rounded text-sm ${
                          game.state === 'scheduled' ? 'bg-gray-200 text-gray-700' :
                          game.state === 'open' ? 'bg-green-200 text-green-700' :
                          game.state === 'resolved' ? 'bg-blue-200 text-blue-700' :
                          'bg-red-200 text-red-700'
                        }`}>
                          {game.state}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        {game.startTime?.toDate?.()?.toLocaleString() || 'No date'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-600">
                        {game.playerCount || 0} players
                      </div>
                      <div className="text-sm font-semibold">
                        ${game.prizeAmount || 0} prize
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
