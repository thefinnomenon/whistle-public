import { createHash } from 'crypto'
import https from 'https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib'
import { admin, db } from '../firebase'
import { calculateScores, endGameById } from '../routes/game'
import {
  createAndSendEngineQuestion,
  type EngineQuestionPayload,
  type NflQuestionDedupe,
  type QuestionWindowType,
  type ResolutionContext,
} from './engine'
import { trackEvent } from './mixpanel'
import {
  buildNflQuestionCandidateDecision,
  buildNflPregameGameWinnerPayload,
  getNflPlayWallclockMs,
  NFL_MAX_QUESTIONS_PER_GAME,
  NFL_QUESTION_MIN_INTERVAL_MS,
  NFL_QUESTION_RESPONSE_MS,
  resolveNflQuestionForPlay,
  type NflActiveQuestion,
  type NflQuestionCandidate,
  type NflQuestionDecision,
  type NflQuestionSourceAgePolicy,
} from './nflQuestionEngine'
import { sendDismissNotification } from './notifications'
import { buildQuestionResolvedProps } from './questionAnalytics'

const ESPN_NFL_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
const ESPN_NFL_SUMMARY_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary'
const ESPN_NFL_PLAYER_STATS_URL =
  'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes'
const ESPN_NFL_TEAM_ROSTER_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams'
const ESPN_NFL_TIMEOUT_MS = 15_000
const NFL_PLAYER_PROFILE_COLLECTION = 'nflPlayerProfiles'
const NFL_OPEN_GAMES_REFRESH_MS = 60_000
const NFL_OPEN_GAMES_WATCH_RESTART_MS = 30_000
const NFL_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS = 5_000
const NFL_QUESTION_SOURCE_AGE_POLICY: NflQuestionSourceAgePolicy =
  process.env.NFL_ENFORCE_QUESTION_SOURCE_AGE === '1' ? 'ENFORCE' : 'OBSERVE'

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

class EspnNflRequestError extends Error {
  constructor(
    readonly statusCode: number,
    url: string
  ) {
    super(`ESPN NFL request failed status=${statusCode} url=${url}`)
    this.name = 'EspnNflRequestError'
  }
}

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

export type NflPlayerPriorSeasonProfile = {
  seasonYear: number
  passingGames: number
  passingAttemptsPerGame: number
  passingYardsPerGame: number
  rushingGames: number
  rushingAttemptsPerGame: number
  rushingYardsPerGame: number
  receivingGames: number
  receptionsPerGame: number
  receivingTargetsPerGame: number
}

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
  priorSeasonProfile: NflPlayerPriorSeasonProfile | null
}

export type EspnNflSummary = {
  competitionId: string | null
  seasonYear: number | null
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

export type EspnNflRosterPlayer = {
  id: string
  displayName: string
  teamCode: string
  position: 'QB' | 'RB' | 'FB' | 'WR' | 'TE'
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

type NflRuntimeState = {
  playFingerprints: Record<string, string>
  activeQuestions: NflActiveQuestion[]
  redZoneAskedDriveIds: string[]
  redZoneAskedPeriodKeys: string[]
  receiverQuestionKeys: string[]
  completionReceiverHalfKeys: string[]
  timeoutQuestionDriveIds: string[]
  gameQuestionKeys: string[]
  periodQuestionKeys: string[]
  questionCount: number
  lastQuestionAtMs: number | null
}

type StoredNflEvent = {
  id?: string
  fingerprint?: string
}

type StoredNflQuestion = {
  state?: string
  engineTag?: string
  windowType?: JsonValue
  resolutionContext?: JsonValue
  createdAt?: admin.firestore.Timestamp
  triggeredAt?: admin.firestore.Timestamp
  nflDedupe?: NflQuestionDedupe
}

const nflPlayerProfileById = new Map<string, NflPlayerPriorSeasonProfile>()
let nflPlayerProfilesLoad: Promise<void> | null = null

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

const asStatNumber = (value: JsonValue | undefined | null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const normalized = value.replace(/,/g, '').trim()
  if (!normalized || normalized === '-') return null
  const parsed = Number(normalized)
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
            reject(new EspnNflRequestError(statusCode, url))
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
          priorSeasonProfile: null,
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
  const season = asObject(header?.season)
  const competition = asObject(asArray(header?.competitions)[0])
  const status = extractStatus(competition)
  const home = competition ? extractCompetitor(competition, 'home') : null
  const away = competition ? extractCompetitor(competition, 'away') : null

  return {
    competitionId: asString(competition?.id),
    seasonYear: asNumber(season?.year),
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

const buildNflPlayerStatsUrl = (athleteId: string): string => {
  const url = new URL(`${ESPN_NFL_PLAYER_STATS_URL}/${athleteId}/stats`)
  url.searchParams.set('region', 'us')
  url.searchParams.set('lang', 'en')
  url.searchParams.set('contentorigin', 'espn')
  url.searchParams.set('seasontype', '2')
  return url.toString()
}

const buildNflTeamRosterUrl = (teamCode: string): string =>
  `${ESPN_NFL_TEAM_ROSTER_URL}/${teamCode === 'WAS' ? 'wsh' : teamCode.toLowerCase()}/roster`

type NflSeasonCategoryTotals = {
  games: number
  primaryTotal: number
  usageTotal: number
}

type NflSeasonCategoryRow = NflSeasonCategoryTotals & {
  isSeasonTotal: boolean
}

const extractNflSeasonCategoryTotals = (
  root: JsonObject,
  categoryName: 'passing' | 'rushing' | 'receiving',
  seasonYear: number,
  primaryStatName: 'passingYards' | 'rushingYards' | 'receptions',
  usageStatName: 'passingAttempts' | 'rushingAttempts' | 'receivingTargets'
): NflSeasonCategoryTotals | null => {
  const category = asArray(root.categories)
    .map(asObject)
    .find((candidate) => asString(candidate?.name) === categoryName)
  if (!category) return null

  const statNames = asArray(category.names).map(asString)
  const gamesIndex = statNames.findIndex((name) => name === 'gamesPlayed')
  const primaryIndex = statNames.findIndex((name) => name === primaryStatName)
  const usageIndex = statNames.findIndex((name) => name === usageStatName)
  if (gamesIndex < 0 || primaryIndex < 0 || usageIndex < 0) return null

  const rows: NflSeasonCategoryRow[] = []
  for (const statisticValue of asArray(category.statistics)) {
    const statistic = asObject(statisticValue)
    const season = asObject(statistic?.season)
    if (asNumber(season?.year) !== seasonYear) continue
    const stats = asArray(statistic?.stats)
    const rowGames = asStatNumber(stats[gamesIndex])
    const rowPrimaryTotal = asStatNumber(stats[primaryIndex])
    const rowUsageTotal = asStatNumber(stats[usageIndex])
    if (
      rowGames === null ||
      rowGames <= 0 ||
      rowPrimaryTotal === null ||
      rowUsageTotal === null
    ) {
      continue
    }
    rows.push({
      games: rowGames,
      primaryTotal: rowPrimaryTotal,
      usageTotal: rowUsageTotal,
      isSeasonTotal:
        asString(statistic?.teamId) === null &&
        /totals/i.test(asString(statistic?.teamSlug) ?? ''),
    })
  }

  const seasonTotal = rows.find((row) => row.isSeasonTotal)
  if (seasonTotal) {
    return {
      games: seasonTotal.games,
      primaryTotal: seasonTotal.primaryTotal,
      usageTotal: seasonTotal.usageTotal,
    }
  }
  if (rows.length === 0) return null
  return rows.reduce<NflSeasonCategoryTotals>(
    (total, row) => ({
      games: total.games + row.games,
      primaryTotal: total.primaryTotal + row.primaryTotal,
      usageTotal: total.usageTotal + row.usageTotal,
    }),
    { games: 0, primaryTotal: 0, usageTotal: 0 }
  )
}

export const parseEspnNflPlayerPriorSeasonProfile = (
  root: JsonObject,
  seasonYear: number
): NflPlayerPriorSeasonProfile | null => {
  const passing = extractNflSeasonCategoryTotals(
    root,
    'passing',
    seasonYear,
    'passingYards',
    'passingAttempts'
  )
  const rushing = extractNflSeasonCategoryTotals(
    root,
    'rushing',
    seasonYear,
    'rushingYards',
    'rushingAttempts'
  )
  const receiving = extractNflSeasonCategoryTotals(
    root,
    'receiving',
    seasonYear,
    'receptions',
    'receivingTargets'
  )
  if (!passing && !rushing && !receiving) return null

  return {
    seasonYear,
    passingGames: passing?.games ?? 0,
    passingAttemptsPerGame: passing ? passing.usageTotal / passing.games : 0,
    passingYardsPerGame: passing ? passing.primaryTotal / passing.games : 0,
    rushingGames: rushing?.games ?? 0,
    rushingAttemptsPerGame: rushing ? rushing.usageTotal / rushing.games : 0,
    rushingYardsPerGame: rushing ? rushing.primaryTotal / rushing.games : 0,
    receivingGames: receiving?.games ?? 0,
    receptionsPerGame: receiving ? receiving.primaryTotal / receiving.games : 0,
    receivingTargetsPerGame: receiving
      ? receiving.usageTotal / receiving.games
      : 0,
  }
}

export const fetchEspnNflPlayerPriorSeasonProfile = async (
  athleteId: string,
  seasonYear: number
): Promise<NflPlayerPriorSeasonProfile | null> => {
  try {
    return parseEspnNflPlayerPriorSeasonProfile(
      await fetchEspnJson(buildNflPlayerStatsUrl(athleteId)),
      seasonYear
    )
  } catch (error) {
    if (error instanceof EspnNflRequestError && error.statusCode === 404) {
      return null
    }
    throw error
  }
}

const isNflProfilePosition = (
  value: string
): value is EspnNflRosterPlayer['position'] =>
  value === 'QB' ||
  value === 'RB' ||
  value === 'FB' ||
  value === 'WR' ||
  value === 'TE'

const parseEspnNflRoster = (
  root: JsonObject,
  teamCode: string
): EspnNflRosterPlayer[] => {
  const playersById = new Map<string, EspnNflRosterPlayer>()
  for (const groupValue of asArray(root.athletes)) {
    const group = asObject(groupValue)
    for (const playerValue of asArray(group?.items)) {
      const player = asObject(playerValue)
      const position = asObject(player?.position)
      const id = asString(player?.id)
      const displayName = asString(player?.displayName)
      const positionCode = asString(position?.abbreviation)
      if (
        !id ||
        !displayName ||
        !positionCode ||
        !isNflProfilePosition(positionCode)
      ) {
        continue
      }
      playersById.set(id, {
        id,
        displayName,
        teamCode,
        position: positionCode,
      })
    }
  }
  return [...playersById.values()]
}

export const fetchEspnNflRoster = async (
  teamCode: string
): Promise<EspnNflRosterPlayer[]> => {
  const normalizedTeamCode = normalizeTeamCode(teamCode)
  if (!NFL_TEAM_CODES.has(normalizedTeamCode)) {
    throw new Error(`Invalid NFL team code: ${teamCode}`)
  }
  return parseEspnNflRoster(
    await fetchEspnJson(buildNflTeamRosterUrl(normalizedTeamCode)),
    normalizedTeamCode
  )
}

export const getEspnNflTeamCodes = (): string[] =>
  [...NFL_TEAM_CODES].sort((left, right) => left.localeCompare(right))

const readStoredProfileNumber = (
  data: FirebaseFirestore.DocumentData,
  key: keyof NflPlayerPriorSeasonProfile
): number | null => {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const parseStoredNflPlayerProfile = (
  data: FirebaseFirestore.DocumentData
): NflPlayerPriorSeasonProfile | null => {
  if (data.hasPriorSeasonProfile !== true) return null
  const seasonYear = readStoredProfileNumber(data, 'seasonYear')
  const passingGames = readStoredProfileNumber(data, 'passingGames')
  const passingAttemptsPerGame = readStoredProfileNumber(
    data,
    'passingAttemptsPerGame'
  )
  const passingYardsPerGame = readStoredProfileNumber(
    data,
    'passingYardsPerGame'
  )
  const rushingGames = readStoredProfileNumber(data, 'rushingGames')
  const rushingAttemptsPerGame = readStoredProfileNumber(
    data,
    'rushingAttemptsPerGame'
  )
  const rushingYardsPerGame = readStoredProfileNumber(
    data,
    'rushingYardsPerGame'
  )
  const receivingGames = readStoredProfileNumber(data, 'receivingGames')
  const receptionsPerGame = readStoredProfileNumber(data, 'receptionsPerGame')
  const receivingTargetsPerGame = readStoredProfileNumber(
    data,
    'receivingTargetsPerGame'
  )
  if (
    seasonYear === null ||
    passingGames === null ||
    passingAttemptsPerGame === null ||
    passingYardsPerGame === null ||
    rushingGames === null ||
    rushingAttemptsPerGame === null ||
    rushingYardsPerGame === null ||
    receivingGames === null ||
    receptionsPerGame === null ||
    receivingTargetsPerGame === null
  ) {
    return null
  }
  return {
    seasonYear,
    passingGames,
    passingAttemptsPerGame,
    passingYardsPerGame,
    rushingGames,
    rushingAttemptsPerGame,
    rushingYardsPerGame,
    receivingGames,
    receptionsPerGame,
    receivingTargetsPerGame,
  }
}

export const loadNflPlayerProfilesFromFirestore = (
  force: boolean = false
): Promise<void> => {
  if (nflPlayerProfilesLoad && !force) return nflPlayerProfilesLoad
  const startedAt = Date.now()
  const load = db
    .collection(NFL_PLAYER_PROFILE_COLLECTION)
    .where('hasPriorSeasonProfile', '==', true)
    .get()
    .then((snapshot) => {
      const nextProfiles = new Map<string, NflPlayerPriorSeasonProfile>()
      for (const document of snapshot.docs) {
        const profile = parseStoredNflPlayerProfile(document.data())
        if (profile) nextProfiles.set(document.id, profile)
      }
      nflPlayerProfileById.clear()
      for (const [athleteId, profile] of nextProfiles) {
        nflPlayerProfileById.set(athleteId, profile)
      }
      console.log(
        `[nfl-profile] cache loaded profiles=${nextProfiles.size} reads=${snapshot.size} durationMs=${Date.now() - startedAt}`
      )
    })
    .catch((error: Error) => {
      nflPlayerProfilesLoad = null
      console.warn(`[nfl-profile] cache load failed message=${error.message}`)
    })
  nflPlayerProfilesLoad = load
  return load
}

const enrichNflAthletesWithPriorSeasonProfiles = (
  athletes: readonly EspnNflAthleteName[],
  seasonYear: number | null
): EspnNflAthleteName[] => {
  if (seasonYear === null) return [...athletes]
  const priorSeasonYear = seasonYear - 1
  return athletes.map((athlete) => {
    const profile = nflPlayerProfileById.get(athlete.id) ?? null
    return {
      ...athlete,
      priorSeasonProfile:
        profile?.seasonYear === priorSeasonYear ? profile : null,
    }
  })
}

export const fetchEspnNflScoreboard = async (
  date: Date
): Promise<EspnNflScheduledGame[]> =>
  parseEspnNflScoreboard(await fetchEspnJson(buildScoreboardUrl(date)))

export const fetchEspnNflSummary = async (
  eventId: string
): Promise<EspnNflSummary> => {
  const [summaryRoot] = await Promise.all([
    fetchEspnJson(buildSummaryUrl(eventId)),
    loadNflPlayerProfilesFromFirestore(),
  ])
  const summary = parseEspnNflSummary(summaryRoot)
  return {
    ...summary,
    athletes: enrichNflAthletesWithPriorSeasonProfiles(
      summary.athletes,
      summary.seasonYear
    ),
  }
}

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
const NFL_RUNTIME_CACHE = new Map<string, NflRuntimeState>()
const NFL_RUNTIME_LOADS = new Map<string, Promise<NflRuntimeState>>()
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
  const openGameIds = new Set(docs.map((doc) => doc.id))
  OPEN_NFL_GAMES_CACHE.clear()
  for (const doc of docs) {
    OPEN_NFL_GAMES_CACHE.set(doc.id, {
      id: doc.id,
      ref: doc.ref,
      data: doc.data(),
    })
  }
  for (const gameId of NFL_RUNTIME_CACHE.keys()) {
    if (!openGameIds.has(gameId)) NFL_RUNTIME_CACHE.delete(gameId)
  }
  for (const gameId of NFL_RUNTIME_LOADS.keys()) {
    if (!openGameIds.has(gameId)) NFL_RUNTIME_LOADS.delete(gameId)
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
  NFL_RUNTIME_CACHE.delete(gameId)
  NFL_RUNTIME_LOADS.delete(gameId)
}

const appendUnique = (values: string[], value: string | undefined): void => {
  if (value && !values.includes(value)) values.push(value)
}

const contextString = (
  context: ResolutionContext | null,
  key: string
): string | undefined => {
  const value = context?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const contextNumber = (
  context: ResolutionContext | null,
  key: string
): number | undefined => {
  const value = context?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const normalizeDedupeToken = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')

const deriveNflQuestionDedupe = (
  templateId: string | undefined,
  context: ResolutionContext | null
): NflQuestionDedupe => {
  const driveId = contextString(context, 'driveId')
  const targetToken = contextString(context, 'targetToken')
  const period = contextNumber(context, 'period')
  if (templateId === 'NFL_GAME_WINNER') return { gameQuestionKey: 'winner' }
  if (templateId?.startsWith('NFL_PERIOD_TEAM_COMPARE_') && period) {
    return { periodQuestionKey: `team:${period}` }
  }
  if (templateId?.startsWith('NFL_PERIOD_PLAYER_') && period) {
    return { periodQuestionKey: `player:${period}` }
  }
  if (templateId?.startsWith('NFL_RED_ZONE_')) {
    return {
      ...(driveId ? { redZoneDriveId: driveId } : {}),
      ...(period ? { redZonePeriodKey: String(period) } : {}),
    }
  }
  if (templateId === 'NFL_FOURTH_DOWN_CONVERSION') {
    return {
      ...(driveId ? { timeoutQuestionDriveId: driveId } : {}),
      ...(period ? { periodQuestionKey: `fourth:${period}` } : {}),
    }
  }
  if (templateId === 'NFL_NEXT_COMPLETION_RECEIVER') {
    return {
      ...(driveId ? { timeoutQuestionDriveId: driveId } : {}),
      ...(period
        ? {
            completionReceiverHalfKey:
              period <= 2 ? 'first_half' : 'second_half',
          }
        : {}),
    }
  }
  if (
    templateId === 'NFL_POSSESSION_FIELD_GOAL' ||
    templateId === 'NFL_NEXT_OFFENSIVE_PLAY_PASS' ||
    templateId === 'NFL_DRIVE_PLAYER_PASSING_YARDS_RANGE'
  ) {
    return driveId ? { timeoutQuestionDriveId: driveId } : {}
  }
  if (
    (templateId === 'NFL_RECEIVER_ANOTHER_CATCH_DRIVE' ||
      templateId === 'NFL_RECEIVER_NEXT_TARGET_CAUGHT') &&
    driveId &&
    targetToken
  ) {
    return {
      receiverQuestionKey: `${driveId}:${normalizeDedupeToken(targetToken)}`,
    }
  }
  return {}
}

const timestampMillis = (
  value: admin.firestore.Timestamp | undefined
): number | null => value?.toMillis() ?? null

const loadNflRuntimeState = async (
  game: CachedOpenNflGame
): Promise<NflRuntimeState> => {
  const cached = NFL_RUNTIME_CACHE.get(game.id)
  if (cached) return cached
  const loading = NFL_RUNTIME_LOADS.get(game.id)
  if (loading) return loading

  const load = (async (): Promise<NflRuntimeState> => {
    const [eventsSnapshot, questionsSnapshot] = await Promise.all([
      game.ref.collection('nflEvents').get(),
      game.ref.collection('questions').get(),
    ])
    const runtime: NflRuntimeState = {
      playFingerprints: {},
      activeQuestions: [],
      redZoneAskedDriveIds: [],
      redZoneAskedPeriodKeys: [],
      receiverQuestionKeys: [],
      completionReceiverHalfKeys: [],
      timeoutQuestionDriveIds: [],
      gameQuestionKeys: [],
      periodQuestionKeys: [],
      questionCount: questionsSnapshot.size,
      lastQuestionAtMs: null,
    }

    for (const eventDoc of eventsSnapshot.docs) {
      const event = eventDoc.data() as StoredNflEvent
      if (event.id && event.fingerprint) {
        runtime.playFingerprints[event.id] = event.fingerprint
      }
    }

    for (const questionDoc of questionsSnapshot.docs) {
      const question = questionDoc.data() as StoredNflQuestion
      const resolutionContext = parseStoredResolutionContext(
        question.resolutionContext
      )
      const createdAtMs =
        timestampMillis(question.triggeredAt) ??
        timestampMillis(question.createdAt) ??
        0
      if (
        runtime.lastQuestionAtMs === null ||
        createdAtMs > runtime.lastQuestionAtMs
      ) {
        runtime.lastQuestionAtMs = createdAtMs
      }

      if (question.state === 'open') {
        const templateId = question.engineTag
        const windowType = asNflQuestionWindowType(question.windowType)
        if (templateId && windowType && resolutionContext) {
          runtime.activeQuestions.push({
            id: questionDoc.id,
            templateId,
            windowType,
            resolutionContext,
            createdAtMs,
          })
        }
      }

      const dedupe =
        question.nflDedupe ??
        deriveNflQuestionDedupe(question.engineTag, resolutionContext)
      appendUnique(runtime.redZoneAskedDriveIds, dedupe?.redZoneDriveId)
      appendUnique(runtime.redZoneAskedPeriodKeys, dedupe?.redZonePeriodKey)
      appendUnique(runtime.receiverQuestionKeys, dedupe?.receiverQuestionKey)
      appendUnique(
        runtime.completionReceiverHalfKeys,
        dedupe?.completionReceiverHalfKey
      )
      appendUnique(
        runtime.timeoutQuestionDriveIds,
        dedupe?.timeoutQuestionDriveId
      )
      appendUnique(runtime.gameQuestionKeys, dedupe?.gameQuestionKey)
      appendUnique(runtime.periodQuestionKeys, dedupe?.periodQuestionKey)
    }

    NFL_RUNTIME_CACHE.set(game.id, runtime)
    console.log(
      `[nfl] runtime hydrated game=${game.id} plays=${eventsSnapshot.size} questions=${questionsSnapshot.size} active=${runtime.activeQuestions.length}`
    )
    return runtime
  })().finally(() => {
    NFL_RUNTIME_LOADS.delete(game.id)
  })

  NFL_RUNTIME_LOADS.set(game.id, load)
  return load
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

const parseStoredNumberArray = (
  value: JsonValue | undefined
): number[] | null => {
  const values = asArray(value)
  return values.length > 0 &&
    values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? (values as number[])
    : null
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
    rangeCutoffs: parseStoredNumberArray(context.rangeCutoffs) ?? undefined,
    receiverChoiceByTarget:
      parseStoredStringRecord(context.receiverChoiceByTarget) ?? undefined,
  }
}

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

const toCandidateDedupe = (
  candidate: NflQuestionCandidate
): NflQuestionDedupe => ({
  ...(candidate.redZoneDriveId
    ? { redZoneDriveId: candidate.redZoneDriveId }
    : {}),
  ...(candidate.redZonePeriodKey
    ? { redZonePeriodKey: candidate.redZonePeriodKey }
    : {}),
  ...(candidate.receiverQuestionKey
    ? { receiverQuestionKey: candidate.receiverQuestionKey }
    : {}),
  ...(candidate.completionReceiverHalfKey
    ? { completionReceiverHalfKey: candidate.completionReceiverHalfKey }
    : {}),
  ...(candidate.timeoutQuestionDriveId
    ? { timeoutQuestionDriveId: candidate.timeoutQuestionDriveId }
    : {}),
  ...(candidate.gameQuestionKey
    ? { gameQuestionKey: candidate.gameQuestionKey }
    : {}),
  ...(candidate.periodQuestionKey
    ? { periodQuestionKey: candidate.periodQuestionKey }
    : {}),
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
    const summaryReceivedAtMs = Date.now()
    const runtime = await loadNflRuntimeState(cachedGame)
    const storedFingerprints = runtime.playFingerprints
    const nextFingerprints = { ...storedFingerprints }
    const writes: {
      ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
      data: FirebaseFirestore.DocumentData
    }[] = []
    const createdPlays: EspnNflPlay[] = []
    const createdSourceAgesMs: number[] = []
    let created = 0
    let revised = 0

    for (const play of summary.plays) {
      const fingerprint = fingerprintPlay(play)
      const previousFingerprint = storedFingerprints[play.id]
      if (previousFingerprint === fingerprint) continue
      const isRevision = typeof previousFingerprint === 'string'
      const wallclockMs = getNflPlayWallclockMs(play)
      const sourceWallclockAgeAtFirstSeenMs =
        wallclockMs === null ? null : summaryReceivedAtMs - wallclockMs
      nextFingerprints[play.id] = fingerprint
      if (isRevision) revised += 1
      else {
        created += 1
        createdPlays.push(play)
        if (sourceWallclockAgeAtFirstSeenMs !== null) {
          createdSourceAgesMs.push(sourceWallclockAgeAtFirstSeenMs)
        }
      }

      writes.push({
        ref: cachedGame.ref.collection('nflEvents').doc(`play_${play.id}`),
        data: {
          ...play,
          provider: 'espn',
          providerEventId: eventId,
          fingerprint,
          isRevision,
          ...(isRevision
            ? {}
            : {
                firstSeenAt:
                  admin.firestore.Timestamp.fromMillis(summaryReceivedAtMs),
                sourceWallclockAgeAtFirstSeenMs,
              }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      })
    }

    const nowMs = Date.now()
    const latestPlay =
      summary.plays.length > 0 ? summary.plays[summary.plays.length - 1] : null
    let activeQuestions = runtime.activeQuestions
    let redZoneAskedDriveIds = runtime.redZoneAskedDriveIds
    let redZoneAskedPeriodKeys = runtime.redZoneAskedPeriodKeys
    let receiverQuestionKeys = runtime.receiverQuestionKeys
    let completionReceiverHalfKeys = runtime.completionReceiverHalfKeys
    let timeoutQuestionDriveIds = runtime.timeoutQuestionDriveIds
    let gameQuestionKeys = runtime.gameQuestionKeys
    let periodQuestionKeys = runtime.periodQuestionKeys
    let questionCount = runtime.questionCount
    let lastQuestionAtMs = runtime.lastQuestionAtMs
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
        const questionId = await createAndSendEngineQuestion(gameId, payload, {
          nflDedupe: { gameQuestionKey: 'winner' },
        })
        activeQuestions.push(toActiveNflQuestion(questionId, payload, nowMs))
        gameQuestionKeys = [...gameQuestionKeys, 'winner'].slice(-20)
        questionCount += 1
        lastQuestionAtMs = nowMs
        console.log(
          `[nfl] question created game=${gameId} question=${questionId} play=pregame template=${payload.templateId} priority=GAME`
        )
      }
    }
    for (const play of createdPlays) {
      const playIndex = summary.plays.findIndex(
        (summaryPlay) => summaryPlay.id === play.id
      )
      activeQuestions = await resolveActiveNflQuestionsForPlay(
        gameId,
        activeQuestions,
        play,
        summary.plays.slice(0, Math.max(0, playIndex) + 1),
        summary.completed && play.id === latestPlay?.id
      )
    }
    const latestCreatedPlay = createdPlays[createdPlays.length - 1] ?? null
    if (
      summary.completed &&
      latestPlay &&
      latestCreatedPlay?.id !== latestPlay.id &&
      activeQuestions.length > 0
    ) {
      activeQuestions = await resolveActiveNflQuestionsForPlay(
        gameId,
        activeQuestions,
        latestPlay,
        summary.plays,
        true
      )
    }

    if (latestCreatedPlay && latestCreatedPlay.id === latestPlay?.id) {
      const homeTeam =
        typeof game.homeTeam === 'string' ? game.homeTeam.trim() : ''
      const awayTeam =
        typeof game.awayTeam === 'string' ? game.awayTeam.trim() : ''
      const candidateDecision = buildNflQuestionCandidateDecision({
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
        sourceAgePolicy: NFL_QUESTION_SOURCE_AGE_POLICY,
      })
      const candidate = candidateDecision.candidate
      if (!candidate && candidateDecision.skipReason !== 'NO_CANDIDATE') {
        console.log(
          `[nfl] question skip game=${gameId} play=${latestCreatedPlay.id} candidate=${candidateDecision.priority ?? 'none'} reason=${candidateDecision.skipReason ?? 'unknown'} sourceAgeMs=${candidateDecision.sourceAgeMs ?? 'unknown'} sourceAgeLimitMs=${candidateDecision.maxSourceAgeMs ?? 'unknown'}`
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
            candidate.payload,
            { nflDedupe: toCandidateDedupe(candidate) }
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
            `[nfl] question created game=${gameId} question=${questionId} play=${latestCreatedPlay.id} template=${candidate.payload.templateId} priority=${candidate.priority} sourceAgeMs=${candidateDecision.sourceAgeMs ?? 'unknown'} sourceAgeLimitMs=${candidateDecision.maxSourceAgeMs ?? 'unknown'} sourceAgePolicy=${NFL_QUESTION_SOURCE_AGE_POLICY}`
          )
        }
      }
    }

    // Persist plays only after question processing. On restart, the play
    // documents are the durable marker that the engine processed each play.
    if (writes.length > 0) await commitNflPlayWrites(writes)

    runtime.playFingerprints = nextFingerprints
    runtime.activeQuestions = activeQuestions
    runtime.redZoneAskedDriveIds = redZoneAskedDriveIds
    runtime.redZoneAskedPeriodKeys = redZoneAskedPeriodKeys
    runtime.receiverQuestionKeys = receiverQuestionKeys
    runtime.completionReceiverHalfKeys = completionReceiverHalfKeys
    runtime.timeoutQuestionDriveIds = timeoutQuestionDriveIds
    runtime.gameQuestionKeys = gameQuestionKeys
    runtime.periodQuestionKeys = periodQuestionKeys
    runtime.questionCount = questionCount
    runtime.lastQuestionAtMs = lastQuestionAtMs

    const hasLegacyRuntimeState =
      game.nflLastSyncAt !== undefined ||
      game.nflPlayFingerprints !== undefined ||
      game.nflActiveQuestions !== undefined ||
      game.nflQuestionedRedZoneDriveIds !== undefined ||
      game.nflQuestionedRedZonePeriodKeys !== undefined ||
      game.nflReceiverQuestionKeys !== undefined ||
      game.nflCompletionReceiverHalfKeys !== undefined ||
      game.nflTimeoutQuestionDriveIds !== undefined ||
      game.nflGameQuestionKeys !== undefined ||
      game.nflPeriodQuestionKeys !== undefined ||
      game.nflLastQuestionAtMs !== undefined ||
      game.nflQuestionCount !== undefined ||
      game.nflLastPlayId !== undefined ||
      game.nflLastPlayWallclock !== undefined
    const publicGameChanged =
      hasLegacyRuntimeState ||
      game.nflGameStatus !== summary.statusName ||
      game.nflGameStatusState !== summary.statusState ||
      game.nflGameStatusText !== summary.statusText ||
      game.period !== (latestPlay?.period ?? null) ||
      game.gameClock !== (latestPlay?.clock ?? null) ||
      game.homeScore !== summary.homeScore ||
      game.awayScore !== summary.awayScore

    if (publicGameChanged) {
      const cachedTimestamp = admin.firestore.Timestamp.now()
      const update = {
        ...(hasLegacyRuntimeState
          ? {
              nflLastSyncAt: admin.firestore.FieldValue.delete(),
              nflPlayFingerprints: admin.firestore.FieldValue.delete(),
              nflActiveQuestions: admin.firestore.FieldValue.delete(),
              nflQuestionedRedZoneDriveIds: admin.firestore.FieldValue.delete(),
              nflQuestionedRedZonePeriodKeys:
                admin.firestore.FieldValue.delete(),
              nflReceiverQuestionKeys: admin.firestore.FieldValue.delete(),
              nflCompletionReceiverHalfKeys:
                admin.firestore.FieldValue.delete(),
              nflTimeoutQuestionDriveIds: admin.firestore.FieldValue.delete(),
              nflGameQuestionKeys: admin.firestore.FieldValue.delete(),
              nflPeriodQuestionKeys: admin.firestore.FieldValue.delete(),
              nflLastQuestionAtMs: admin.firestore.FieldValue.delete(),
              nflQuestionCount: admin.firestore.FieldValue.delete(),
              nflLastPlayId: admin.firestore.FieldValue.delete(),
              nflLastPlayWallclock: admin.firestore.FieldValue.delete(),
            }
          : {}),
        nflGameStatus: summary.statusName,
        nflGameStatusState: summary.statusState,
        nflGameStatusText: summary.statusText,
        period: latestPlay?.period ?? null,
        gameClock: latestPlay?.clock ?? null,
        homeScore: summary.homeScore,
        awayScore: summary.awayScore,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
      await cachedGame.ref.set(update, { merge: true })
      mergeOpenNflGameCacheData(gameId, {
        ...update,
        updatedAt: cachedTimestamp,
      })
    }

    if (writes.length > 0) {
      const minSourceAgeMs =
        createdSourceAgesMs.length > 0 ? Math.min(...createdSourceAgesMs) : null
      const maxSourceAgeMs =
        createdSourceAgesMs.length > 0 ? Math.max(...createdSourceAgesMs) : null
      console.log(
        `[nfl] live sync game=${gameId} event=${eventId} created=${created} revised=${revised} status=${summary.statusName} sourceAgeMinMs=${minSourceAgeMs ?? 'unknown'} sourceAgeMaxMs=${maxSourceAgeMs ?? 'unknown'}`
      )
    }

    if (summary.completed) {
      console.log(`[nfl] live sync game=${gameId} status=final auto_end=1`)
      await endGameById(gameId)
      removeOpenNflGameFromCache(gameId)
    }

    return {
      updated:
        publicGameChanged || writes.length > 0 || summary.completed ? 1 : 0,
      created,
      revised,
      errors: 0,
    }
  } catch (error) {
    NFL_RUNTIME_CACHE.delete(gameId)
    NFL_RUNTIME_LOADS.delete(gameId)
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
