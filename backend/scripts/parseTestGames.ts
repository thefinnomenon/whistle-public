/**
 * Parse a local NBA play-by-play JSON file and emit engine events.
 *
 * Usage:
 *   ts-node backend/scripts/parseTestGames.ts backend/testGames/playbyplay_0022400247.json
 */
import fs from 'fs'
import path from 'path'

import {
  EngineEventSource,
  EventType,
  NbaEventResult,
  NbaEventSubType,
  type EngineEvent,
  type EngineGameState,
  type NbaEventContext,
} from '../src/types/engine'
import {
  triggerBasketballQuestion,
  triggerGameStartQuestions,
  resolveQuestionForEvent,
  type EngineQuestionPayload,
} from '../src/lib/engine'
import { fetchSeasonProfilesOnce } from '../src/workers/seasonProfilesWorker'

const toEnumValue = (value: any) => {
  if (value === null || value === undefined) return 'UNKNOWN'
  const text = String(value).trim()
  if (!text) return 'UNKNOWN'
  return text
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toUpperCase()
}

const ENGINE_EVENT_SUBTYPE_VALUES = new Set(
  Object.values(NbaEventSubType) as string[]
)

const toEngineEventSubType = (value: any): NbaEventSubType => {
  const key = toEnumValue(value)
  return ENGINE_EVENT_SUBTYPE_VALUES.has(key)
    ? (key as NbaEventSubType)
    : NbaEventSubType.OTHER
}

const toEventResult = (action: any): NbaEventResult => {
  const result = String(action?.shotResult || '').toUpperCase()
  if (result === 'MADE') return NbaEventResult.MADE
  if (result === 'MISSED') return NbaEventResult.MISSED
  const desc = String(action?.description || '').toUpperCase()
  if (desc.startsWith('MISS')) return NbaEventResult.MISSED
  if (desc.includes('PTS')) return NbaEventResult.MADE
  return NbaEventResult.NA
}

const isGameEndAction = (action: any) =>
  String(action?.description || '')
    .trim()
    .toLowerCase() === 'game end'

const toEventType = (
  actionType: any,
  subType: NbaEventSubType,
  result: NbaEventResult,
  description: any
): EventType => {
  const base = toEnumValue(actionType)
  if (base === '2PT') {
    return result === NbaEventResult.MADE
      ? EventType.MADE_FG
      : EventType.MISSED_FG
  }
  if (base === '3PT') {
    return result === NbaEventResult.MADE
      ? EventType.MADE_3
      : EventType.MISSED_3
  }
  if (base === 'FREETHROW') {
    return result === NbaEventResult.MADE
      ? EventType.MADE_FT
      : EventType.MISSED_FT
  }
  if (base === 'FOUL') return EventType.FOUL
  if (base === 'TURNOVER') return EventType.TURNOVER
  if (base === 'REBOUND') return EventType.REBOUND
  if (base === 'STEAL') return EventType.STEAL
  if (base === 'BLOCK') return EventType.BLOCK
  if (base === 'SUBSTITUTION') return EventType.SUBSTITUTION
  if (base === 'TIMEOUT') return EventType.TIMEOUT
  if (base === 'JUMPBALL') return EventType.JUMP_BALL
  if (base === 'PERIOD') {
    if (subType === NbaEventSubType.START) return EventType.PERIOD_START
    if (subType === NbaEventSubType.END) return EventType.PERIOD_END
  }
  if (base === 'GAME' || isGameEndAction({ description }))
    return EventType.GAME_END
  if (base === 'INSTANTREPLAY' || base === 'CHALLENGE') return EventType.REVIEW
  return EventType.OTHER
}

const toEventContext = (
  type: EventType,
  subType: NbaEventSubType,
  action: any
): NbaEventContext | null => {
  const context: NbaEventContext = {}
  const primaryPlayerId =
    typeof action?.personId === 'number' ? action.personId : null
  const secondaryPlayerIds = Array.isArray(action?.personIdsFilter)
    ? action.personIdsFilter.filter((id: any) => typeof id === 'number')
    : []
  const teamId = typeof action?.teamId === 'number' ? action.teamId : null
  const teamTricode =
    typeof action?.teamTricode === 'string' ? action.teamTricode : null

  if (type === EventType.MADE_FT || type === EventType.MISSED_FT) {
    const match = String(action?.subType || '').match(/(\d+)\s*of\s*(\d+)/i)
    const attemptNumber = match ? Number(match[1]) : null
    const attemptsTotal = match ? Number(match[2]) : null
    context.freeThrow = {
      shooterId: primaryPlayerId,
      teamId,
      teamTricode,
      result: toEventResult(action),
      attemptsTotal,
      attemptNumber,
    }
  }

  if (
    type === EventType.MADE_FG ||
    type === EventType.MISSED_FG ||
    type === EventType.MADE_3 ||
    type === EventType.MISSED_3
  ) {
    context.shot = {
      shooterId: primaryPlayerId,
      teamId,
      teamTricode,
      result: toEventResult(action),
      shotType: subType,
    }
  }

  if (primaryPlayerId !== null) context.primaryPlayerId = primaryPlayerId
  if (secondaryPlayerIds.length) context.secondaryPlayerIds = secondaryPlayerIds
  if (teamId !== null) context.teamId = teamId
  if (teamTricode) context.teamTricode = teamTricode

  if (typeof action?.timeActual === 'string') {
    context.raw = { timeActual: action.timeActual }
  }

  return Object.keys(context).length ? context : null
}

const parseClockToMs = (value: any): number | null => {
  if (typeof value !== 'string') return null
  const match = value.match(/PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/)
  if (!match) return null
  const minutes = match[1] ? Number(match[1]) : 0
  const seconds = match[2] ? Number(match[2]) : 0
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null
  return Math.round((minutes * 60 + seconds) * 1000)
}

const getElapsedMs = (period: number, clockMs: number): number => {
  const periodLengthMs = period > 4 ? 5 * 60 * 1000 : 12 * 60 * 1000
  const elapsedThisPeriod = periodLengthMs - clockMs
  const regulationElapsed = Math.max(0, period - 1) * 12 * 60 * 1000
  const overtimeElapsed = period > 4 ? (period - 5) * 5 * 60 * 1000 : 0
  return regulationElapsed + overtimeElapsed + elapsedThisPeriod
}

const buildGameState = (game: any, action: any): EngineGameState => ({
  period: action?.period ?? null,
  clockMs: parseClockToMs(action?.clock),
  scoreHome: action?.scoreHome ?? null,
  scoreAway: action?.scoreAway ?? null,
  possession: action?.possession ?? null,
  boxScore: null,
})

const toEngineEvent = (gameId: string, game: any, action: any): EngineEvent => {
  const actionNumber = action.actionNumber as number
  const eventSubType = toEngineEventSubType(action?.subType)
  const eventResult = toEventResult(action)
  const eventType = toEventType(
    action?.actionType,
    eventSubType,
    eventResult,
    action?.description
  )
  const context = toEventContext(eventType, eventSubType, action)

  return {
    eventId: actionNumber,
    source: EngineEventSource.NBA_COM,
    type: eventType,
    subType: eventSubType,
    context,
    description: action?.description ?? '',
    questionId: null,
    gameState: buildGameState(game, action),
    ingestedAt: 'SERVER_TIMESTAMP' as any,
  }
}

const main = async () => {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: ts-node backend/scripts/parseTestGames.ts <file>')
    process.exit(1)
  }
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath)
  const raw = fs.readFileSync(absolutePath, 'utf8')
  const parsed = JSON.parse(raw)
  const actions = parsed?.game?.actions || []
  const game = parsed?.game || {}
  const gameId = String(game?.gameId || '')
  const boxScorePath = path.join(
    path.dirname(absolutePath),
    `boxscore_${gameId}.json`
  )
  const seasonProfilesPath = path.join(
    path.dirname(absolutePath),
    `playbyplay_${gameId}_season_profiles.json`
  )
  const boxScore = fs.existsSync(boxScorePath)
    ? JSON.parse(fs.readFileSync(boxScorePath, 'utf8'))
    : null

  if (!gameId) {
    console.error('Missing gameId in input JSON')
    process.exit(1)
  }

  const events = actions.map((action: any) =>
    toEngineEvent(gameId, game, action)
  )
  const firstActionWithTime = actions.find((action: any) =>
    Number.isFinite(Date.parse(action?.timeActual))
  )
  const baseTimeMs = firstActionWithTime
    ? Date.parse(firstActionWithTime.timeActual)
    : null
  const seasonProfiles = fs.existsSync(seasonProfilesPath)
    ? JSON.parse(fs.readFileSync(seasonProfilesPath, 'utf8'))
    : await fetchSeasonProfilesOnce()
  const playersById = new Map<string, any>(
    (seasonProfiles.players || []).map((player: any) => [
      String(player.playerId),
      player,
    ])
  )
  const teamsById = new Map<string, any>(
    (seasonProfiles.teams || []).map((team: any) => [String(team.teamId), team])
  )
  type SimQuestion = EngineQuestionPayload & {
    id: string
    state: 'open' | 'resolved' | 'cancelled'
    answer?: string | null
    resolvedAtEventId?: number
  }
  const questions: SimQuestion[] = []
  const openQuestions: SimQuestion[] = []
  const resolvedQuestions: SimQuestion[] = []
  const cancelledQuestions: SimQuestion[] = []
  const firstEvent = events[0]
  if (firstEvent) {
    const gameStartQuestions = triggerGameStartQuestions(
      gameId,
      firstEvent.gameState,
      boxScore,
      {
        suppressLogs: true,
        nowMs: 0,
        seasonProfiles: { playersById, teamsById },
      }
    )
    for (const payload of gameStartQuestions) {
      const question: SimQuestion = {
        ...payload,
        id: `q_${questions.length + 1}`,
        state: 'open',
      }
      questions.push(question)
      openQuestions.push(question)
    }
  }
  let lastElapsedMs = 0
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const action = actions[index]
    const timeActual = Date.parse(action?.timeActual)
    if (Number.isFinite(timeActual) && baseTimeMs !== null) {
      const elapsedMs = Math.max(0, timeActual - baseTimeMs)
      lastElapsedMs = Math.max(lastElapsedMs, elapsedMs)
    } else {
      lastElapsedMs += 30_000
    }
    const question = await triggerBasketballQuestion(gameId, event, boxScore, {
      nowMs: lastElapsedMs,
      bypassMarginConditions: true,
      suppressLogs: true,
      seasonProfiles: { playersById, teamsById },
    })
    if (question) {
      const simQuestion: SimQuestion = {
        ...question,
        id: `q_${questions.length + 1}`,
        state: 'open',
      }
      questions.push(simQuestion)
      openQuestions.push(simQuestion)
    }

    if (openQuestions.length) {
      for (let i = openQuestions.length - 1; i >= 0; i -= 1) {
        const open = openQuestions[i]
        const decision = resolveQuestionForEvent(open, event, boxScore)
        if (!decision) continue
        open.state = decision.state
        open.answer = decision.answer ?? null
        open.resolvedAtEventId = event.eventId
        openQuestions.splice(i, 1)
        if (decision.state === 'resolved') resolvedQuestions.push(open)
        else cancelledQuestions.push(open)
        console.log(
          `[sim/resolve] event=${event.eventId} type=${event.type} question=${open.templateId} state=${decision.state} answer=${decision.answer ?? 'null'}`
        )
      }
    }
  }
  const outputDir = path.dirname(absolutePath)
  const baseName = path.basename(absolutePath, '.json')
  const eventsOutputPath = path.join(outputDir, `${baseName}_engine.json`)
  const questionsOutputPath = path.join(outputDir, `${baseName}_questions.json`)
  const seasonProfilesOutputPath = path.join(
    outputDir,
    `${baseName}_season_profiles.json`
  )
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
  fs.writeFileSync(
    seasonProfilesOutputPath,
    JSON.stringify(
      {
        season: seasonProfiles.season,
        seasonType: seasonProfiles.seasonType,
        fetchedAt: seasonProfiles.fetchedAt,
        playersCount: seasonProfiles.players.length,
        teamsCount: seasonProfiles.teams.length,
        players: seasonProfiles.players,
        teams: seasonProfiles.teams,
      },
      null,
      2
    )
  )
  console.log(
    `Sim output counts: events=${events.length} questions=${questions.length} open=${openQuestions.length} resolved=${resolvedQuestions.length} cancelled=${cancelledQuestions.length} players=${seasonProfiles.players.length} teams=${seasonProfiles.teams.length}`
  )
}

main().catch((error) => {
  console.error('Failed to parse test game', error)
  process.exit(1)
})
