import { db } from '../src/firebase'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'

type TimestampLike =
  | { toDate: () => Date }
  | Date
  | string
  | number
  | null
  | undefined

type GameDoc = {
  state?: string | null
  startTime?: TimestampLike
  homeTeam?: string | null
  awayTeam?: string | null
}

type EventGameState = {
  period?: number | null
  clockMs?: number | null
  boxScore?: {
    gameStatus?: number | string | null
    gameStatusText?: string | null
  } | null
} | null

type EventDoc = {
  eventId?: number | null
  type?: string | null
  description?: string | null
  gameState?: EventGameState
}

const formatDate = (value: TimestampLike): string => {
  if (!value) return '—'
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : value.toISOString()
  }
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const date = value.toDate()
    return Number.isNaN(date.getTime()) ? '—' : date.toISOString()
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toISOString()
  }
  return '—'
}

const isFinalStatus = (event: EventDoc | null): boolean => {
  if (!event) return false
  if (event.type === 'GAME_END') return true
  const status = event.gameState?.boxScore?.gameStatus
  const statusText = String(
    event.gameState?.boxScore?.gameStatusText ?? ''
  ).toLowerCase()
  const numeric = typeof status === 'number' ? status : Number(status)
  if (numeric === 3) return true
  if (statusText.includes('final')) return true
  if (statusText.includes('game over')) return true
  return false
}

const main = async () => {
  const rawLimit = Number(process.argv[2] ?? 12)
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 12

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(Math.max(limit * 3, 25))
    .get()

  const resolvedGames = gamesSnap.docs.filter((gameDoc) => {
    const game = gameDoc.data() as GameDoc
    return game.state === 'resolved'
  })

  if (resolvedGames.length === 0) {
    console.log('No resolved games found.')
    for (const gameDoc of gamesSnap.docs.slice(0, limit)) {
      const game = gameDoc.data() as GameDoc
      const matchup = `${game.awayTeam ?? 'AWAY'} vs ${game.homeTeam ?? 'HOME'}`
      console.log(
        [
          `gameId=${gameDoc.id}`,
          `state=${String(game.state ?? '—')}`,
          `startTime=${formatDate(game.startTime)}`,
          `matchup=${matchup}`,
        ].join(' ')
      )
    }
    return
  }

  console.log(
    `Recent resolved games checked=${Math.min(resolvedGames.length, limit)}`
  )

  for (const gameDoc of resolvedGames.slice(0, limit)) {
    const game = gameDoc.data() as GameDoc
    const eventsRef = db
      .collection('games')
      .doc(gameDoc.id)
      .collection('events')
    const [lastEventSnap, countSnap] = await Promise.all([
      eventsRef.orderBy('eventId', 'desc').limit(1).get(),
      eventsRef.count().get(),
    ])
    const lastEvent = lastEventSnap.empty
      ? null
      : hydrateStoredEngineEvent(
          lastEventSnap.docs[0].data() as StoredEngineEvent
        )
    const complete = isFinalStatus(lastEvent)
    const matchup = `${game.awayTeam ?? 'AWAY'} vs ${game.homeTeam ?? 'HOME'}`
    const count = countSnap.data().count
    const lastType = String(lastEvent?.type ?? '—')
    const lastEventId =
      typeof lastEvent?.eventId === 'number' ? String(lastEvent.eventId) : '—'
    const lastPeriod =
      typeof lastEvent?.gameState?.period === 'number'
        ? String(lastEvent.gameState.period)
        : '—'
    const lastClockMs =
      typeof lastEvent?.gameState?.clockMs === 'number'
        ? String(lastEvent.gameState.clockMs)
        : '—'
    const startTime = formatDate(game.startTime)
    console.log(
      [
        `gameId=${gameDoc.id}`,
        `complete=${complete}`,
        `startTime=${startTime}`,
        `matchup=${matchup}`,
        `events=${count}`,
        `lastEventId=${lastEventId}`,
        `lastType=${lastType}`,
        `lastPeriod=${lastPeriod}`,
        `lastClockMs=${lastClockMs}`,
      ].join(' ')
    )
  }
}

main().catch((error: Error) => {
  console.error('[list-sim-candidates] error', error)
  process.exit(1)
})
