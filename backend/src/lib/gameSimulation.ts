import { execSync } from 'child_process'
import { db } from '../firebase'
import { EngineEventSource, EventType, NbaEventSubType } from '../types/engine'
import {
  buildQuestionChoices,
  resolveQuestionForEvent,
  triggerBasketballQuestion,
  triggerGameStartQuestions,
  type EngineQuestionPayload,
} from './engine'
import { buildSimResult } from './simResult'
import { calculateQuestionPoints } from './questionPoints'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from './eventReplayStorage'
import { fetchSeasonProfilesOnce } from '../workers/seasonProfilesWorker'
import type {
  BoxScore,
  EngineEvent,
  EngineGameState,
  FirestoreTimestampLike,
} from '../types/engine'

type DateLike =
  | FirestoreTimestampLike
  | Date
  | number
  | string
  | null
  | undefined

type GameRecord = {
  nbaGameId?: string | number | null
  nbaGameStatus?: number | string | null
  nbaGameStatusText?: string | null
  homeTeam?: string | null
  awayTeam?: string | null
  startTime?: DateLike
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type SimResult = Record<string, JsonValue> | null

export type SimResolvedEvent = {
  eventId: number
  type: string
  description: string
  period: number | null
  clockMs: number | null
  timeActual: string | null
  rawActionPeriod: number | null
  rawActionClock: string | null
}

export type SimQuestion = EngineQuestionPayload & {
  id: string
  engineVersion: string
  choices: { id: string; value: string }[]
  points: number
  state: 'open' | 'closed' | 'resolved' | 'cancelled'
  answer?: string | null
  cancelReason?: string
  resolvedAtEventId?: number
  resolvedEvent?: SimResolvedEvent
  result?: SimResult
  createdAtMs?: number
  timeoutAtMs?: number
}

const resolveEngineVersion = (): string => {
  const fromEnv =
    process.env.ENGINE_VERSION ||
    process.env.GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ''
  if (fromEnv) return String(fromEnv).slice(0, 40)
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return sha || 'unknown'
  } catch {
    return 'unknown'
  }
}

const ENGINE_VERSION = resolveEngineVersion()

export type SimulateStoredGameResult = {
  gameId: string
  questions: SimQuestion[]
  counts: {
    open: number
    resolved: number
    cancelled: number
  }
  eventCount: number
}

const coerceDate = (value: DateLike): Date | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const date = value.toDate()
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

type RawEventDoc = {
  actionNumber?: number
  raw?: {
    period?: number | null
    clock?: string | null
  } | null
}

type StoredBoxScoreSnapshot = {
  actionNumber?: number
  period?: number | null
  clockMs?: number | null
  scoreHome?: number | null
  scoreAway?: number | null
  boxScore?: BoxScore | null
}

const parseRawClockToMs = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') return null
  const match = value.match(/PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/)
  if (!match) return null
  const minutes = match[1] ? Number(match[1]) : 0
  const seconds = match[2] ? Number(match[2]) : 0
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null
  return Math.round((minutes * 60 + seconds) * 1000)
}

const loadRawEventsByActionNumber = async (gameId: string) => {
  const snap = await db
    .collection('games')
    .doc(gameId)
    .collection('rawEvents')
    .get()
  const byActionNumber = new Map<number, RawEventDoc>()
  for (const doc of snap.docs) {
    const data = doc.data() as RawEventDoc
    const actionNumber =
      typeof data.actionNumber === 'number' ? data.actionNumber : Number(doc.id)
    if (Number.isFinite(actionNumber)) {
      byActionNumber.set(actionNumber, data)
    }
  }
  return byActionNumber
}

const loadBoxScoreSnapshots = async (gameId: string) => {
  const snap = await db
    .collection('games')
    .doc(gameId)
    .collection('boxScoreSnapshots')
    .orderBy('actionNumber', 'asc')
    .get()

  return snap.docs
    .map((doc) => doc.data() as StoredBoxScoreSnapshot)
    .filter(
      (entry): entry is StoredBoxScoreSnapshot & { actionNumber: number } =>
        typeof entry.actionNumber === 'number' &&
        Number.isFinite(entry.actionNumber)
    )
}

const buildResolvedEvent = (
  event: EngineEvent,
  rawEvent: RawEventDoc | null
): SimResolvedEvent => ({
  eventId: event.eventId,
  type: String(event.type || ''),
  description: String(event.description || ''),
  period: event.gameState?.period ?? null,
  clockMs: event.gameState?.clockMs ?? null,
  timeActual:
    typeof event.context?.raw?.timeActual === 'string'
      ? event.context.raw.timeActual
      : null,
  rawActionPeriod:
    typeof rawEvent?.raw?.period === 'number' ? rawEvent.raw.period : null,
  rawActionClock:
    typeof rawEvent?.raw?.clock === 'string' ? rawEvent.raw.clock : null,
})

const withRawActionTiming = (
  event: EngineEvent,
  rawEvent: RawEventDoc | null
): EngineEvent => {
  const rawPeriod =
    typeof rawEvent?.raw?.period === 'number' ? rawEvent.raw.period : null
  const rawClock =
    typeof rawEvent?.raw?.clock === 'string' ? rawEvent.raw.clock : null

  if (rawPeriod === null && rawClock === null) return event

  return {
    ...event,
    gameState: {
      ...event.gameState,
      period: rawPeriod ?? event.gameState?.period ?? null,
      clockMs: parseRawClockToMs(rawClock) ?? event.gameState?.clockMs ?? null,
      scoreHome: event.gameState?.scoreHome ?? null,
      scoreAway: event.gameState?.scoreAway ?? null,
      possession: event.gameState?.possession ?? null,
      boxScore: event.gameState?.boxScore ?? null,
    },
  }
}

const resolveEventBoxScore = (
  event: EngineEvent,
  snapshots: (StoredBoxScoreSnapshot & { actionNumber: number })[]
): BoxScore | null => {
  if (!snapshots.length) return event.gameState?.boxScore ?? null

  let latestBeforeOrAt: BoxScore | null = null
  let firstAfter: BoxScore | null = null

  for (const snapshot of snapshots) {
    const candidate = snapshot.boxScore ?? null
    if (!candidate) continue
    if (snapshot.actionNumber <= event.eventId) {
      latestBeforeOrAt = candidate
      continue
    }
    firstAfter = candidate
    break
  }

  if (
    event.type === EventType.PERIOD_END ||
    event.type === EventType.GAME_END
  ) {
    return firstAfter ?? latestBeforeOrAt ?? event.gameState?.boxScore ?? null
  }

  return latestBeforeOrAt ?? firstAfter ?? event.gameState?.boxScore ?? null
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
    console.warn('[sim] season profiles unavailable', err)
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
    .map((doc) => hydrateStoredEngineEvent(doc.data() as StoredEngineEvent))
    .filter((evt) => typeof evt?.eventId === 'number')
    .sort((a, b) => a.eventId - b.eventId)
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

export const simulateStoredGame = async (
  gameId: string
): Promise<SimulateStoredGameResult> => {
  const gameSnap = await db.collection('games').doc(gameId).get()
  if (!gameSnap.exists) {
    throw new Error(`Game not found: ${gameId}`)
  }

  const game = gameSnap.data() as GameRecord
  const events = await loadGameEvents(gameId)
  if (!events.length) {
    throw new Error(`No events found for game ${gameId}`)
  }
  const rawEventsByActionNumber = await loadRawEventsByActionNumber(gameId)
  const boxScoreSnapshots = await loadBoxScoreSnapshots(gameId)

  const boxScore = findBoxScore(events)
  const seasonProfiles = await loadSeasonProfiles()
  const questions: SimQuestion[] = []
  const openQuestions: SimQuestion[] = []
  const resolvedQuestions: SimQuestion[] = []
  const cancelledQuestions: SimQuestion[] = []

  const simEngineGameKey = `sim:${gameId}:${Date.now()}`
  const firstEvent = events[0]
  const startState = firstEvent?.gameState ?? buildFallbackGameState(game)
  const gameStartQuestions = triggerGameStartQuestions(
    simEngineGameKey,
    startState,
    boxScore ?? startState.boxScore,
    {
      suppressLogs: true,
      nowMs: 0,
      seasonProfiles,
    }
  )

  for (const payload of gameStartQuestions) {
    const choices = buildQuestionChoices(payload)
    const question: SimQuestion = {
      ...payload,
      engineVersion: ENGINE_VERSION,
      choices,
      points: calculateQuestionPoints(choices.length),
      id: `q_${questions.length + 1}`,
      state: 'open',
      createdAtMs: 0,
      timeoutAtMs: payload.timeoutMs,
    }
    questions.push(question)
    openQuestions.push(question)
  }

  const gameStartDate = coerceDate(game.startTime)
  let baseTimeMs: number | null = gameStartDate ? gameStartDate.getTime() : null
  let lastElapsedMs = 0

  for (const event of events) {
    const rawEvent = rawEventsByActionNumber.get(event.eventId) ?? null
    const effectiveEvent = withRawActionTiming(event, rawEvent)
    const eventBoxScore = resolveEventBoxScore(
      effectiveEvent,
      boxScoreSnapshots
    )
    const timeActual = effectiveEvent.context?.raw?.timeActual
    const parsedTime =
      typeof timeActual === 'string' ? Date.parse(timeActual) : Number.NaN

    if (Number.isFinite(parsedTime)) {
      if (baseTimeMs === null) baseTimeMs = parsedTime
      if (baseTimeMs !== null && parsedTime < baseTimeMs) {
        baseTimeMs = parsedTime
      }
      const elapsedMs = Math.max(0, parsedTime - (baseTimeMs ?? parsedTime))
      lastElapsedMs = Math.max(lastElapsedMs, elapsedMs)
    } else {
      lastElapsedMs += 30_000
    }

    const generated = await triggerBasketballQuestion(
      simEngineGameKey,
      effectiveEvent,
      eventBoxScore,
      {
        nowMs: lastElapsedMs,
        suppressLogs: true,
        seasonProfiles,
      }
    )

    if (generated) {
      const createdAtMs = lastElapsedMs
      const timeoutAtMs = createdAtMs + generated.timeoutMs
      const choices = buildQuestionChoices(generated)
      const simQuestion: SimQuestion = {
        ...generated,
        engineVersion: ENGINE_VERSION,
        choices,
        points: calculateQuestionPoints(choices.length),
        id: `q_${questions.length + 1}`,
        state: 'open',
        createdAtMs,
        timeoutAtMs,
      }
      questions.push(simQuestion)
      openQuestions.push(simQuestion)
    }

    if (!openQuestions.length) continue

    for (let i = openQuestions.length - 1; i >= 0; i -= 1) {
      const open = openQuestions[i]
      if (
        open.state === 'open' &&
        typeof open.timeoutAtMs === 'number' &&
        lastElapsedMs >= open.timeoutAtMs
      ) {
        open.state = 'closed'
      }

      const decision = resolveQuestionForEvent(
        open,
        effectiveEvent,
        eventBoxScore
      )
      if (!decision) continue

      if (decision.state === 'resolved') {
        open.state = 'resolved'
        open.answer = decision.answer ?? null
      } else {
        open.state = 'cancelled'
        open.cancelReason = decision.reason || 'VOID'
      }

      open.resolvedAtEventId = effectiveEvent.eventId
      open.resolvedEvent = buildResolvedEvent(effectiveEvent, rawEvent)
      open.result = buildSimResult(open, effectiveEvent, eventBoxScore)
      openQuestions.splice(i, 1)

      if (open.state === 'resolved') resolvedQuestions.push(open)
      else cancelledQuestions.push(open)
    }
  }

  if (openQuestions.length) {
    const lastEvent = events[events.length - 1]
    const syntheticEvent: EngineEvent = {
      eventId:
        typeof lastEvent?.eventId === 'number' ? lastEvent.eventId + 1 : 0,
      source: EngineEventSource.NBA_COM,
      type: EventType.GAME_END,
      subType: NbaEventSubType.END,
      context: null,
      description: 'synthetic_game_end_resolution',
      questionId: null,
      gameState: {
        period: lastEvent?.gameState?.period ?? null,
        clockMs: lastEvent?.gameState?.clockMs ?? null,
        scoreHome: lastEvent?.gameState?.scoreHome ?? null,
        scoreAway: lastEvent?.gameState?.scoreAway ?? null,
        possession: null,
        boxScore: lastEvent?.gameState?.boxScore ?? null,
      },
      ingestedAt: Date.now(),
    }

    for (let i = openQuestions.length - 1; i >= 0; i -= 1) {
      const open = openQuestions[i]
      const decision = resolveQuestionForEvent(
        open,
        syntheticEvent,
        syntheticEvent.gameState?.boxScore ?? null
      )
      if (decision?.state === 'resolved') {
        open.state = 'resolved'
        open.answer = decision.answer ?? null
        open.resolvedAtEventId = syntheticEvent.eventId
        open.resolvedEvent = buildResolvedEvent(
          syntheticEvent,
          rawEventsByActionNumber.get(
            typeof lastEvent?.eventId === 'number' ? lastEvent.eventId : -1
          ) ?? null
        )
        resolvedQuestions.push(open)
      } else {
        open.state = 'cancelled'
        open.answer = null
        open.cancelReason = decision?.reason || 'VOID'
        open.resolvedAtEventId = syntheticEvent.eventId
        cancelledQuestions.push(open)
      }
      openQuestions.splice(i, 1)
    }
  }

  return {
    gameId,
    questions,
    counts: {
      open: openQuestions.length,
      resolved: resolvedQuestions.length,
      cancelled: cancelledQuestions.length,
    },
    eventCount: events.length,
  }
}
