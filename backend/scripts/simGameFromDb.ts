/**
 * Simulate question generation from a stored game record.
 *
 * Usage:
 *   yarn sim -- <gameId>
 *   yarn sim
 */
import fs from 'fs'
import path from 'path'

import { db } from '../src/firebase'
import {
  resolveQuestionForEvent,
  triggerBasketballQuestion,
  triggerGameStartQuestions,
  buildQuestionChoices,
  type EngineQuestionPayload,
} from '../src/lib/engine'
import { fetchSeasonProfilesOnce } from '../src/workers/seasonProfilesWorker'
import type {
  BoxScore,
  EngineEvent,
  EngineGameState,
  FirestoreTimestampLike,
} from '../src/types/engine'
import { buildSimResult } from './simUtils'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type SimResult = Record<string, JsonValue> | null

type SimQuestion = EngineQuestionPayload & {
  id: string
  choices: { id: string; value: string }[]
  state: 'open' | 'resolved' | 'cancelled'
  answer?: string | null
  resolvedAtEventId?: number
  result?: SimResult
}

type DateLike =
  | FirestoreTimestampLike
  | Date
  | number
  | string
  | null
  | undefined

const formatDate = (value: DateLike) => {
  if (!value) return 'unknown date'
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'unknown date'
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const date = value.toDate()
    if (Number.isNaN(date.getTime())) return 'unknown date'
    return date.toISOString().slice(0, 10)
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'unknown date'
    return date.toISOString().slice(0, 10)
  }
  return 'unknown date'
}

const listResolvedGames = async () => {
  const snap = await db
    .collection('games')
    .where('state', '==', 'resolved')
    .orderBy('startTime', 'desc')
    .limit(10)
    .get()

  if (snap.empty) {
    console.log('No resolved games found.')
    return
  }

  console.log('Recent resolved games:')
  for (const doc of snap.docs) {
    const data = doc.data() as GameSummary
    const title = `${data?.awayTeam ?? 'AWAY'} vs ${data?.homeTeam ?? 'HOME'}`
    const date = formatDate(data?.startTime)
    console.log(`- ${doc.id}: ${title} - ${date}`)
  }
}

const loadSeasonProfiles = async () => {
  try {
    const seasonProfiles = await fetchSeasonProfilesOnce()
    const playersById = new Map(
      seasonProfiles.players.map((player) => [String(player.playerId), player])
    )
    const teamsById = new Map(
      seasonProfiles.teams.map((team) => [String(team.teamId), team])
    )
    return { playersById, teamsById }
  } catch (err) {
    console.warn('[sim] season profiles unavailable, continuing without', err)
    return { playersById: new Map(), teamsById: new Map() }
  }
}

const loadGameEvents = async (gameId: string) => {
  const eventsSnap = await db
    .collection('games')
    .doc(gameId)
    .collection('events')
    .orderBy('eventId', 'asc')
    .get()

  return eventsSnap.docs
    .map((doc) => doc.data() as EngineEvent)
    .filter((evt) => typeof evt?.eventId === 'number')
    .sort((a, b) => a.eventId - b.eventId)
}

type GameRecord = {
  nbaGameId?: string | number | null
  nbaGameStatus?: number | string | null
  nbaGameStatusText?: string | null
  homeTeam?: string | null
  awayTeam?: string | null
}

type GameSummary = GameRecord & {
  startTime?: DateLike
}

const findBoxScore = (events: EngineEvent[]): BoxScore | null => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i]?.gameState?.boxScore ?? null
    if (candidate) return candidate
  }
  return null
}

const buildFallbackGameState = (game: GameRecord): EngineGameState => ({
  period: 1,
  clockMs: 12 * 60 * 1000,
  scoreHome: 0,
  scoreAway: 0,
  possession: null,
  boxScore: {
    gameId: game?.nbaGameId ?? undefined,
    gameStatus: game?.nbaGameStatus ?? undefined,
    gameStatusText: game?.nbaGameStatusText ?? '',
    period: 1,
    gameClock: undefined,
    homeTeam: game?.homeTeam ? { teamTricode: game.homeTeam } : undefined,
    awayTeam: game?.awayTeam ? { teamTricode: game.awayTeam } : undefined,
  },
})

const main = async () => {
  const gameId = process.argv[2]

  if (!gameId) {
    await listResolvedGames()
    return
  }

  const gameSnap = await db.collection('games').doc(gameId).get()
  if (!gameSnap.exists) {
    console.error(`Game not found: ${gameId}`)
    process.exit(1)
  }

  const game = gameSnap.data() as GameRecord
  const events = await loadGameEvents(gameId)
  if (!events.length) {
    console.error(`No events found for game ${gameId}`)
    process.exit(1)
  }

  const boxScore = findBoxScore(events)
  const seasonProfiles = await loadSeasonProfiles()
  const questions: SimQuestion[] = []
  const openQuestions: SimQuestion[] = []
  const resolvedQuestions: SimQuestion[] = []
  const cancelledQuestions: SimQuestion[] = []

  const firstEvent = events[0]
  const startState = firstEvent?.gameState ?? buildFallbackGameState(game)
  const gameStartQuestions = triggerGameStartQuestions(
    gameId,
    startState,
    boxScore ?? startState.boxScore,
    {
      suppressLogs: true,
      nowMs: 0,
      seasonProfiles,
    }
  )
  for (const payload of gameStartQuestions) {
    const question: SimQuestion = {
      ...payload,
      choices: buildQuestionChoices(payload),
      id: `q_${questions.length + 1}`,
      state: 'open',
    }
    questions.push(question)
    openQuestions.push(question)
  }

  let baseTimeMs: number | null = null
  let lastElapsedMs = 0

  for (const event of events) {
    const eventBoxScore = event.gameState?.boxScore ?? null
    const timeActual = event.context?.raw?.timeActual
    const parsedTime =
      typeof timeActual === 'string' ? Date.parse(timeActual) : NaN
    if (Number.isFinite(parsedTime)) {
      if (baseTimeMs === null) baseTimeMs = parsedTime
      const elapsedMs = Math.max(0, parsedTime - baseTimeMs)
      lastElapsedMs = Math.max(lastElapsedMs, elapsedMs)
    } else {
      lastElapsedMs += 30_000
    }

    const question = await triggerBasketballQuestion(
      gameId,
      event,
      eventBoxScore,
      {
        nowMs: lastElapsedMs,
        suppressLogs: true,
        seasonProfiles,
      }
    )
    if (question) {
      const simQuestion: SimQuestion = {
        ...question,
        choices: buildQuestionChoices(question),
        id: `q_${questions.length + 1}`,
        state: 'open',
      }
      questions.push(simQuestion)
      openQuestions.push(simQuestion)
    }

    if (openQuestions.length) {
      for (let i = openQuestions.length - 1; i >= 0; i -= 1) {
        const open = openQuestions[i]
        const decision = resolveQuestionForEvent(open, event, eventBoxScore)
        if (!decision) continue
        open.state = decision.state
        open.answer = decision.answer ?? null
        open.resolvedAtEventId = event.eventId
        open.result = buildSimResult(open, event, eventBoxScore)
        openQuestions.splice(i, 1)
        if (decision.state === 'resolved') resolvedQuestions.push(open)
        else cancelledQuestions.push(open)
      }
    }
  }
  if (openQuestions.length) {
    const lastEvent = events[events.length - 1]
    const lastEventId =
      typeof lastEvent?.eventId === 'number' ? lastEvent.eventId : null
    for (const open of openQuestions) {
      open.state = 'cancelled'
      open.answer = null
      if (lastEventId !== null) open.resolvedAtEventId = lastEventId
      cancelledQuestions.push(open)
    }
    openQuestions.length = 0
  }

  const outputDir = path.join(process.cwd(), 'testGames')
  fs.mkdirSync(outputDir, { recursive: true })
  const baseName = `db_${gameId}`
  const eventsOutputPath = path.join(outputDir, `${baseName}_engine.json`)
  const questionsOutputPath = path.join(outputDir, `${baseName}_questions.json`)

  fs.writeFileSync(
    eventsOutputPath,
    JSON.stringify({ gameId, events }, null, 2)
  )
  fs.writeFileSync(
    questionsOutputPath,
    JSON.stringify(
      {
        gameId,
        questions,
        counts: {
          open: openQuestions.length,
          resolved: resolvedQuestions.length,
          cancelled: cancelledQuestions.length,
        },
      },
      null,
      2
    )
  )

  console.log(
    `Sim output counts: events=${events.length} questions=${questions.length} open=${openQuestions.length} resolved=${resolvedQuestions.length} cancelled=${cancelledQuestions.length}`
  )
  console.log(`Wrote: ${eventsOutputPath}`)
  console.log(`Wrote: ${questionsOutputPath}`)
}

main().catch((error) => {
  console.error('Failed to simulate game', error)
  process.exit(1)
})
