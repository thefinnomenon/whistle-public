'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiRequest } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'

// Import NFL teams type from parent project
type NFL_Team =
  | 'ARI' | 'ATL' | 'BAL' | 'BUF' | 'CAR' | 'CHI' | 'CIN' | 'CLE'
  | 'DAL' | 'DEN' | 'DET' | 'GB' | 'HOU' | 'IND' | 'JAX' | 'KC'
  | 'LAC' | 'LAR' | 'LV' | 'MIA' | 'MIN' | 'NE' | 'NO' | 'NYG' | 'NYJ'
  | 'PHI' | 'PIT' | 'SEA' | 'SF' | 'TB' | 'TEN' | 'WAS'

const NFL_TEAMS: { code: NFL_Team; name: string }[] = [
  { code: 'ARI', name: 'Arizona Cardinals' },
  { code: 'ATL', name: 'Atlanta Falcons' },
  { code: 'BAL', name: 'Baltimore Ravens' },
  { code: 'BUF', name: 'Buffalo Bills' },
  { code: 'CAR', name: 'Carolina Panthers' },
  { code: 'CHI', name: 'Chicago Bears' },
  { code: 'CIN', name: 'Cincinnati Bengals' },
  { code: 'CLE', name: 'Cleveland Browns' },
  { code: 'DAL', name: 'Dallas Cowboys' },
  { code: 'DEN', name: 'Denver Broncos' },
  { code: 'DET', name: 'Detroit Lions' },
  { code: 'GB', name: 'Green Bay Packers' },
  { code: 'HOU', name: 'Houston Texans' },
  { code: 'IND', name: 'Indianapolis Colts' },
  { code: 'JAX', name: 'Jacksonville Jaguars' },
  { code: 'KC', name: 'Kansas City Chiefs' },
  { code: 'LAC', name: 'Los Angeles Chargers' },
  { code: 'LAR', name: 'Los Angeles Rams' },
  { code: 'LV', name: 'Las Vegas Raiders' },
  { code: 'MIA', name: 'Miami Dolphins' },
  { code: 'MIN', name: 'Minnesota Vikings' },
  { code: 'NE', name: 'New England Patriots' },
  { code: 'NO', name: 'New Orleans Saints' },
  { code: 'NYG', name: 'New York Giants' },
  { code: 'NYJ', name: 'New York Jets' },
  { code: 'PHI', name: 'Philadelphia Eagles' },
  { code: 'PIT', name: 'Pittsburgh Steelers' },
  { code: 'SEA', name: 'Seattle Seahawks' },
  { code: 'SF', name: 'San Francisco 49ers' },
  { code: 'TB', name: 'Tampa Bay Buccaneers' },
  { code: 'TEN', name: 'Tennessee Titans' },
  { code: 'WAS', name: 'Washington Commanders' },
]

export default function NewGamePage() {
  const router = useRouter()
  const { user } = useAuth()

  const [homeTeam, setHomeTeam] = useState<NFL_Team | ''>('')
  const [awayTeam, setAwayTeam] = useState<NFL_Team | ''>('')
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [prizeAmount, setPrizeAmount] = useState('0')
  const [prizeType, setPrizeType] = useState<'USD' | 'POINTS'>('USD')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!homeTeam || !awayTeam) {
      alert('Please select both teams')
      return
    }

    if (homeTeam === awayTeam) {
      alert('Home and away teams must be different')
      return
    }

    if (!startDate || !startTime) {
      alert('Please set the game date and time')
      return
    }

    if (!user) {
      alert('You must be signed in')
      return
    }

    setLoading(true)

    try {
      const dateTimeString = `${startDate}T${startTime}`
      const startDateTime = new Date(dateTimeString)

      await apiRequest<{ id: string }>('/api/games', {
        method: 'POST',
        body: {
          homeTeam,
          awayTeam,
          startTime: startDateTime.toISOString(),
          prizeAmount: parseFloat(prizeAmount) || 0,
          prizeType,
          state: 'scheduled',
          sport: 'FOOTBALL',
          league: 'NFL',
          playerCount: 0,
          leaderboard: [],
        },
      })

      router.push('/')
    } catch (error) {
      console.error('Error creating game:', error)
      const message = error instanceof Error ? error.message : String(error)
      alert(`Failed to create game: ${message}`)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link href="/" className="text-blue-600 hover:underline">
            ← Back to games
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h1 className="text-3xl font-bold mb-6">Create Game</h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="homeTeam" className="block text-sm font-medium text-gray-700 mb-2">
                  Home Team
                </label>
                <select
                  id="homeTeam"
                  value={homeTeam}
                  onChange={(e) => setHomeTeam(e.target.value as NFL_Team)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                >
                  <option value="">Select team...</option>
                  {NFL_TEAMS.map((team) => (
                    <option key={team.code} value={team.code}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="awayTeam" className="block text-sm font-medium text-gray-700 mb-2">
                  Away Team
                </label>
                <select
                  id="awayTeam"
                  value={awayTeam}
                  onChange={(e) => setAwayTeam(e.target.value as NFL_Team)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                >
                  <option value="">Select team...</option>
                  {NFL_TEAMS.map((team) => (
                    <option key={team.code} value={team.code}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-2">
                  Start Date
                </label>
                <input
                  type="date"
                  id="startDate"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="startTime" className="block text-sm font-medium text-gray-700 mb-2">
                  Start Time
                </label>
                <input
                  type="time"
                  id="startTime"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                />
              </div>
            </div>

            <div>
              <label htmlFor="prize" className="block text-sm font-medium text-gray-700 mb-2">
                Prize Pool
              </label>
              <input
                type="number"
                id="prize"
                value={prizeAmount}
                onChange={(e) => setPrizeAmount(e.target.value)}
                min="0"
                step="0.01"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                disabled={loading}
              />
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="prizeType"
                    value="USD"
                    checked={prizeType === 'USD'}
                    onChange={() => setPrizeType('USD')}
                    disabled={loading}
                  />
                  Cash (USD)
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="prizeType"
                    value="POINTS"
                    checked={prizeType === 'POINTS'}
                    onChange={() => setPrizeType('POINTS')}
                    disabled={loading}
                  />
                  Points
                </label>
              </div>
            </div>

            <div className="bg-gray-50 p-4 rounded">
              <div className="text-sm text-gray-600">
                <strong>Initial State:</strong> Scheduled
              </div>
              <div className="text-sm text-gray-600 mt-1">
                Game will be created in &quot;scheduled&quot; state. You can start it when ready.
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400"
              >
                {loading ? 'Creating...' : 'Create Game'}
              </button>
              <Link
                href="/"
                className="bg-gray-200 text-gray-700 px-6 py-2 rounded hover:bg-gray-300 inline-block"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
