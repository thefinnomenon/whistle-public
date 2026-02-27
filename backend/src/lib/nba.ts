import https from 'https'
import { admin, db } from '../firebase'
import { trackEvent } from './mixpanel'
import { buildQuestionResolvedProps } from './questionAnalytics'
import { calculateScores, endGameById } from '../routes/game'
import {
  EngineEventSource,
  EventType,
  NbaEventResult,
  NbaEventSubType,
  type BoxScore,
  type EngineEvent,
  type EngineGameState,
  type NbaEventContext,
} from '../types/engine'
import {
  resolveQuestionForEvent,
  triggerBasketballQuestion,
  triggerGameStartQuestions,
} from './engine'
import { sendDismissNotification } from '../lib/notifications'
import { getSeasonProfilesById } from '../workers/seasonProfilesWorker'

const NBA_SCHEDULE_URL =
  'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json'
const NBA_JSON_HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'identity',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}
const NBA_JSON_TIMEOUT_MS = Number(process.env.NBA_JSON_TIMEOUT_MS ?? 120_000)

type CacheEntry = {
  etag?: string
  lastModified?: string
}

const NBA_HTTP_CACHE = new Map<string, CacheEntry>()
let LAST_SCHEDULE_META_TIME: string | undefined

const fetchJson = <T>(
  url: string,
  timeoutMs: number = NBA_JSON_TIMEOUT_MS
): Promise<T> =>
  new Promise((resolve, reject) => {
    const cache = NBA_HTTP_CACHE.get(url) || {}
    const headers = {
      ...NBA_JSON_HEADERS,
      ...(cache.etag ? { 'If-None-Match': cache.etag } : {}),
      ...(cache.lastModified
        ? { 'If-Modified-Since': cache.lastModified }
        : {}),
    }
    const req = https.get(url, { headers }, (res) => {
      const { statusCode } = res
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        const etag = res.headers.etag
        const lastModified = res.headers['last-modified']
        if (statusCode === 304) {
          reject(new Error(`NBA not modified: ${url}`))
          return
        }
        if (statusCode && statusCode >= 400) {
          reject(new Error(`NBA request failed ${statusCode}: ${url}`))
          return
        }
        if (etag || lastModified) {
          NBA_HTTP_CACHE.set(url, {
            etag: typeof etag === 'string' ? etag : cache.etag,
            lastModified:
              typeof lastModified === 'string'
                ? lastModified
                : cache.lastModified,
          })
        }
        try {
          resolve(JSON.parse(raw) as T)
        } catch (err) {
          reject(
            new Error(
              `NBA response parse failed: ${url}. Error: ${String(err)}`
            )
          )
        }
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`NBA request timeout ${timeoutMs}ms: ${url}`))
    })
    req.on('error', (err) => reject(err))
  })

const normalizeTeamCode = (value: string) =>
  value.trim().replace(/\s+/g, '').toUpperCase()

const NBA_TEAM_CODES = new Set<string>([
  'ATL',
  'BOS',
  'BKN',
  'CHA',
  'CHI',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GSW',
  'HOU',
  'IND',
  'LAC',
  'LAL',
  'MEM',
  'MIA',
  'MIL',
  'MIN',
  'NOP',
  'NYK',
  'OKC',
  'ORL',
  'PHI',
  'PHX',
  'POR',
  'SAC',
  'SAS',
  'TOR',
  'UTA',
  'WAS',
])

const isRecognizedNbaTeamCode = (teamCode: string) =>
  NBA_TEAM_CODES.has(teamCode)

const resolveTeamCode = (team: any): string => {
  if (!team) return ''
  if (typeof team === 'string') return normalizeTeamCode(team)
  const candidate =
    team?.teamTricode ||
    team?.teamAbbreviation ||
    team?.tricode ||
    team?.abbreviation ||
    team?.teamCode ||
    team?.teamName ||
    ''
  return typeof candidate === 'string' ? normalizeTeamCode(candidate) : ''
}

const parseGameStart = (game: any): Date | null => {
  const directFields = [
    'gameDateTimeUTC',
    'gameDateTimeUtc',
    'gameDateTimeEST',
    'gameDateTimeEst',
    'gameDateTime',
    'startTimeUTC',
    'startTimeUtc',
    'startTime',
  ]
  for (const field of directFields) {
    const value = game?.[field]
    if (typeof value === 'string') {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
  }

  const dateFields = ['gameDateUTC', 'gameDateUtc', 'gameDateEst', 'gameDate']
  const timeFields = ['gameTimeUTC', 'gameTimeUtc', 'gameTimeEst', 'gameTime']
  for (const dateField of dateFields) {
    for (const timeField of timeFields) {
      const datePart = game?.[dateField]
      const timePart = game?.[timeField]
      if (typeof datePart === 'string' && typeof timePart === 'string') {
        const combined = `${datePart}T${timePart}`.replace('Z', '')
        const parsed = new Date(`${combined}Z`)
        if (!Number.isNaN(parsed.getTime())) return parsed
      }
    }
  }

  return null
}

const buildGameSlug = (
  awayCode: string,
  homeCode: string,
  nbaGameId: string
) => {
  if (!awayCode || !homeCode || !nbaGameId) return ''
  return `${awayCode.toLowerCase()}-vs-${homeCode.toLowerCase()}-${nbaGameId}`
}

const fetchPlayByPlay = async (nbaGameId: string) => {
  const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${nbaGameId}.json`
  const data = await fetchJson<any>(url)
  return {
    actions: data?.game?.actions || [],
    game: data?.game || {},
    gameId: String(data?.game?.gameId || ''),
  }
}

const fetchBoxScore = async (nbaGameId: string) => {
  const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${nbaGameId}.json`
  const data = await fetchJson<any>(url)
  return data?.game || null
}

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

const toEventResult = (action: any): NbaEventResult => {
  const result = String(action?.shotResult || '').toUpperCase()
  if (result === 'MADE') return NbaEventResult.MADE
  if (result === 'MISSED') return NbaEventResult.MISSED
  const desc = String(action?.description || '').toUpperCase()
  if (desc.startsWith('MISS')) return NbaEventResult.MISSED
  if (desc.includes('PTS')) return NbaEventResult.MADE
  return NbaEventResult.NA
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

const isFinalStatus = (status: any, statusText: any) => {
  const numeric = typeof status === 'number' ? status : Number(status)
  const text = String(statusText || '').toLowerCase()
  if (numeric === 3) return true
  if (text.includes('final')) return true
  if (text.includes('game over')) return true
  return false
}

const isInProgressStatus = (status: any, statusText: any) => {
  const numeric = typeof status === 'number' ? status : Number(status)
  if (numeric === 2) return true
  const text = String(statusText || '').toLowerCase()
  if (text.includes('qtr')) return true
  if (text.includes('quarter')) return true
  if (text.includes('halftime')) return true
  if (text.includes('ot')) return true
  if (text.includes('overtime')) return true
  return false
}

const isGameEndAction = (action: any) =>
  String(action?.description || '')
    .trim()
    .toLowerCase() === 'game end'

const resolveGameDoc = async (nbaGameId: string) => {
  const existing = await db
    .collection('games')
    .where('nbaGameId', '==', nbaGameId)
    .limit(1)
    .get()

  if (!existing.empty) {
    const doc = existing.docs[0]
    return { ref: doc.ref, exists: true, data: doc.data() as any }
  }

  return {
    ref: db.collection('games').doc(`nba_${nbaGameId}`),
    exists: false,
    data: undefined as any,
  }
}

const resolveOpenQuestionsForEvent = async (
  gameId: string,
  event: EngineEvent,
  boxScore: BoxScore | null,
  windowTypes: string[]
): Promise<number> => {
  const states: ('open' | 'closed')[] = ['open', 'closed']
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  for (const state of states) {
    let query = db
      .collection('games')
      .doc(gameId)
      .collection('questions')
      .where('state', '==', state)
    if (windowTypes.length) {
      query = query.where('windowType', 'in', windowTypes)
    }
    const snap = await query.get()
    if (!snap.empty) {
      docs.push(...snap.docs)
    }
  }

  if (!docs.length) return 0

  let resolvedCount = 0
  const isTerminalResolutionEvent =
    event.type === EventType.PERIOD_END ||
    event.type === EventType.GAME_END ||
    isFinalStatus(
      boxScore?.gameStatus ?? boxScore?.game?.gameStatus,
      boxScore?.gameStatusText ?? boxScore?.game?.gameStatusText
    )
  for (const doc of docs) {
    const data = doc.data() as any
    const currentState = String(data.state || '')
    const decision = resolveQuestionForEvent(data, event, boxScore)
    if (!decision) continue

    if (decision.state === 'resolved') {
      if (currentState === 'open' && !isTerminalResolutionEvent) {
        await doc.ref.set(
          {
            state: 'cancelled',
            cancelReason: 'RESOLVED_WHILE_OPEN',
            closedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      } else {
        await doc.ref.set(
          {
            state: 'resolved',
            answer: decision.answer ?? null,
            resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        await calculateScores(gameId, doc.id)
      }
    } else {
      await doc.ref.set(
        {
          state: 'cancelled',
          cancelReason: 'VOID',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    const normalizedAnswer =
      typeof decision.answer === 'string'
        ? decision.answer.trim().toLowerCase()
        : ''
    const isTie = normalizedAnswer === 'tie'
    const becameCancelled =
      currentState === 'open' && !isTerminalResolutionEvent
    const resolutionType: 'normal' | 'void' =
      decision.state === 'resolved' && !isTie && !becameCancelled
        ? 'normal'
        : 'void'
    const voidReason =
      resolutionType === 'void'
        ? isTie
          ? 'tie'
          : becameCancelled
            ? 'resolved_while_open'
            : decision.state === 'cancelled'
              ? 'void'
              : 'void'
        : null
    trackEvent(
      'question_resolved',
      buildQuestionResolvedProps({
        questionId: doc.id,
        gameId,
        resolvedTimestampMs: Date.now(),
        outcome: resolutionType === 'normal' ? decision.answer : null,
        resolutionType,
        voidReason,
      })
    )
    await sendDismissNotification(gameId, doc.id, `game_${gameId}`)
    console.log(
      `[nba] question resolved game=${gameId} question=${doc.id} state=${currentState === 'open' && decision.state === 'resolved' ? 'cancelled' : decision.state} answer=${decision.answer ?? 'null'} event=${event.eventId} type=${event.type} template=${String(data.engineTag || '')}`
    )
    resolvedCount += 1
  }

  return resolvedCount
}

const resolveQuestionsAtGameEnd = async (
  gameId: string,
  lastActionNumber: number,
  boxScore: BoxScore | null
) => {
  const syntheticEvent: EngineEvent = {
    eventId: Math.max(0, lastActionNumber + 1),
    source: EngineEventSource.NBA_COM,
    type: EventType.GAME_END,
    subType: NbaEventSubType.END,
    context: null,
    description: 'synthetic_game_end_resolution',
    questionId: null,
    gameState: {
      period: boxScore?.period ?? boxScore?.game?.period ?? null,
      clockMs: parseClockToMs(boxScore?.gameClock ?? boxScore?.game?.gameClock),
      scoreHome:
        typeof boxScore?.homeTeam?.score === 'number'
          ? boxScore.homeTeam.score
          : null,
      scoreAway:
        typeof boxScore?.awayTeam?.score === 'number'
          ? boxScore.awayTeam.score
          : null,
      possession: null,
      boxScore: boxScore
        ? {
            gameId: boxScore.gameId ?? boxScore.game?.gameId ?? null,
            gameStatus:
              boxScore.gameStatus ?? boxScore.game?.gameStatus ?? null,
            gameStatusText:
              boxScore.gameStatusText ?? boxScore.game?.gameStatusText ?? '',
            period: boxScore.period ?? boxScore.game?.period ?? null,
            gameClock: boxScore.gameClock ?? boxScore.game?.gameClock ?? null,
            homeTeam: boxScore.homeTeam ?? boxScore.game?.homeTeam ?? null,
            awayTeam: boxScore.awayTeam ?? boxScore.game?.awayTeam ?? null,
          }
        : null,
    },
    ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
  }

  const resolved = await resolveOpenQuestionsForEvent(
    gameId,
    syntheticEvent,
    boxScore,
    ['NEXT_EVENT', 'NEXT_N_MIN', 'PERIOD', 'GAME']
  )
  if (resolved > 0) {
    console.log(
      `[nba] final resolution pass game=${gameId} resolved=${resolved}`
    )
  }
}

const buildBaseGamePayload = (game: any, startTime: Date | null) => {
  const homeTeam = resolveTeamCode(game?.homeTeam)
  const awayTeam = resolveTeamCode(game?.awayTeam)
  const nbaGameId = String(game?.gameId || game?.gameCode || game?.id || '')
  const nbaGameSlug =
    String(game?.gameSlug || game?.gameUrlCode || game?.slug || '') ||
    buildGameSlug(awayTeam, homeTeam, nbaGameId)

  return {
    homeTeam,
    awayTeam,
    league: 'NBA',
    sport: 'BASKETBALL',
    nbaGameId,
    nbaGameSlug: nbaGameSlug || null,
    nbaGameStatus: game?.gameStatus ?? null,
    nbaGameStatusText: game?.gameStatusText ?? '',
    startTime: startTime
      ? admin.firestore.Timestamp.fromDate(startTime)
      : admin.firestore.FieldValue.serverTimestamp(),
    source: 'nba.com',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }
}

const commitInBatches = async (
  writes: { ref: FirebaseFirestore.DocumentReference; data: any }[],
  onRetry?: () => void
) => {
  const limit = 200
  const maxAttempts = 4
  type CommitErrorLike = {
    code?: number | string
    details?: string
    message?: string
  }
  const asCommitError = (error: Error | CommitErrorLike): CommitErrorLike => {
    if (typeof error !== 'object' || error === null) return {}
    const base = error as { message?: string }
    const details =
      'details' in error && typeof error.details === 'string'
        ? error.details
        : undefined
    const code =
      'code' in error &&
      (typeof error.code === 'number' || typeof error.code === 'string')
        ? error.code
        : undefined
    return {
      code,
      details,
      message: typeof base.message === 'string' ? base.message : undefined,
    }
  }
  const isDeadlineExceeded = (error: Error | CommitErrorLike) => {
    const normalized = asCommitError(error)
    const code = normalized.code
    if (code === 4 || code === '4' || code === 'DEADLINE_EXCEEDED') return true
    const message = String(normalized.message || '')
    const details = String(normalized.details || '')
    return (
      message.includes('DEADLINE_EXCEEDED') ||
      message.includes('Deadline exceeded') ||
      details.includes('DEADLINE_EXCEEDED') ||
      details.includes('Deadline exceeded')
    )
  }
  const commitWithRetry = async (batch: FirebaseFirestore.WriteBatch) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await batch.commit()
        return
      } catch (error) {
        const err = error as Error | CommitErrorLike
        if (!isDeadlineExceeded(err) || attempt === maxAttempts) {
          throw error
        }
        const delayMs = 250 * 2 ** (attempt - 1)
        if (onRetry) onRetry()
        console.warn(
          `[nba] batch commit retry attempt=${attempt} delayMs=${delayMs} reason=deadline_exceeded`
        )
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), delayMs)
        })
      }
    }
  }

  let batch = db.batch()
  let count = 0
  for (const write of writes) {
    batch.set(write.ref, write.data, { merge: true })
    count += 1
    if (count >= limit) {
      await commitWithRetry(batch)
      batch = db.batch()
      count = 0
    }
  }
  if (count > 0) await commitWithRetry(batch)
}

export type NbaLiveSyncStats = {
  openGames: number
  updatedGames: number
  actionsProcessed: number
  commitRetries: number
}

export const syncNbaSchedule = async (daysAhead: number) => {
  const now = new Date()
  const startOfTodayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  const totalDays = Math.max(0, Math.floor(daysAhead))
  const horizon = new Date(now.getTime() + totalDays * 24 * 60 * 60 * 1000)
  let processed = 0
  let created = 0

  console.log(`[nba] schedule sync start source=${NBA_SCHEDULE_URL}`)
  let payload: any
  try {
    payload = await fetchJson<any>(NBA_SCHEDULE_URL)
  } catch (err) {
    const message = String(err)
    if (message.includes('NBA not modified')) {
      console.log('[nba] schedule sync not modified, skipping')
      return { processed: 0, created: 0 }
    }
    throw err
  }
  const scheduleMetaTime = String(payload?.meta?.time || '')
  if (scheduleMetaTime && scheduleMetaTime === LAST_SCHEDULE_META_TIME) {
    console.log('[nba] schedule sync meta unchanged, skipping')
    return { processed: 0, created: 0 }
  }
  const gameDates = payload?.leagueSchedule?.gameDates || []
  if (scheduleMetaTime) LAST_SCHEDULE_META_TIME = scheduleMetaTime

  const seenIds = new Set<string>()
  for (const date of gameDates) {
    const games = Array.isArray(date?.games) ? date.games : []
    for (const game of games) {
      const nbaGameId = String(game?.gameId || game?.gameCode || game?.id || '')
      if (!nbaGameId || seenIds.has(nbaGameId)) continue
      seenIds.add(nbaGameId)

      const homeTeam = resolveTeamCode(game?.homeTeam)
      const awayTeam = resolveTeamCode(game?.awayTeam)
      if (
        !isRecognizedNbaTeamCode(homeTeam) ||
        !isRecognizedNbaTeamCode(awayTeam)
      ) {
        console.error(
          `[nba] schedule skip gameId=${nbaGameId} reason=unrecognized_team homeTeam=${homeTeam || 'missing'} awayTeam=${awayTeam || 'missing'}`
        )
        continue
      }

      const startTime = parseGameStart(game)
      if (!startTime) continue
      if (startTime < startOfTodayUtc || startTime > horizon) continue

      const { ref, exists, data } = await resolveGameDoc(nbaGameId)
      const basePayload = buildBaseGamePayload(game, startTime)

      const newPayload = exists
        ? basePayload
        : {
            ...basePayload,
            state: 'scheduled',
            prizeAmount: 5000,
            prizeType: 'POINTS',
            playerCount: 0,
            leaderboard: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }

      if (!exists) created += 1
      processed += 1

      const shouldPreserveState =
        exists && typeof data?.state === 'string' && data.state !== 'scheduled'
      const payloadToWrite = shouldPreserveState
        ? { ...newPayload, state: data.state }
        : newPayload

      await ref.set(payloadToWrite, { merge: true })
    }
  }

  console.log(
    `[nba] schedule sync committing games processed=${processed} created=${created}`
  )

  return { processed, created }
}

export const syncNbaLiveEvents = async () => {
  const seasonProfiles = getSeasonProfilesById()
  const gamesSnap = await db
    .collection('games')
    .where('state', '==', 'open')
    .where('league', '==', 'NBA')
    .get()

  if (gamesSnap.empty) {
    return {
      openGames: 0,
      updatedGames: 0,
      actionsProcessed: 0,
      commitRetries: 0,
    } satisfies NbaLiveSyncStats
  }

  console.log(`[nba] live sync start openGames=${gamesSnap.size}`)
  let updated = 0
  let actionsProcessed = 0
  let commitRetries = 0
  for (const doc of gamesSnap.docs) {
    const gameId = doc.id
    const game = doc.data() as any
    const nbaGameId = String(game?.nbaGameId || '')
    if (!nbaGameId) {
      console.log(
        `[nba] live sync skip game=${gameId} missing nbaGameId homeTeam=${String(
          game?.homeTeam || ''
        )} awayTeam=${String(game?.awayTeam || '')}`
      )
      continue
    }

    const lastActionNumber =
      typeof game?.lastNbaActionNumber === 'number'
        ? game.lastNbaActionNumber
        : 0
    const nowMs = Date.now()
    const lastSyncMs =
      typeof game?.nbaLastSyncAt?.toMillis === 'function'
        ? game.nbaLastSyncAt.toMillis()
        : null
    const startScheduledMs =
      typeof game?.gameStartQuestionsScheduledAt?.toMillis === 'function'
        ? game.gameStartQuestionsScheduledAt.toMillis()
        : null
    const isCatchup = lastSyncMs
      ? nowMs - lastSyncMs > 2 * 60 * 1000
      : !!startScheduledMs && nowMs - startScheduledMs > 2 * 60 * 1000
    let payload
    let boxScore: BoxScore | null = null
    try {
      const [pbp, box] = await Promise.all([
        fetchPlayByPlay(nbaGameId),
        fetchBoxScore(nbaGameId),
      ])
      payload = pbp
      boxScore = box
    } catch (err) {
      const message = String(err)
      if (message.includes('NBA not modified')) {
        continue
      }
      if (message.includes('NBA request failed 403') && !lastActionNumber) {
        console.log(
          `[nba] live sync skip game=${gameId} nbaGameId=${nbaGameId} reason=pbp_forbidden_not_started`
        )
        continue
      }
      throw err
    }
    const actions = payload?.actions || []
    const nbaGameStatus =
      payload?.game?.gameStatus ?? boxScore?.gameStatus ?? game?.nbaGameStatus
    const nbaGameStatusText =
      payload?.game?.gameStatusText ??
      boxScore?.gameStatusText ??
      game?.nbaGameStatusText ??
      ''
    const isGameInProgress = isInProgressStatus(
      nbaGameStatus,
      nbaGameStatusText
    )

    if (isCatchup && !isGameInProgress) {
      console.log(
        `[nba] live sync skip game=${gameId} nbaGameId=${nbaGameId} reason=catchup_non_live status=${String(nbaGameStatus ?? '')} statusText=${String(nbaGameStatusText)}`
      )
      await doc.ref.set(
        {
          nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          nbaGameStatus: nbaGameStatus ?? null,
          nbaGameStatusText,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      if (isFinalStatus(nbaGameStatus, nbaGameStatusText)) {
        await resolveQuestionsAtGameEnd(gameId, lastActionNumber, boxScore)
        console.log(`[nba] live sync game=${gameId} status=final auto-end`)
        await endGameById(gameId)
      }
      continue
    }

    const gameStartState: EngineGameState = {
      period: boxScore?.period ?? null,
      clockMs: parseClockToMs(boxScore?.gameClock),
      scoreHome: boxScore?.homeTeam?.score ?? null,
      scoreAway: boxScore?.awayTeam?.score ?? null,
      possession: null,
      boxScore: boxScore
        ? {
            gameId: boxScore.gameId ?? null,
            gameStatus: boxScore.gameStatus ?? null,
            gameStatusText: boxScore.gameStatusText ?? '',
            period: boxScore.period ?? null,
            gameClock: boxScore.gameClock ?? null,
            homeTeam: boxScore.homeTeam ?? null,
            awayTeam: boxScore.awayTeam ?? null,
          }
        : null,
    }
    if (!game?.gameStartQuestionsScheduledAt) {
      triggerGameStartQuestions(gameId, gameStartState, boxScore, {
        delayMs: 10_000,
        persistQuestions: true,
        seasonProfiles,
      })
      await doc.ref.set(
        {
          gameStartQuestionsScheduledAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }

    let newActions = actions
      .filter(
        (action: any) =>
          typeof action?.actionNumber === 'number' &&
          action.actionNumber > lastActionNumber
      )
      .sort((a: any, b: any) => a.actionNumber - b.actionNumber)

    if (!lastActionNumber && newActions.length > 10) {
      console.log(
        `[nba] live sync backlog cap game=${gameId} actions=${newActions.length} cap=10`
      )
      newActions = newActions.slice(-10)
    }
    if (isCatchup && newActions.length) {
      console.log(
        `[nba] live sync catchup mode game=${gameId} actions=${newActions.length}`
      )
    }

    if (newActions.length === 0) {
      await doc.ref.set(
        {
          nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          nbaGameStatus: nbaGameStatus ?? null,
          nbaGameStatusText,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      if (isFinalStatus(nbaGameStatus, nbaGameStatusText)) {
        await resolveQuestionsAtGameEnd(gameId, lastActionNumber, boxScore)
        console.log(`[nba] live sync game=${gameId} status=final auto-end`)
        await endGameById(gameId)
      }
      continue
    }
    actionsProcessed += newActions.length

    const batchSize = 200
    let latestActionObj = newActions[newActions.length - 1]
    for (let i = 0; i < newActions.length; i += batchSize) {
      const batch = newActions.slice(i, i + batchSize)
      const eventWrites: { ref: any; data: any }[] = []
      const newEventPayloads: EngineEvent[] = []

      for (const action of batch) {
        const actionNumber = action.actionNumber as number
        const rawRef = db
          .collection(`games/${gameId}/rawEvents`)
          .doc(String(actionNumber))
        const rawPayload = {
          source: 'nba.com',
          nbaGameId,
          actionNumber,
          raw: action,
          ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
        }

        const eventRef = db
          .collection(`games/${gameId}/events`)
          .doc(String(actionNumber))
        const gameState: EngineGameState = {
          period: boxScore?.period ?? action?.period ?? null,
          clockMs: parseClockToMs(boxScore?.gameClock ?? action?.clock),
          scoreHome: boxScore?.homeTeam?.score ?? action?.scoreHome ?? null,
          scoreAway: boxScore?.awayTeam?.score ?? action?.scoreAway ?? null,
          possession: action?.possession ?? null,
          boxScore: boxScore
            ? {
                gameId: boxScore.gameId ?? null,
                gameStatus: boxScore.gameStatus ?? null,
                gameStatusText: boxScore.gameStatusText ?? '',
                period: boxScore.period ?? null,
                gameClock: boxScore.gameClock ?? null,
                homeTeam: boxScore.homeTeam ?? null,
                awayTeam: boxScore.awayTeam ?? null,
              }
            : null,
        }

        const eventSubType = toEngineEventSubType(action?.subType)
        const eventResult = toEventResult(action)
        const eventType = toEventType(
          action?.actionType,
          eventSubType,
          eventResult,
          action?.description
        )
        const eventContext = toEventContext(eventType, eventSubType, action)

        const eventPayload: EngineEvent = {
          eventId: actionNumber,
          source: EngineEventSource.NBA_COM,
          type: eventType,
          subType: eventSubType,
          context: eventContext,
          description: action?.description ?? '',
          questionId: null,
          gameState,
          ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
        }

        eventWrites.push({ ref: rawRef, data: rawPayload })
        eventWrites.push({ ref: eventRef, data: eventPayload })
        newEventPayloads.push(eventPayload)
      }

      await commitInBatches(eventWrites, () => {
        commitRetries += 1
      })
      for (const eventPayload of newEventPayloads) {
        await triggerBasketballQuestion(gameId, eventPayload, boxScore, {
          persistQuestions: !isCatchup,
          skipQuestionGeneration: isCatchup,
          suppressLogs: isCatchup,
          seasonProfiles,
        })
        const windowTypes: string[] = ['NEXT_EVENT', 'NEXT_N_MIN']
        const finalStatusEvent = isFinalStatus(
          eventPayload.gameState?.boxScore?.gameStatus ?? null,
          eventPayload.gameState?.boxScore?.gameStatusText ?? ''
        )
        if (eventPayload.type === EventType.PERIOD_END) {
          windowTypes.push('PERIOD')
          windowTypes.push('GAME')
        }
        if (finalStatusEvent) {
          windowTypes.push('PERIOD')
          windowTypes.push('GAME')
        }
        if (eventPayload.type === EventType.JUMP_BALL) {
          windowTypes.push('JUMP_BALL')
        }
        if (eventPayload.type === EventType.GAME_END) {
          windowTypes.push('GAME')
        }
        const uniqueWindowTypes = Array.from(new Set(windowTypes))
        await resolveOpenQuestionsForEvent(
          gameId,
          eventPayload,
          boxScore,
          uniqueWindowTypes
        )
      }

      latestActionObj = batch[batch.length - 1] ?? latestActionObj
    }

    const latestAction = latestActionObj?.actionNumber ?? 0
    await doc.ref.set(
      {
        lastNbaActionNumber: latestAction,
        nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        nbaGameStatus: nbaGameStatus ?? null,
        nbaGameStatusText,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    console.log(
      `[nba] live sync game=${gameId} nbaGameId=${nbaGameId} newActions=${newActions.length} latestAction=${latestAction}`
    )
    if (latestActionObj) {
      console.log(
        `[nba] live sync latest action game=${gameId} action=${latestActionObj.actionNumber} period=${latestActionObj.period} clock=${latestActionObj.clock} desc=${latestActionObj.description}`
      )
    }
    if (latestActionObj && isGameEndAction(latestActionObj)) {
      await resolveQuestionsAtGameEnd(gameId, latestAction, boxScore)
      console.log(`[nba] live sync game=${gameId} action=game_end auto-end`)
      await endGameById(gameId)
    } else if (isFinalStatus(nbaGameStatus, nbaGameStatusText)) {
      await resolveQuestionsAtGameEnd(gameId, latestAction, boxScore)
      console.log(`[nba] live sync game=${gameId} status=final auto-end`)
      await endGameById(gameId)
    }
    updated += 1
  }

  console.log(`[nba] live sync done updated=${updated}`)
  return {
    openGames: gamesSnap.size,
    updatedGames: updated,
    actionsProcessed,
    commitRetries,
  } satisfies NbaLiveSyncStats
}
