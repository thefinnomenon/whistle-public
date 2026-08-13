import { createHash } from 'crypto'
import https from 'https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib'
import { admin, db } from '../firebase'
import { calculateScores, endGameById } from '../routes/game'
import {
  createAndSendEngineQuestion,
  type EngineQuestionPayload,
  type QuestionWindowType,
  type ResolutionContext,
} from './engine'
import { trackEvent } from './mixpanel'
import {
  buildNflQuestionCandidate,
  buildNflPregameGameWinnerPayload,
  extractNflPassTarget,
  NFL_MAX_QUESTIONS_PER_GAME,
  NFL_QUESTION_MIN_INTERVAL_MS,
  NFL_QUESTION_RESPONSE_MS,
  resolveNflQuestionForPlay,
  type NflActiveQuestion,
  type NflQuestionDecision,
} from './nflQuestionEngine'
import { sendDismissNotification } from './notifications'
import { buildQuestionResolvedProps } from './questionAnalytics'

const ESPN_NFL_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
const ESPN_NFL_SUMMARY_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary'
const ESPN_NFL_TIMEOUT_MS = 15_000
const NFL_LIVE_HEARTBEAT_MS = 30_000
const NFL_OPEN_GAMES_REFRESH_MS = 60_000
const NFL_OPEN_GAMES_WATCH_RESTART_MS = 30_000
const NFL_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS = 5_000

const NFL_TEAM_CODES = new Set([
  'ARI',
  'ATL',
  'BAL',
  'BUF',
  'CAR',
  'CHI',
  'CIN',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GB',
  'HOU',
  'IND',
  'JAX',
  'KC',
  'LAC',
  'LAR',
  'LV',
  'MIA',
  'MIN',
  'NE',
  'NO',
  'NYG',
  'NYJ',
  'PHI',
  'PIT',
  'SEA',
  'SF',
  'TB',
  'TEN',
  'WAS',
])

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type JsonObject = { [key: string]: JsonValue }

type NflFieldPosition = {
  down: number | null
  distance: number | null
  yardLine: number | null
  yardsToEndzone: number | null
  downDistanceText: string | null
  possessionText: string | null
  teamId: string | null
}

export type EspnNflPlay = {
  id: string
  driveId: string | null
  driveTeamId: string | null
  driveTeamAbbreviation: string | null
  sequenceNumber: string | null
  text: string
  typeId: string | null
  type: string
  period: number | null
  clock: string | null
  wallclock: string | null
  modifiedAt: string | null
  homeScore: number | null
  awayScore: number | null
  scoringPlay: boolean
  scoreValue: number | null
  penalty: boolean
  turnover: boolean
  statYardage: number | null
  possessionTeamId: string | null
  start: NflFieldPosition | null
  end: NflFieldPosition | null
  reviewType: string | null
  reviewResult: 'UPHELD' | 'REVERSED' | null
}

export type NflPlayerRole = 'PASSER' | 'RUSHER' | 'RECEIVER'

export type EspnNflAthleteName = {
  id: string
  teamId: string
  firstName: string
  lastName: string
  displayName: string
  roles: NflPlayerRole[]
  passingAttempts: number
  passingYards: number
  rushingAttempts: number
  rushingYards: number
  receptions: number
  receivingYards: number
  receivingTargets: number
}

export type EspnNflSummary = {
  competitionId: string | null
  statusName: string
  statusState: string | null
  statusText: string
  completed: boolean
  homeScore: number | null
  awayScore: number | null
  homeTeam: string
  awayTeam: string
  plays: EspnNflPlay[]
  athletes: EspnNflAthleteName[]
}

export type EspnNflScheduledGame = {
  eventId: string
  competitionId: string
  startTime: Date
  homeTeam: string
  awayTeam: string
  homeTeamName: string
  awayTeamName: string
  statusName: string
  statusText: string
}

type CachedOpenNflGame = {
  id: string
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
  data: FirebaseFirestore.DocumentData
}

export type NflLiveSyncStats = {
  openGames: number
  updatedGames: number
  playsCreated: number
  playsRevised: number
  errors: number
}

const asObject = (value: JsonValue | undefined | null): JsonObject | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const asArray = (value: JsonValue | undefined | null): JsonValue[] =>
  Array.isArray(value) ? value : []

const asString = (value: JsonValue | undefined | null): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const asNumber = (value: JsonValue | undefined | null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const asBoolean = (value: JsonValue | undefined | null): boolean =>
  value === true

const normalizeTeamCode = (value: JsonValue | undefined | null): string => {
  const code = (asString(value) ?? '').toUpperCase()
  return code === 'WSH' ? 'WAS' : code
}

const decodeBody = (body: Buffer, encoding: string | undefined): Buffer => {
  if (encoding === 'gzip') return gunzipSync(body)
  if (encoding === 'deflate') return inflateSync(body)
  if (encoding === 'br') return brotliDecompressSync(body)
  return body
}

const fetchEspnJson = (url: string): Promise<JsonObject> =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': 'Whistle/2.0 NFL sync',
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `ESPN NFL request failed status=${statusCode} url=${url}`
              )
            )
            return
          }

          try {
            const rawEncoding = response.headers['content-encoding']
            const encoding = Array.isArray(rawEncoding)
              ? rawEncoding[0]
              : rawEncoding
            const decoded = decodeBody(Buffer.concat(chunks), encoding)
            const parsed = JSON.parse(decoded.toString('utf8')) as JsonValue
            const root = asObject(parsed)
            if (!root) {
              throw new Error('ESPN NFL response was not an object')
            }
            resolve(root)
          } catch (error) {
            reject(
              new Error(
                `ESPN NFL response parse failed url=${url} message=${String(error)}`
              )
            )
          }
        })
      }
    )

    request.setTimeout(ESPN_NFL_TIMEOUT_MS, () => {
      request.destroy(
        new Error(
          `ESPN NFL request timeout ms=${ESPN_NFL_TIMEOUT_MS} url=${url}`
        )
      )
    })
    request.on('error', reject)
  })

const extractStatus = (competition: JsonObject | null) => {
  const status = asObject(competition?.status)
  const type = asObject(status?.type)
  return {
    name: asString(type?.name) ?? 'STATUS_UNKNOWN',
    state: asString(type?.state),
    text:
      asString(type?.detail) ??
      asString(type?.shortDetail) ??
      asString(type?.description) ??
      '',
    completed: asBoolean(type?.completed),
  }
}

const extractCompetitor = (
  competition: JsonObject,
  homeAway: 'home' | 'away'
): JsonObject | null =>
  asArray(competition.competitors)
    .map(asObject)
    .find((competitor) => asString(competitor?.homeAway) === homeAway) ?? null

const extractTeamCode = (competitor: JsonObject | null): string => {
  const team = asObject(competitor?.team)
  return normalizeTeamCode(team?.abbreviation)
}

const extractTeamName = (competitor: JsonObject | null): string => {
  const team = asObject(competitor?.team)
  return asString(team?.displayName) ?? asString(team?.name) ?? ''
}

const parseScheduleEvent = (value: JsonValue): EspnNflScheduledGame | null => {
  const event = asObject(value)
  if (!event) return null
  const competition = asObject(asArray(event.competitions)[0])
  if (!competition) return null

  const eventId = asString(event.id)
  const competitionId = asString(competition.id) ?? eventId
  const startTimeRaw = asString(competition.date) ?? asString(event.date)
  const home = extractCompetitor(competition, 'home')
  const away = extractCompetitor(competition, 'away')
  const homeTeam = extractTeamCode(home)
  const awayTeam = extractTeamCode(away)
  const status = extractStatus(competition)
  const startTimeMs = startTimeRaw ? Date.parse(startTimeRaw) : Number.NaN

  if (
    !eventId ||
    !competitionId ||
    !Number.isFinite(startTimeMs) ||
    !NFL_TEAM_CODES.has(homeTeam) ||
    !NFL_TEAM_CODES.has(awayTeam)
  ) {
    return null
  }

  return {
    eventId,
    competitionId,
    startTime: new Date(startTimeMs),
    homeTeam,
    awayTeam,
    homeTeamName: extractTeamName(home),
    awayTeamName: extractTeamName(away),
    statusName: status.name,
    statusText: status.text,
  }
}

export const parseEspnNflScoreboard = (
  root: JsonObject
): EspnNflScheduledGame[] =>
  asArray(root.events)
    .map(parseScheduleEvent)
    .filter((game): game is EspnNflScheduledGame => game !== null)

const extractFieldPosition = (
  value: JsonValue | undefined
): NflFieldPosition | null => {
  const position = asObject(value)
  if (!position) return null
  const team = asObject(position.team)
  return {
    down: asNumber(position.down),
    distance: asNumber(position.distance),
    yardLine: asNumber(position.yardLine),
    yardsToEndzone: asNumber(position.yardsToEndzone),
    downDistanceText:
      asString(position.downDistanceText) ??
      asString(position.shortDownDistanceText),
    possessionText: asString(position.possessionText),
    teamId: asString(team?.id),
  }
}

const extractPossessionTeamId = (play: JsonObject): string | null => {
  for (const value of asArray(play.teamParticipants)) {
    const participant = asObject(value)
    if (asString(participant?.type) !== 'offense') continue
    const id = asString(participant?.id)
    if (id) return id
  }
  return null
}

type NflDriveContext = {
  id: string | null
  teamId: string | null
  teamAbbreviation: string | null
}

const extractPlay = (
  value: JsonValue,
  driveContext: NflDriveContext | null = null
): EspnNflPlay | null => {
  const play = asObject(value)
  const id = asString(play?.id)
  if (!play || !id) return null

  const type = asObject(play.type)
  const period = asObject(play.period)
  const clock = asObject(play.clock)
  const review = asObject(play.review)
  const upheld = asBoolean(review?.upheld)
  const reversed = asBoolean(review?.reversed)

  return {
    id,
    driveId: driveContext?.id ?? null,
    driveTeamId: driveContext?.teamId ?? null,
    driveTeamAbbreviation: driveContext?.teamAbbreviation ?? null,
    sequenceNumber: asString(play.sequenceNumber),
    text: asString(play.text) ?? '',
    typeId: asString(type?.id),
    type: asString(type?.text) ?? 'Unknown',
    period: asNumber(period?.number),
    clock: asString(clock?.displayValue),
    wallclock: asString(play.wallclock),
    modifiedAt: asString(play.modified),
    homeScore: asNumber(play.homeScore),
    awayScore: asNumber(play.awayScore),
    scoringPlay: asBoolean(play.scoringPlay),
    scoreValue: asNumber(play.scoreValue),
    penalty: asBoolean(play.isPenalty),
    turnover: asBoolean(play.isTurnover),
    statYardage: asNumber(play.statYardage),
    possessionTeamId: extractPossessionTeamId(play),
    start: extractFieldPosition(play.start),
    end: extractFieldPosition(play.end),
    reviewType: asString(review?.type),
    reviewResult: upheld ? 'UPHELD' : reversed ? 'REVERSED' : null,
  }
}

const extractDrivePlays = (value: JsonValue | undefined): EspnNflPlay[] => {
  const drive = asObject(value)
  if (!drive) return []
  const team = asObject(drive.team)
  const driveContext: NflDriveContext = {
    id: asString(drive.id),
    teamId: asString(team?.id),
    teamAbbreviation: normalizeTeamCode(team?.abbreviation) || null,
  }
  return asArray(drive.plays)
    .map((play) => extractPlay(play, driveContext))
    .filter((play): play is EspnNflPlay => play !== null)
}

const extractSummaryPlays = (root: JsonObject): EspnNflPlay[] => {
  const drives = asObject(root.drives)
  const plays = [
    ...asArray(root.plays)
      .map((play) => extractPlay(play))
      .filter((play): play is EspnNflPlay => play !== null),
    ...asArray(drives?.previous).flatMap(extractDrivePlays),
    ...extractDrivePlays(drives?.current),
  ]
  const byId = new Map<string, EspnNflPlay>()
  for (const play of plays) byId.set(play.id, play)
  return [...byId.values()]
}

const extractSummaryAthletes = (root: JsonObject): EspnNflAthleteName[] => {
  const boxscore = asObject(root.boxscore)
  const athletesById = new Map<string, EspnNflAthleteName>()
  for (const teamEntry of asArray(boxscore?.players)) {
    const teamBoxscore = asObject(teamEntry)
    const team = asObject(teamBoxscore?.team)
    const teamId = asString(team?.id)
    if (!teamId) continue
    for (const statisticEntry of asArray(teamBoxscore?.statistics)) {
      const statistic = asObject(statisticEntry)
      const statisticName = asString(statistic?.name)
      const keys = asArray(statistic?.keys).map(asString)
      for (const athleteEntry of asArray(statistic?.athletes)) {
        const row = asObject(athleteEntry)
        const athlete = asObject(row?.athlete)
        const id = asString(athlete?.id)
        const firstName = asString(athlete?.firstName)
        const lastName = asString(athlete?.lastName)
        const displayName = asString(athlete?.displayName)
        if (!id || !firstName || !lastName || !displayName) continue
        const athleteKey = `${teamId}:${id}`
        const existing = athletesById.get(athleteKey)
        const profile: EspnNflAthleteName = existing ?? {
          id,
          teamId,
          firstName,
          lastName,
          displayName,
          roles: [],
          passingAttempts: 0,
          passingYards: 0,
          rushingAttempts: 0,
          rushingYards: 0,
          receptions: 0,
          receivingYards: 0,
          receivingTargets: 0,
        }
        const stats = asArray(row?.stats)
        const readStat = (key: string): number => {
          const index = keys.findIndex((candidate) => candidate === key)
          return index >= 0 ? (asNumber(stats[index]) ?? 0) : 0
        }
        if (statisticName === 'passing') {
          if (!profile.roles.includes('PASSER')) profile.roles.push('PASSER')
          const attemptsIndex = keys.findIndex(
            (statName) => statName === 'completions/passingAttempts'
          )
          const attemptsValue =
            attemptsIndex >= 0 ? asString(stats[attemptsIndex]) : null
          const attempts = attemptsValue?.split('/')[1]
          profile.passingAttempts = attempts ? Number(attempts) || 0 : 0
          profile.passingYards = readStat('passingYards')
        } else if (statisticName === 'rushing') {
          if (!profile.roles.includes('RUSHER')) profile.roles.push('RUSHER')
          profile.rushingAttempts = readStat('rushingAttempts')
          profile.rushingYards = readStat('rushingYards')
        } else if (statisticName === 'receiving') {
          if (!profile.roles.includes('RECEIVER')) {
            profile.roles.push('RECEIVER')
          }
          profile.receptions = readStat('receptions')
          profile.receivingYards = readStat('receivingYards')
          profile.receivingTargets = readStat('receivingTargets')
        }
        athletesById.set(athleteKey, profile)
      }
    }
  }
  return [...athletesById.values()]
}

export const parseEspnNflSummary = (root: JsonObject): EspnNflSummary => {
  const header = asObject(root.header)
  const competition = asObject(asArray(header?.competitions)[0])
  const status = extractStatus(competition)
  const home = competition ? extractCompetitor(competition, 'home') : null
  const away = competition ? extractCompetitor(competition, 'away') : null

  return {
    competitionId: asString(competition?.id),
    statusName: status.name,
    statusState: status.state,
    statusText: status.text,
    completed: status.completed || status.name === 'STATUS_FINAL',
    homeScore: asNumber(home?.score),
    awayScore: asNumber(away?.score),
    homeTeam: extractTeamCode(home),
    awayTeam: extractTeamCode(away),
    plays: extractSummaryPlays(root),
    athletes: extractSummaryAthletes(root),
  }
}

const buildScoreboardUrl = (date: Date): string => {
  const url = new URL(ESPN_NFL_SCOREBOARD_URL)
  url.searchParams.set(
    'dates',
    date.toISOString().slice(0, 10).replace(/-/g, '')
  )
  url.searchParams.set('limit', '100')
  return url.toString()
}

const buildSummaryUrl = (eventId: string): string => {
  const url = new URL(ESPN_NFL_SUMMARY_URL)
  url.searchParams.set('event', eventId)
  return url.toString()
}

export const fetchEspnNflScoreboard = async (
  date: Date
): Promise<EspnNflScheduledGame[]> =>
  parseEspnNflScoreboard(await fetchEspnJson(buildScoreboardUrl(date)))

export const fetchEspnNflSummary = async (
  eventId: string
): Promise<EspnNflSummary> =>
  parseEspnNflSummary(await fetchEspnJson(buildSummaryUrl(eventId)))

const isCancelledStatus = (statusName: string): boolean =>
  statusName === 'STATUS_CANCELED' || statusName === 'STATUS_POSTPONED'

export const syncNflSchedule = async (daysAhead: number) => {
  const now = new Date()
  const startOfTodayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  const totalDays = Math.max(0, Math.floor(daysAhead))
  const dates = Array.from({ length: totalDays + 1 }, (_, dayOffset) => {
    const date = new Date(startOfTodayUtc)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    return date
  })

  console.log(
    `[nfl] schedule sync start days=${dates.length} source=${ESPN_NFL_SCOREBOARD_URL}`
  )
  const dailyGames = await Promise.all(dates.map(fetchEspnNflScoreboard))
  const gamesByEventId = new Map<string, EspnNflScheduledGame>()
  for (const game of dailyGames.flat()) gamesByEventId.set(game.eventId, game)

  let processed = 0
  let created = 0
  let updated = 0
  let unchanged = 0
  for (const game of gamesByEventId.values()) {
    const ref = db.collection('games').doc(`nfl_${game.eventId}`)
    const snapshot = await ref.get()
    const existing = snapshot.data()
    const existingState =
      typeof existing?.state === 'string' ? existing.state : 'scheduled'
    const nextState = !snapshot.exists
      ? isCancelledStatus(game.statusName)
        ? 'cancelled'
        : 'scheduled'
      : existingState === 'scheduled' && isCancelledStatus(game.statusName)
        ? 'cancelled'
        : existingState

    processed += 1
    const existingStartTime = existing?.startTime as
      | admin.firestore.Timestamp
      | undefined
    const existingStartTimeMs =
      typeof existingStartTime?.toMillis === 'function'
        ? existingStartTime.toMillis()
        : null
    const isUnchanged =
      snapshot.exists &&
      existing?.homeTeam === game.homeTeam &&
      existing?.awayTeam === game.awayTeam &&
      existing?.homeTeamName === game.homeTeamName &&
      existing?.awayTeamName === game.awayTeamName &&
      existing?.league === 'NFL' &&
      existing?.sport === 'FOOTBALL' &&
      existing?.espnEventId === game.eventId &&
      existing?.espnCompetitionId === game.competitionId &&
      existing?.nflGameStatus === game.statusName &&
      existing?.nflGameStatusText === game.statusText &&
      existing?.source === 'espn' &&
      existingState === nextState &&
      existingStartTimeMs === game.startTime.getTime()

    if (isUnchanged) {
      unchanged += 1
      continue
    }

    await ref.set(
      {
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeTeamName: game.homeTeamName,
        awayTeamName: game.awayTeamName,
        league: 'NFL',
        sport: 'FOOTBALL',
        espnEventId: game.eventId,
        espnCompetitionId: game.competitionId,
        nflGameStatus: game.statusName,
        nflGameStatusText: game.statusText,
        startTime: admin.firestore.Timestamp.fromDate(game.startTime),
        source: 'espn',
        state: nextState,
        ...(!snapshot.exists
          ? {
              prizeAmount: 5000,
              prizeType: 'POINTS',
              playerCount: 0,
              leaderboard: [],
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    if (!snapshot.exists) created += 1
    else updated += 1
  }

  console.log(
    `[nfl] schedule sync complete games=${processed} created=${created} updated=${updated} unchanged=${unchanged}`
  )
  return { processed, created, updated, unchanged }
}

const OPEN_NFL_GAMES_CACHE = new Map<string, CachedOpenNflGame>()
let openNflGamesCacheReady = false
let openNflGamesLastRefreshMs = 0
let openNflGamesRefreshPromise: Promise<void> | null = null
let openNflGamesWatchStarted = false
let openNflGamesWatchInitialLoad: Promise<void> | null = null
let openNflGamesWatchUnsubscribe: (() => void) | null = null
let openNflGamesLastWatchErrorMs = 0

const buildOpenNflGamesQuery = () =>
  db
    .collection('games')
    .where('state', '==', 'open')
    .where('league', '==', 'NFL')

const replaceOpenNflGamesCache = (
  docs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]
) => {
  OPEN_NFL_GAMES_CACHE.clear()
  for (const doc of docs) {
    OPEN_NFL_GAMES_CACHE.set(doc.id, {
      id: doc.id,
      ref: doc.ref,
      data: doc.data(),
    })
  }
  openNflGamesCacheReady = true
  openNflGamesLastRefreshMs = Date.now()
}

const mergeOpenNflGameCacheData = (
  gameId: string,
  data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
) => {
  const cached = OPEN_NFL_GAMES_CACHE.get(gameId)
  if (!cached) return
  cached.data = { ...cached.data, ...data }
}

const removeOpenNflGameFromCache = (gameId: string) => {
  OPEN_NFL_GAMES_CACHE.delete(gameId)
}

const refreshOpenNflGamesCache = async (reason: string): Promise<void> => {
  if (openNflGamesRefreshPromise) return openNflGamesRefreshPromise
  openNflGamesRefreshPromise = (async () => {
    const snapshot = await buildOpenNflGamesQuery().get()
    replaceOpenNflGamesCache(snapshot.docs)
    console.log(
      `[nfl] open_games_cache refresh reason=${reason} games=${snapshot.size}`
    )
  })().finally(() => {
    openNflGamesRefreshPromise = null
  })
  return openNflGamesRefreshPromise
}

const startOpenNflGamesWatch = (): Promise<void> => {
  if (openNflGamesWatchStarted && openNflGamesWatchInitialLoad) {
    return openNflGamesWatchInitialLoad
  }
  if (
    openNflGamesLastWatchErrorMs > 0 &&
    Date.now() - openNflGamesLastWatchErrorMs < NFL_OPEN_GAMES_WATCH_RESTART_MS
  ) {
    return Promise.resolve()
  }

  openNflGamesWatchStarted = true
  let initialLoadResolved = false
  if (openNflGamesWatchUnsubscribe) openNflGamesWatchUnsubscribe()
  openNflGamesWatchInitialLoad = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (initialLoadResolved) return
      initialLoadResolved = true
      console.warn(
        `[nfl] open_games_cache watch_initial_timeout timeoutMs=${NFL_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS}`
      )
      resolve()
    }, NFL_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS)

    openNflGamesWatchUnsubscribe = buildOpenNflGamesQuery().onSnapshot(
      (snapshot) => {
        replaceOpenNflGamesCache(snapshot.docs)
        if (!initialLoadResolved) {
          initialLoadResolved = true
          clearTimeout(timeout)
          resolve()
        }
        if (snapshot.docChanges().length > 0) {
          console.log(
            `[nfl] open_games_cache watch games=${snapshot.size} changes=${snapshot.docChanges().length}`
          )
        }
      },
      (error: Error) => {
        console.error('[nfl] open_games_cache watch_error', error)
        openNflGamesLastWatchErrorMs = Date.now()
        openNflGamesWatchStarted = false
        openNflGamesWatchUnsubscribe = null
        if (!initialLoadResolved) {
          initialLoadResolved = true
          clearTimeout(timeout)
          resolve()
        }
      }
    )
  })
  return openNflGamesWatchInitialLoad
}

const getOpenNflGamesForLiveSync = async (): Promise<CachedOpenNflGame[]> => {
  await startOpenNflGamesWatch()
  if (
    !openNflGamesCacheReady ||
    Date.now() - openNflGamesLastRefreshMs >= NFL_OPEN_GAMES_REFRESH_MS
  ) {
    await refreshOpenNflGamesCache(openNflGamesCacheReady ? 'ttl' : 'initial')
  }
  return Array.from(OPEN_NFL_GAMES_CACHE.values()).map((game) => ({
    ...game,
    data: { ...game.data },
  }))
}

const fingerprintPlay = (play: EspnNflPlay): string =>
  createHash('sha1').update(JSON.stringify(play)).digest('hex')

const readStoredFingerprints = (
  value: Record<string, string> | undefined
): Record<string, string> => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {}
  const fingerprints: Record<string, string> = {}
  for (const [playId, fingerprint] of Object.entries(value)) {
    if (typeof fingerprint === 'string') fingerprints[playId] = fingerprint
  }
  return fingerprints
}

const asNflQuestionWindowType = (
  value: JsonValue | undefined
): QuestionWindowType | null => {
  const windowType = asString(value)
  if (
    windowType === 'NFL_NEXT_PLAY' ||
    windowType === 'NFL_DRIVE' ||
    windowType === 'NFL_NEXT_TARGET' ||
    windowType === 'PERIOD' ||
    windowType === 'GAME'
  ) {
    return windowType
  }
  return null
}

const parseStoredChoices = (
  value: JsonValue | undefined
): { id: string; value: string }[] | null => {
  const choices = asArray(value).flatMap((entry) => {
    const choice = asObject(entry)
    const id = asString(choice?.id)
    const label = asString(choice?.value)
    return id && label ? [{ id, value: label }] : []
  })
  return choices.length > 0 ? choices : null
}

const parseStoredStringRecord = (
  value: JsonValue | undefined
): Record<string, string> | null => {
  const object = asObject(value)
  if (!object) return null
  const entries = Object.entries(object).flatMap(([key, entry]) => {
    const parsed = asString(entry)
    return parsed ? [[key, parsed] as const] : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

const parseStoredResolutionContext = (
  value: JsonValue | undefined
): ResolutionContext | null => {
  const context = asObject(value)
  if (!context) return null
  const type = asString(context.type)
  const anchorPlayId = asString(context.anchorPlayId)
  const driveId = asString(context.driveId)
  if (!type || !anchorPlayId) return null
  return {
    type,
    anchorPlayId,
    driveId,
    teamId: asString(context.teamId),
    teamCode: asString(context.teamCode),
    homeTricode: asString(context.homeTricode),
    awayTricode: asString(context.awayTricode),
    redZoneVariant: asString(context.redZoneVariant),
    targetToken: asString(context.targetToken),
    targetLastSeenAtMs: asNumber(context.targetLastSeenAtMs),
    targetQuietWindowMs: asNumber(context.targetQuietWindowMs),
    period: asNumber(context.period),
    statType: asString(context.statType),
    target: asNumber(context.target),
    playerToken: asString(context.playerToken),
    playerDisplayName: asString(context.playerDisplayName),
    choices: parseStoredChoices(context.choices) ?? undefined,
    receiverChoiceByTarget:
      parseStoredStringRecord(context.receiverChoiceByTarget) ?? undefined,
  }
}

const readStoredActiveNflQuestions = (
  value: JsonValue | undefined
): NflActiveQuestion[] =>
  asArray(value).flatMap((entry) => {
    const question = asObject(entry)
    const id = asString(question?.id)
    const templateId = asString(question?.templateId)
    const windowType = asNflQuestionWindowType(question?.windowType)
    const createdAtMs = asNumber(question?.createdAtMs) ?? 0
    const resolutionContext = parseStoredResolutionContext(
      question?.resolutionContext
    )
    if (!id || !templateId || !windowType || !resolutionContext) return []
    return [{ id, templateId, windowType, resolutionContext, createdAtMs }]
  })

const readStoredStringArray = (value: JsonValue | undefined): string[] =>
  asArray(value).flatMap((entry) => {
    const parsed = asString(entry)
    return parsed ? [parsed] : []
  })

const toActiveNflQuestion = (
  id: string,
  payload: EngineQuestionPayload,
  createdAtMs: number
): NflActiveQuestion => ({
  id,
  templateId: payload.templateId,
  windowType: payload.windowType,
  resolutionContext: payload.resolutionContext ?? {},
  createdAtMs,
})

const persistNflQuestionDecision = async (
  gameId: string,
  question: NflActiveQuestion,
  play: EspnNflPlay,
  decision: NflQuestionDecision
): Promise<void> => {
  const questionRef = db
    .collection('games')
    .doc(gameId)
    .collection('questions')
    .doc(question.id)
  if (decision.state === 'resolved') {
    await questionRef.set(
      {
        state: 'resolved',
        answer: decision.answer,
        resolvedNflPlayId: play.id,
        resolutionSource: 'espn',
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    try {
      await calculateScores(gameId, question.id)
    } catch (error) {
      console.error(
        `[nfl] question score_failed game=${gameId} question=${question.id} play=${play.id} message=${String(error)}`
      )
    }
  } else {
    await questionRef.set(
      {
        state: 'cancelled',
        cancelReason: decision.reason,
        resolvedNflPlayId: play.id,
        resolutionSource: 'espn',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
  }

  trackEvent(
    'question_resolved',
    buildQuestionResolvedProps({
      questionId: question.id,
      gameId,
      resolvedTimestampMs: Date.now(),
      outcome: decision.state === 'resolved' ? decision.answer : null,
      resolutionType: decision.state === 'resolved' ? 'normal' : 'void',
      voidReason:
        decision.state === 'cancelled' ? decision.reason.toLowerCase() : null,
    })
  )
  try {
    await sendDismissNotification(gameId, question.id, `game_${gameId}`)
  } catch (error) {
    console.error(
      `[nfl] question dismiss_failed game=${gameId} question=${question.id} message=${String(error)}`
    )
  }
  console.log(
    `[nfl] question resolved game=${gameId} question=${question.id} template=${question.templateId} state=${decision.state} answer=${decision.answer ?? 'null'} reason=${decision.reason ?? 'null'} play=${play.id}`
  )
}

const resolveActiveNflQuestionsForPlay = async (
  gameId: string,
  activeQuestions: NflActiveQuestion[],
  play: EspnNflPlay,
  playsThroughCurrent: readonly EspnNflPlay[],
  gameCompleted = false
): Promise<NflActiveQuestion[]> => {
  const remaining: NflActiveQuestion[] = []
  for (const question of activeQuestions) {
    const decision = resolveNflQuestionForPlay(
      question,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (!decision) {
      remaining.push(question)
      continue
    }
    await persistNflQuestionDecision(gameId, question, play, decision)
  }
  return remaining
}

const cancelReceiverQuestionsForRedZone = async (
  gameId: string,
  activeQuestions: NflActiveQuestion[],
  play: EspnNflPlay
): Promise<NflActiveQuestion[]> => {
  const remaining: NflActiveQuestion[] = []
  for (const question of activeQuestions) {
    if (question.resolutionContext.type !== 'NFL_NEXT_TARGET') {
      remaining.push(question)
      continue
    }
    const expectedTarget = question.resolutionContext.targetToken
    const actualTarget = extractNflPassTarget(play)
    if (
      typeof expectedTarget === 'string' &&
      actualTarget &&
      expectedTarget.toLowerCase().replace(/[^a-z0-9]/g, '') ===
        actualTarget.toLowerCase().replace(/[^a-z0-9]/g, '')
    ) {
      remaining.push(question)
      continue
    }
    await persistNflQuestionDecision(gameId, question, play, {
      state: 'cancelled',
      answer: null,
      reason: 'RED_ZONE_PRIORITY',
    })
  }
  return remaining
}

const commitNflPlayWrites = async (
  writes: {
    ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
    data: FirebaseFirestore.DocumentData
  }[]
): Promise<void> => {
  const batchLimit = 400
  for (let offset = 0; offset < writes.length; offset += batchLimit) {
    const batch = db.batch()
    for (const write of writes.slice(offset, offset + batchLimit)) {
      batch.set(write.ref, write.data, { merge: true })
    }
    await batch.commit()
  }
}

const syncOpenNflGame = async (cachedGame: CachedOpenNflGame) => {
  const gameId = cachedGame.id
  const game = cachedGame.data
  const eventId =
    typeof game.espnEventId === 'string' ? game.espnEventId.trim() : ''
  if (!eventId) {
    console.warn(`[nfl] live sync skip game=${gameId} reason=missing_event_id`)
    return { updated: 0, created: 0, revised: 0, errors: 0 }
  }

  try {
    const summary = await fetchEspnNflSummary(eventId)
    const storedFingerprints = readStoredFingerprints(
      game.nflPlayFingerprints as Record<string, string> | undefined
    )
    const nextFingerprints = { ...storedFingerprints }
    const writes: {
      ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
      data: FirebaseFirestore.DocumentData
    }[] = []
    const createdPlays: EspnNflPlay[] = []
    let created = 0
    let revised = 0

    for (const play of summary.plays) {
      const fingerprint = fingerprintPlay(play)
      const previousFingerprint = storedFingerprints[play.id]
      if (previousFingerprint === fingerprint) continue
      const isRevision = typeof previousFingerprint === 'string'
      nextFingerprints[play.id] = fingerprint
      if (isRevision) revised += 1
      else {
        created += 1
        createdPlays.push(play)
      }

      writes.push({
        ref: cachedGame.ref.collection('nflEvents').doc(`play_${play.id}`),
        data: {
          ...play,
          provider: 'espn',
          providerEventId: eventId,
          fingerprint,
          isRevision,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      })
    }

    if (writes.length > 0) await commitNflPlayWrites(writes)

    const nowMs = Date.now()
    const latestPlay =
      summary.plays.length > 0 ? summary.plays[summary.plays.length - 1] : null
    let activeQuestions = readStoredActiveNflQuestions(game.nflActiveQuestions)
    let redZoneAskedDriveIds = readStoredStringArray(
      game.nflQuestionedRedZoneDriveIds
    )
    let redZoneAskedPeriodKeys = readStoredStringArray(
      game.nflQuestionedRedZonePeriodKeys
    )
    let receiverQuestionKeys = readStoredStringArray(
      game.nflReceiverQuestionKeys
    )
    let completionReceiverHalfKeys = readStoredStringArray(
      game.nflCompletionReceiverHalfKeys
    )
    let timeoutQuestionDriveIds = readStoredStringArray(
      game.nflTimeoutQuestionDriveIds
    )
    let gameQuestionKeys = readStoredStringArray(game.nflGameQuestionKeys)
    let periodQuestionKeys = readStoredStringArray(game.nflPeriodQuestionKeys)
    let questionStateChanged = false
    let questionCount =
      typeof game.nflQuestionCount === 'number' &&
      Number.isFinite(game.nflQuestionCount)
        ? game.nflQuestionCount
        : 0
    let lastQuestionAtMs =
      typeof game.nflLastQuestionAtMs === 'number' &&
      Number.isFinite(game.nflLastQuestionAtMs)
        ? game.nflLastQuestionAtMs
        : null
    if (
      summary.plays.length === 0 &&
      !summary.completed &&
      questionCount < NFL_MAX_QUESTIONS_PER_GAME &&
      !gameQuestionKeys.includes('winner')
    ) {
      const homeTeam =
        typeof game.homeTeam === 'string' ? game.homeTeam.trim() : ''
      const awayTeam =
        typeof game.awayTeam === 'string' ? game.awayTeam.trim() : ''
      if (homeTeam && awayTeam) {
        const payload = buildNflPregameGameWinnerPayload(homeTeam, awayTeam)
        const questionId = await createAndSendEngineQuestion(gameId, payload)
        activeQuestions.push(toActiveNflQuestion(questionId, payload, nowMs))
        gameQuestionKeys = [...gameQuestionKeys, 'winner'].slice(-20)
        questionCount += 1
        lastQuestionAtMs = nowMs
        questionStateChanged = true
        console.log(
          `[nfl] question created game=${gameId} question=${questionId} play=pregame template=${payload.templateId} priority=GAME`
        )
      }
    }
    for (const play of createdPlays) {
      const playIndex = summary.plays.findIndex(
        (summaryPlay) => summaryPlay.id === play.id
      )
      const previousActiveCount = activeQuestions.length
      activeQuestions = await resolveActiveNflQuestionsForPlay(
        gameId,
        activeQuestions,
        play,
        summary.plays.slice(0, Math.max(0, playIndex) + 1),
        summary.completed && play.id === latestPlay?.id
      )
      if (activeQuestions.length !== previousActiveCount) {
        questionStateChanged = true
      }
    }
    const latestCreatedPlay = createdPlays[createdPlays.length - 1] ?? null
    if (
      summary.completed &&
      latestPlay &&
      latestCreatedPlay?.id !== latestPlay.id &&
      activeQuestions.length > 0
    ) {
      const previousActiveCount = activeQuestions.length
      activeQuestions = await resolveActiveNflQuestionsForPlay(
        gameId,
        activeQuestions,
        latestPlay,
        summary.plays,
        true
      )
      if (activeQuestions.length !== previousActiveCount) {
        questionStateChanged = true
      }
    }

    if (latestCreatedPlay && latestCreatedPlay.id === latestPlay?.id) {
      const homeTeam =
        typeof game.homeTeam === 'string' ? game.homeTeam.trim() : ''
      const awayTeam =
        typeof game.awayTeam === 'string' ? game.awayTeam.trim() : ''
      const candidate = buildNflQuestionCandidate({
        plays: summary.plays,
        anchorPlay: latestCreatedPlay,
        homeTeam,
        awayTeam,
        nowMs,
        redZoneAskedDriveIds,
        redZoneAskedPeriodKeys,
        receiverQuestionKeys,
        completionReceiverHalfKeys,
        timeoutQuestionDriveIds,
        gameQuestionKeys,
        periodQuestionKeys,
        athletes: summary.athletes,
      })
      if (candidate?.priority === 'RED_ZONE') {
        activeQuestions = await cancelReceiverQuestionsForRedZone(
          gameId,
          activeQuestions,
          latestCreatedPlay
        )
      }

      if (candidate && questionCount >= NFL_MAX_QUESTIONS_PER_GAME) {
        console.log(
          `[nfl] question skip game=${gameId} play=${latestCreatedPlay.id} candidate=${candidate.payload.templateId} reason=game_cap count=${questionCount} cap=${NFL_MAX_QUESTIONS_PER_GAME}`
        )
      } else if (candidate) {
        const bypassCadence =
          candidate.priority === 'RED_ZONE' ||
          candidate.priority === 'FIELD_GOAL' ||
          candidate.priority === 'FOURTH_DOWN' ||
          candidate.priority === 'GAME' ||
          candidate.priority === 'PERIOD_TEAM'
        const cadenceReady =
          lastQuestionAtMs === null ||
          nowMs - lastQuestionAtMs >= NFL_QUESTION_MIN_INTERVAL_MS
        const responseWindowQuestions = activeQuestions.filter(
          (question) =>
            question.createdAtMs > 0 &&
            nowMs - question.createdAtMs < NFL_QUESTION_RESPONSE_MS
        )
        if (responseWindowQuestions.length > 0) {
          console.log(
            `[nfl] question skip game=${gameId} play=${latestCreatedPlay.id} candidate=${candidate.payload.templateId} reason=response_window_active count=${responseWindowQuestions.length}`
          )
        } else if (!bypassCadence && !cadenceReady) {
          console.log(
            `[nfl] question skip game=${gameId} play=${latestCreatedPlay.id} candidate=${candidate.payload.templateId} reason=cadence remainingMs=${NFL_QUESTION_MIN_INTERVAL_MS - (nowMs - (lastQuestionAtMs ?? nowMs))}`
          )
        } else {
          const questionId = await createAndSendEngineQuestion(
            gameId,
            candidate.payload
          )
          activeQuestions.push(
            toActiveNflQuestion(questionId, candidate.payload, nowMs)
          )
          lastQuestionAtMs = nowMs
          questionCount += 1
          if (candidate.redZoneDriveId) {
            redZoneAskedDriveIds = [
              ...redZoneAskedDriveIds.filter(
                (driveId) => driveId !== candidate.redZoneDriveId
              ),
              candidate.redZoneDriveId,
            ].slice(-50)
          }
          if (candidate.redZonePeriodKey) {
            redZoneAskedPeriodKeys = [
              ...redZoneAskedPeriodKeys.filter(
                (key) => key !== candidate.redZonePeriodKey
              ),
              candidate.redZonePeriodKey,
            ].slice(-10)
          }
          if (candidate.receiverQuestionKey) {
            receiverQuestionKeys = [
              ...receiverQuestionKeys.filter(
                (key) => key !== candidate.receiverQuestionKey
              ),
              candidate.receiverQuestionKey,
            ].slice(-50)
          }
          if (candidate.completionReceiverHalfKey) {
            completionReceiverHalfKeys = [
              ...completionReceiverHalfKeys.filter(
                (key) => key !== candidate.completionReceiverHalfKey
              ),
              candidate.completionReceiverHalfKey,
            ].slice(-10)
          }
          if (candidate.timeoutQuestionDriveId) {
            timeoutQuestionDriveIds = [
              ...timeoutQuestionDriveIds.filter(
                (driveId) => driveId !== candidate.timeoutQuestionDriveId
              ),
              candidate.timeoutQuestionDriveId,
            ].slice(-50)
          }
          if (candidate.gameQuestionKey) {
            gameQuestionKeys = [
              ...gameQuestionKeys.filter(
                (key) => key !== candidate.gameQuestionKey
              ),
              candidate.gameQuestionKey,
            ].slice(-20)
          }
          if (candidate.periodQuestionKey) {
            periodQuestionKeys = [
              ...periodQuestionKeys.filter(
                (key) => key !== candidate.periodQuestionKey
              ),
              candidate.periodQuestionKey,
            ].slice(-20)
          }
          console.log(
            `[nfl] question created game=${gameId} question=${questionId} play=${latestCreatedPlay.id} template=${candidate.payload.templateId} priority=${candidate.priority}`
          )
        }
      }
    }

    const lastSyncMs =
      typeof game.nflLastSyncAt?.toMillis === 'function'
        ? game.nflLastSyncAt.toMillis()
        : null
    const persistedStatus =
      typeof game.nflGameStatus === 'string' ? game.nflGameStatus : ''
    const shouldUpdateGame =
      writes.length > 0 ||
      questionStateChanged ||
      !lastSyncMs ||
      nowMs - lastSyncMs >= NFL_LIVE_HEARTBEAT_MS ||
      persistedStatus !== summary.statusName

    if (shouldUpdateGame || summary.completed) {
      const cachedTimestamp = admin.firestore.Timestamp.now()
      const update = {
        nflLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        nflGameStatus: summary.statusName,
        nflGameStatusState: summary.statusState,
        nflGameStatusText: summary.statusText,
        ...(writes.length > 0 ? { nflPlayFingerprints: nextFingerprints } : {}),
        ...(writes.length > 0 || questionStateChanged
          ? {
              nflActiveQuestions: activeQuestions,
              nflQuestionedRedZoneDriveIds: redZoneAskedDriveIds,
              nflQuestionedRedZonePeriodKeys: redZoneAskedPeriodKeys,
              nflReceiverQuestionKeys: receiverQuestionKeys,
              nflCompletionReceiverHalfKeys: completionReceiverHalfKeys,
              nflTimeoutQuestionDriveIds: timeoutQuestionDriveIds,
              nflGameQuestionKeys: gameQuestionKeys,
              nflPeriodQuestionKeys: periodQuestionKeys,
              nflLastQuestionAtMs: lastQuestionAtMs,
              nflQuestionCount: questionCount,
            }
          : {}),
        nflLastPlayId: latestPlay?.id ?? null,
        nflLastPlayWallclock: latestPlay?.wallclock ?? null,
        period: latestPlay?.period ?? null,
        gameClock: latestPlay?.clock ?? null,
        homeScore: summary.homeScore,
        awayScore: summary.awayScore,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
      await cachedGame.ref.set(update, { merge: true })
      mergeOpenNflGameCacheData(gameId, {
        ...update,
        nflLastSyncAt: cachedTimestamp,
        updatedAt: cachedTimestamp,
      })
    }

    if (writes.length > 0) {
      console.log(
        `[nfl] live sync game=${gameId} event=${eventId} created=${created} revised=${revised} status=${summary.statusName}`
      )
    }

    if (summary.completed) {
      console.log(`[nfl] live sync game=${gameId} status=final auto_end=1`)
      await endGameById(gameId)
      removeOpenNflGameFromCache(gameId)
    }

    return {
      updated: shouldUpdateGame || summary.completed ? 1 : 0,
      created,
      revised,
      errors: 0,
    }
  } catch (error) {
    console.error(
      `[nfl] live sync error game=${gameId} event=${eventId} message=${String(error)}`
    )
    return { updated: 0, created: 0, revised: 0, errors: 1 }
  }
}

export const syncNflLiveEvents = async (): Promise<NflLiveSyncStats> => {
  const openGames = await getOpenNflGamesForLiveSync()
  if (openGames.length === 0) {
    return {
      openGames: 0,
      updatedGames: 0,
      playsCreated: 0,
      playsRevised: 0,
      errors: 0,
    }
  }

  const results = await Promise.all(openGames.map(syncOpenNflGame))
  return {
    openGames: openGames.length,
    updatedGames: results.reduce((sum, result) => sum + result.updated, 0),
    playsCreated: results.reduce((sum, result) => sum + result.created, 0),
    playsRevised: results.reduce((sum, result) => sum + result.revised, 0),
    errors: results.reduce((sum, result) => sum + result.errors, 0),
  }
}
