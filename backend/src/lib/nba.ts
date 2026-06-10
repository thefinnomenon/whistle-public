import https from 'https'
import { createHash } from 'crypto'
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
  type OfficialCumulativeStatsSnapshot,
  type OfficialStatLine,
} from '../types/engine'
import {
  type DerivedStatsSnapshot,
  resolveQuestionForEvent,
  triggerBasketballQuestion,
  triggerGameStartQuestions,
} from './engine'
import { buildSimResult } from './simResult'
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
const NBA_HTML_TIMEOUT_MS = Number(process.env.NBA_HTML_TIMEOUT_MS ?? 120_000)
const ENABLE_OFFICIAL_CUMULATIVE_FETCH =
  process.env.NBA_ENABLE_OFFICIAL_CUMULATIVE_FETCH === '1'
const LOG_OFFICIAL_COMPARE = process.env.NBA_LOG_OFFICIAL_COMPARE === '1'
const USE_OFFICIAL_CUMULATIVE_RESOLUTION =
  process.env.NBA_USE_OFFICIAL_CUMULATIVE_RESOLUTION === '1'
const PERSIST_RAW_NBA_EVENTS = process.env.NBA_PERSIST_RAW_EVENTS === '1'
const PERSIST_BOX_SCORE_SNAPSHOTS =
  process.env.NBA_PERSIST_BOX_SCORE_SNAPSHOTS === '1'
const ENABLE_ENTITYSPORT_SHADOW_CAPTURE =
  process.env.NBA_ENABLE_ENTITYSPORT_SHADOW_CAPTURE === '1'
const ENTITYSPORT_TOKEN = process.env.ENTITYSPORT_TOKEN ?? ''
const ENTITYSPORT_TIMEOUT_MS = 12_000
const ENTITYSPORT_MAX_PAYLOAD_BYTES = 850_000

const readPositiveNumberEnv = (
  name: string,
  rawValue: string | undefined,
  fallback: number,
  minimum: number
): number => {
  if (!rawValue) return fallback

  const value = Number(rawValue)
  if (Number.isFinite(value) && value >= minimum) return value

  console.warn(
    `[config] invalid_number env=${name} value=${rawValue} fallback=${fallback}`
  )
  return fallback
}

const NBA_LIVE_HEARTBEAT_MS = readPositiveNumberEnv(
  'NBA_LIVE_HEARTBEAT_MS',
  process.env.NBA_LIVE_HEARTBEAT_MS,
  60_000,
  10_000
)
const NBA_OPEN_GAMES_REFRESH_MS = readPositiveNumberEnv(
  'NBA_OPEN_GAMES_REFRESH_MS',
  process.env.NBA_OPEN_GAMES_REFRESH_MS,
  60_000,
  10_000
)
const NBA_OPEN_GAMES_WATCH_RESTART_MS = 30_000
const NBA_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS = 5_000

type CacheEntry = {
  etag?: string
  lastModified?: string
}

type NbaGameData = FirebaseFirestore.DocumentData

type FirestoreWrite = {
  ref: FirebaseFirestore.DocumentReference
  data: FirebaseFirestore.DocumentData
}

type CachedOpenNbaGame = {
  id: string
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
  data: NbaGameData
}

type ResolvableQuestionDoc = Parameters<typeof resolveQuestionForEvent>[0] & {
  templateId?: string | null
  engineTag?: string | null
}

const buildFinalResolutionContext = (
  question: ResolvableQuestionDoc,
  event: EngineEvent,
  boxScore: BoxScore | null
) => {
  const finalValue = buildSimResult(question, event, boxScore)
  return {
    ...(question.resolutionContext ?? {}),
    finalValue,
  }
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

const fetchHtml = (
  url: string,
  timeoutMs: number = NBA_HTML_TIMEOUT_MS
): Promise<string> =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.nba.com/',
          Origin: 'https://www.nba.com',
          'User-Agent': NBA_JSON_HEADERS['User-Agent'],
        },
      },
      (res) => {
        const { statusCode } = res
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          if (statusCode && statusCode >= 400) {
            reject(new Error(`NBA HTML request failed ${statusCode}: ${url}`))
            return
          }
          resolve(raw)
        })
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`NBA HTML timeout ${timeoutMs}ms: ${url}`))
    })
    req.on('error', (err) => reject(err))
  })

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

const asObject = (
  value: JsonValue | undefined | null
): { [key: string]: JsonValue } | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const asArray = (value: JsonValue | undefined | null): JsonValue[] | null => {
  if (!value || !Array.isArray(value)) return null
  return value
}

type EntitySportFetchResult = {
  url: string
  durationMs: number
  statusCode: number | null
  payload: JsonValue | null
  payloadBytes: number
  payloadSha1: string | null
  payloadOmitted: boolean
  payloadPreview: string | null
  error: string | null
}

type EntitySportFetchAttempt = EntitySportFetchResult & {
  attemptedUrlIndex: number
}

type EntitySportMatchSummary = {
  mid: string
  homeAbbr: string
  awayAbbr: string
  timestampStartMs: number | null
}

const ENTITYSPORT_MATCHES_BY_DATE_CACHE = new Map<
  string,
  EntitySportMatchSummary[]
>()

const isNonEmptyString = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0

const readEntitySportMatchId = (
  game: Record<string, JsonValue>,
  nbaGameId: string
): string | null => {
  const directCandidates: (JsonValue | undefined)[] = [
    game.entitySportMatchId,
    game.entitysportMatchId,
    game.entitySportGameId,
    game.entitysportGameId,
    game.entitySportId,
    game.entitysportId,
  ]
  for (const candidate of directCandidates) {
    if (isNonEmptyString(candidate)) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate)
    }
  }
  return nbaGameId || null
}

const buildEntitySportPbpUrls = (token: string, matchId: string): string[] => {
  const t = encodeURIComponent(token)
  const m = encodeURIComponent(matchId)
  return [
    `https://basketballapi.entitysport.com/matches/${m}/info?token=${t}`,
    `https://basketballapi.entitysport.com/matches/${m}/live?token=${t}`,
    `https://basketballapi.entitysport.com/matches/${m}/scorecard?token=${t}`,
  ]
}

const buildEntitySportMatchesByDateUrl = (token: string, dateYmd: string) => {
  const t = encodeURIComponent(token)
  const d = encodeURIComponent(dateYmd)
  return `https://basketballapi.entitysport.com/matches?token=${t}&date=${d}`
}

const normalizeEntitySportTeamAbbr = (value: JsonValue | undefined): string =>
  isNonEmptyString(value) ? value.trim().toUpperCase() : ''

const toDateYmdUtc = (date: Date): string => date.toISOString().slice(0, 10)

const shiftDateYmdUtc = (dateYmd: string, dayDelta: number): string => {
  const base = new Date(`${dateYmd}T00:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + dayDelta)
  return toDateYmdUtc(base)
}

const extractEntitySportMatches = (
  payload: JsonValue | null
): EntitySportMatchSummary[] => {
  const items = asArray(readJsonPath(payload, ['response', 'items']))
  if (!items) return []
  const matches: EntitySportMatchSummary[] = []
  for (const item of items) {
    const obj = asObject(item)
    if (!obj) continue
    const midRaw = obj.mid
    const mid =
      typeof midRaw === 'number' && Number.isFinite(midRaw)
        ? String(midRaw)
        : isNonEmptyString(midRaw)
          ? midRaw.trim()
          : ''
    if (!mid) continue
    const teamsObj = asObject(obj.teams)
    const homeObj = asObject(teamsObj?.home ?? null)
    const awayObj = asObject(teamsObj?.away ?? null)
    const homeAbbr = normalizeEntitySportTeamAbbr(homeObj?.abbr)
    const awayAbbr = normalizeEntitySportTeamAbbr(awayObj?.abbr)
    const tsRaw = obj.timestampstart
    const timestampStartMs =
      typeof tsRaw === 'number' && Number.isFinite(tsRaw)
        ? tsRaw * 1000
        : isNonEmptyString(tsRaw)
          ? Number.isFinite(Number(tsRaw))
            ? Number(tsRaw) * 1000
            : null
          : null
    matches.push({
      mid,
      homeAbbr,
      awayAbbr,
      timestampStartMs,
    })
  }
  return matches
}

const fetchEntitySportMatchesForDate = async (
  dateYmd: string
): Promise<EntitySportMatchSummary[]> => {
  const cached = ENTITYSPORT_MATCHES_BY_DATE_CACHE.get(dateYmd)
  if (cached) return cached
  const result = await fetchEntitySportJson(
    buildEntitySportMatchesByDateUrl(ENTITYSPORT_TOKEN, dateYmd)
  )
  if (result.error || !isEntitySportPayloadOk(result.payload)) {
    console.warn(
      `[entitysport] matches_by_date fetch failed date=${dateYmd} error=${result.error ?? 'non_ok_status'}`
    )
    ENTITYSPORT_MATCHES_BY_DATE_CACHE.set(dateYmd, [])
    return []
  }
  const matches = extractEntitySportMatches(result.payload)
  ENTITYSPORT_MATCHES_BY_DATE_CACHE.set(dateYmd, matches)
  return matches
}

const resolveEntitySportMatchId = async ({
  homeTeam,
  awayTeam,
  startTimeMs,
  fallbackMatchId,
}: {
  homeTeam: string | null
  awayTeam: string | null
  startTimeMs: number | null
  fallbackMatchId: string | null
}): Promise<string | null> => {
  if (!homeTeam || !awayTeam || startTimeMs === null) return fallbackMatchId
  const home = normalizeTeamCode(homeTeam)
  const away = normalizeTeamCode(awayTeam)
  const startDate = new Date(startTimeMs)
  if (Number.isNaN(startDate.getTime())) return fallbackMatchId
  const ymd = toDateYmdUtc(startDate)
  const candidateDates = [
    shiftDateYmdUtc(ymd, -1),
    ymd,
    shiftDateYmdUtc(ymd, 1),
  ]

  let best: { mid: string; diffMs: number } | null = null
  for (const dateYmd of candidateDates) {
    const matches = await fetchEntitySportMatchesForDate(dateYmd)
    for (const match of matches) {
      if (match.homeAbbr !== home || match.awayAbbr !== away) continue
      const diffMs =
        match.timestampStartMs === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(match.timestampStartMs - startTimeMs)
      if (!best || diffMs < best.diffMs) {
        best = { mid: match.mid, diffMs }
      }
    }
  }

  if (!best) return fallbackMatchId
  if (!Number.isFinite(best.diffMs) || best.diffMs > 8 * 60 * 60 * 1000) {
    return fallbackMatchId
  }
  return best.mid
}

const buildEntitySportBoxScoreUrls = (
  token: string,
  matchId: string
): string[] => {
  const t = encodeURIComponent(token)
  const m = encodeURIComponent(matchId)
  return [
    `https://basketballapi.entitysport.com/matches/${m}/stats?token=${t}`,
    `https://basketballapi.entitysport.com/matches/${m}/scorecard?token=${t}`,
    `https://basketballapi.entitysport.com/matches/${m}/live?token=${t}`,
  ]
}

const fetchEntitySportJson = async (
  url: string
): Promise<EntitySportFetchResult> => {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const req = https.get(url, { headers: NBA_JSON_HEADERS }, (res) => {
      const statusCode =
        typeof res.statusCode === 'number' ? res.statusCode : null
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        const durationMs = Date.now() - startedAt
        if (statusCode !== null && statusCode >= 400) {
          resolve({
            url,
            durationMs,
            statusCode,
            payload: null,
            payloadBytes: raw.length,
            payloadSha1:
              raw.length > 0
                ? createHash('sha1').update(raw).digest('hex')
                : null,
            payloadOmitted: true,
            payloadPreview: raw.slice(0, 512),
            error: `status_${statusCode}`,
          })
          return
        }
        let parsed: JsonValue | null = null
        try {
          parsed = JSON.parse(raw) as JsonValue
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          resolve({
            url,
            durationMs,
            statusCode,
            payload: null,
            payloadBytes: raw.length,
            payloadSha1:
              raw.length > 0
                ? createHash('sha1').update(raw).digest('hex')
                : null,
            payloadOmitted: true,
            payloadPreview: raw.slice(0, 512),
            error: `parse_error:${message}`,
          })
          return
        }
        const payloadBytes = raw.length
        const shouldOmitPayload = payloadBytes > ENTITYSPORT_MAX_PAYLOAD_BYTES
        resolve({
          url,
          durationMs,
          statusCode,
          payload: shouldOmitPayload ? null : parsed,
          payloadBytes,
          payloadSha1:
            payloadBytes > 0
              ? createHash('sha1').update(raw).digest('hex')
              : null,
          payloadOmitted: shouldOmitPayload,
          payloadPreview: shouldOmitPayload ? raw.slice(0, 1024) : null,
          error: null,
        })
      })
    })
    req.setTimeout(ENTITYSPORT_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout_${ENTITYSPORT_TIMEOUT_MS}`))
    })
    req.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      resolve({
        url,
        durationMs: Date.now() - startedAt,
        statusCode: null,
        payload: null,
        payloadBytes: 0,
        payloadSha1: null,
        payloadOmitted: true,
        payloadPreview: null,
        error: `request_error:${message}`,
      })
    })
  })
}

const isEntitySportPayloadOk = (payload: JsonValue | null): boolean => {
  const payloadObject = asObject(payload)
  if (!payloadObject) return false
  const statusRaw = payloadObject.status
  return typeof statusRaw === 'string' && statusRaw.toLowerCase() === 'ok'
}

const fetchEntitySportFirstSuccessful = async (
  urls: string[]
): Promise<{
  selected: EntitySportFetchResult
  attempts: EntitySportFetchAttempt[]
}> => {
  const attempts: EntitySportFetchAttempt[] = []
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i]
    const result = await fetchEntitySportJson(url)
    const attempt: EntitySportFetchAttempt = {
      ...result,
      attemptedUrlIndex: i,
    }
    attempts.push(attempt)
    if (!result.error && isEntitySportPayloadOk(result.payload)) {
      return { selected: result, attempts }
    }
  }
  const fallback =
    attempts[attempts.length - 1] ??
    ({
      url: '',
      durationMs: 0,
      statusCode: null,
      payload: null,
      payloadBytes: 0,
      payloadSha1: null,
      payloadOmitted: true,
      payloadPreview: null,
      error: 'no_attempts',
    } satisfies EntitySportFetchResult)
  return { selected: fallback, attempts }
}

const extractEntitySportEventCount = (
  payload: JsonValue | null
): number | null => {
  if (!payload) return null
  const paths: string[][] = [
    ['response', 'items'],
    ['response', 'events'],
    ['response', 'playByPlay'],
    ['response', 'playbyplay'],
    ['response', 'actions'],
    ['response', 'ball_by_ball'],
    ['response'],
    ['items'],
    ['events'],
    ['playByPlay'],
    ['playbyplay'],
    ['actions'],
  ]
  for (const path of paths) {
    const candidate = readJsonPath(payload, path)
    const arr = asArray(candidate)
    if (arr) return arr.length
  }
  return null
}

const captureEntitySportShadowForAction = async ({
  gameId,
  nbaGameId,
  matchId,
  homeTeam,
  awayTeam,
  startTimeMs,
  persistResolvedMatchId,
  anchorActionNumber,
  anchorPeriod,
  anchorClock,
}: {
  gameId: string
  nbaGameId: string
  matchId: string
  homeTeam: string | null
  awayTeam: string | null
  startTimeMs: number | null
  persistResolvedMatchId: (matchId: string) => Promise<void>
  anchorActionNumber: number
  anchorPeriod: number | null
  anchorClock: string | null
}) => {
  if (!ENABLE_ENTITYSPORT_SHADOW_CAPTURE) return
  if (!isNonEmptyString(ENTITYSPORT_TOKEN)) return
  try {
    const resolvedMatchId = await resolveEntitySportMatchId({
      homeTeam,
      awayTeam,
      startTimeMs,
      fallbackMatchId: matchId,
    })
    if (!resolvedMatchId) return
    if (resolvedMatchId !== matchId) {
      await persistResolvedMatchId(resolvedMatchId)
      console.log(
        `[entitysport] mapped_match_id game=${gameId} nbaGameId=${nbaGameId} oldMatchId=${matchId} newMatchId=${resolvedMatchId}`
      )
    }

    const [pbpFetch, boxFetch] = await Promise.all([
      fetchEntitySportFirstSuccessful(
        buildEntitySportPbpUrls(ENTITYSPORT_TOKEN, resolvedMatchId)
      ),
      fetchEntitySportFirstSuccessful(
        buildEntitySportBoxScoreUrls(ENTITYSPORT_TOKEN, resolvedMatchId)
      ),
    ])
    const pbpResult = pbpFetch.selected
    const boxScoreResult = boxFetch.selected
    const collectionRef = db.collection(`games/${gameId}/entitySportShadow`)
    const fetchedAt = admin.firestore.FieldValue.serverTimestamp()
    const commonMeta = {
      source: 'entitysport',
      nbaGameId,
      entitySportMatchId: resolvedMatchId,
      anchorActionNumber,
      anchorPeriod,
      anchorClock,
      fetchedAt,
    }

    await Promise.all([
      collectionRef.doc(`pbp_${anchorActionNumber}`).set(
        {
          ...commonMeta,
          kind: 'play_by_play',
          ...pbpResult,
          attempts: pbpFetch.attempts,
          eventCount: extractEntitySportEventCount(pbpResult.payload),
        },
        { merge: true }
      ),
      collectionRef.doc(`boxscore_${anchorActionNumber}`).set(
        {
          ...commonMeta,
          kind: 'box_score',
          ...boxScoreResult,
          attempts: boxFetch.attempts,
        },
        { merge: true }
      ),
    ])

    if (pbpResult.error || boxScoreResult.error) {
      console.warn(
        `[entitysport] shadow fetch game=${gameId} nbaGameId=${nbaGameId} matchId=${resolvedMatchId} action=${anchorActionNumber} pbpError=${pbpResult.error ?? 'none'} boxError=${boxScoreResult.error ?? 'none'}`
      )
      return
    }
    console.log(
      `[entitysport] shadow fetch game=${gameId} nbaGameId=${nbaGameId} matchId=${resolvedMatchId} action=${anchorActionNumber} pbpMs=${pbpResult.durationMs} boxMs=${boxScoreResult.durationMs} pbpEvents=${extractEntitySportEventCount(pbpResult.payload) ?? -1}`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[entitysport] shadow fetch non_blocking_error game=${gameId} nbaGameId=${nbaGameId} matchId=${matchId} action=${anchorActionNumber} error=${message}`
    )
  }
}

const toNumber = (value: JsonValue | undefined | null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const parseNextData = (html: string): JsonValue | null => {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  )
  if (!match || typeof match[1] !== 'string') return null
  try {
    return JSON.parse(match[1]) as JsonValue
  } catch {
    return null
  }
}

const readJsonPath = (
  root: JsonValue,
  pathParts: string[]
): JsonValue | null => {
  let cursor: JsonValue | null = root
  for (const key of pathParts) {
    const obj = asObject(cursor)
    if (!obj) return null
    cursor = obj[key] ?? null
  }
  return cursor
}

const emptyOfficialStatLine = (): OfficialStatLine => ({
  points: 0,
  assists: 0,
  rebounds: 0,
  steals: 0,
  threes: 0,
  blocks: 0,
  freeThrowsMade: 0,
})

const addOfficialStatLine = (
  target: OfficialStatLine,
  source: OfficialStatLine
) => {
  target.points += source.points
  target.assists += source.assists
  target.rebounds += source.rebounds
  target.steals += source.steals
  target.threes += source.threes
  target.blocks += source.blocks
  target.freeThrowsMade += source.freeThrowsMade
}

const readStatNumber = (
  stats: { [key: string]: JsonValue } | null,
  key: string
): number => {
  if (!stats) return 0
  return toNumber(stats[key] ?? null) ?? 0
}

const extractOfficialPeriodStats = (
  nextData: JsonValue
): {
  teams: Record<string, OfficialStatLine>
  players: Record<string, OfficialStatLine>
} | null => {
  const gameObj = asObject(
    readJsonPath(nextData, ['props', 'pageProps', 'game'])
  )
  if (!gameObj) return null

  const teams: Record<string, OfficialStatLine> = {}
  const players: Record<string, OfficialStatLine> = {}
  const teamKeys: ('homeTeam' | 'awayTeam')[] = ['homeTeam', 'awayTeam']
  for (const teamKey of teamKeys) {
    const teamObj = asObject(gameObj[teamKey])
    if (!teamObj) continue
    const tricodeRaw = teamObj.teamTricode
    const tricode =
      typeof tricodeRaw === 'string' ? normalizeTeamCode(tricodeRaw) : null
    const teamStats = asObject(teamObj.statistics)
    const teamLine: OfficialStatLine = {
      points: readStatNumber(teamStats, 'points'),
      assists: readStatNumber(teamStats, 'assists'),
      rebounds: readStatNumber(teamStats, 'reboundsTotal'),
      steals: readStatNumber(teamStats, 'steals'),
      threes: readStatNumber(teamStats, 'threePointersMade'),
      blocks: readStatNumber(teamStats, 'blocks'),
      freeThrowsMade: readStatNumber(teamStats, 'freeThrowsMade'),
    }
    if (tricode) teams[tricode] = teamLine

    const playersRaw = asArray(teamObj.players) ?? []
    for (const playerRaw of playersRaw) {
      const playerObj = asObject(playerRaw)
      if (!playerObj) continue
      const playerId = toNumber(playerObj.personId)
      if (playerId === null) continue
      const playerStats = asObject(playerObj.statistics)
      players[String(playerId)] = {
        points: readStatNumber(playerStats, 'points'),
        assists: readStatNumber(playerStats, 'assists'),
        rebounds: readStatNumber(playerStats, 'reboundsTotal'),
        steals: readStatNumber(playerStats, 'steals'),
        threes: readStatNumber(playerStats, 'threePointersMade'),
        blocks: readStatNumber(playerStats, 'blocks'),
        freeThrowsMade: readStatNumber(playerStats, 'freeThrowsMade'),
      }
    }
  }
  return { teams, players }
}

const buildOfficialGamePageBaseUrl = (
  gameSlug: string | null,
  awayTeam: string | null,
  homeTeam: string | null,
  nbaGameId: string
) => {
  const slug =
    typeof gameSlug === 'string' && gameSlug.trim()
      ? gameSlug.trim()
      : buildGameSlug(
          normalizeTeamCode(awayTeam ?? ''),
          normalizeTeamCode(homeTeam ?? ''),
          nbaGameId
        )
  return `https://www.nba.com/game/${slug}/box-score`
}

const fetchOfficialCumulativeStatsThroughPeriod = async (
  baseUrl: string,
  throughPeriod: number
): Promise<OfficialCumulativeStatsSnapshot | null> => {
  if (!Number.isFinite(throughPeriod) || throughPeriod < 1) return null
  const periodMax = Math.min(throughPeriod, 10)
  const teams: Record<string, OfficialStatLine> = {}
  const players: Record<string, OfficialStatLine> = {}
  const sourceUrls: string[] = []

  for (let period = 1; period <= periodMax; period += 1) {
    const periodUrl = `${baseUrl}?period=Q${period}`
    sourceUrls.push(periodUrl)
    const html = await fetchHtml(periodUrl)
    const nextData = parseNextData(html)
    if (!nextData) {
      throw new Error(
        `official quarter page missing __NEXT_DATA__: ${periodUrl}`
      )
    }
    const periodStats = extractOfficialPeriodStats(nextData)
    if (!periodStats) {
      throw new Error(
        `official quarter page missing team/player stats: ${periodUrl}`
      )
    }
    for (const [tricode, line] of Object.entries(periodStats.teams)) {
      if (!teams[tricode]) teams[tricode] = emptyOfficialStatLine()
      addOfficialStatLine(teams[tricode], line)
    }
    for (const [playerId, line] of Object.entries(periodStats.players)) {
      if (!players[playerId]) players[playerId] = emptyOfficialStatLine()
      addOfficialStatLine(players[playerId], line)
    }
  }

  return {
    throughPeriod: periodMax,
    sourceUrls,
    teams,
    players,
  }
}

type OfficialCumulativeCacheEntry = {
  period: number
  fetchedAtMs: number
  snapshot: OfficialCumulativeStatsSnapshot | null
}

const OFFICIAL_CUMULATIVE_TTL_MS = Number(
  process.env.NBA_OFFICIAL_CUMULATIVE_TTL_MS ?? 15000
)
const OFFICIAL_CUMULATIVE_CACHE = new Map<
  string,
  OfficialCumulativeCacheEntry
>()

const getOfficialCumulativeForGamePeriod = async (
  gameId: string,
  baseUrl: string,
  period: number,
  forceRefresh: boolean
): Promise<OfficialCumulativeStatsSnapshot | null> => {
  if (!Number.isFinite(period) || period < 1) return null
  const cache = OFFICIAL_CUMULATIVE_CACHE.get(gameId)
  const now = Date.now()
  if (
    !forceRefresh &&
    cache &&
    cache.period === period &&
    now - cache.fetchedAtMs <= OFFICIAL_CUMULATIVE_TTL_MS
  ) {
    return cache.snapshot
  }
  const snapshot = await fetchOfficialCumulativeStatsThroughPeriod(
    baseUrl,
    period
  )
  OFFICIAL_CUMULATIVE_CACHE.set(gameId, {
    period,
    fetchedAtMs: now,
    snapshot,
  })
  return snapshot
}

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
      assistPlayerId:
        typeof action?.assistPersonId === 'number'
          ? action.assistPersonId
          : null,
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

type DerivedStatLine = {
  points: number
  assists: number
  rebounds: number
  steals: number
  threes: number
  blocks: number
  freeThrowsMade: number
}

const createEmptyDerivedStatLine = (): DerivedStatLine => ({
  points: 0,
  assists: 0,
  rebounds: 0,
  steals: 0,
  threes: 0,
  blocks: 0,
  freeThrowsMade: 0,
})

const normalizeDerivedSnapshot = (
  value: Record<string, unknown> | null | undefined
): DerivedStatsSnapshot => {
  const output: DerivedStatsSnapshot = { teams: {}, players: {} }
  if (!value) return output
  const readBucket = (bucketKey: 'teams' | 'players') => {
    const bucket = value[bucketKey]
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return
    for (const [id, lineRaw] of Object.entries(bucket)) {
      if (!lineRaw || typeof lineRaw !== 'object' || Array.isArray(lineRaw))
        continue
      const lineObj = lineRaw as Record<string, unknown>
      const line: DerivedStatLine = {
        points:
          typeof lineObj.points === 'number' && Number.isFinite(lineObj.points)
            ? lineObj.points
            : 0,
        assists:
          typeof lineObj.assists === 'number' &&
          Number.isFinite(lineObj.assists)
            ? lineObj.assists
            : 0,
        rebounds:
          typeof lineObj.rebounds === 'number' &&
          Number.isFinite(lineObj.rebounds)
            ? lineObj.rebounds
            : 0,
        steals:
          typeof lineObj.steals === 'number' && Number.isFinite(lineObj.steals)
            ? lineObj.steals
            : 0,
        threes:
          typeof lineObj.threes === 'number' && Number.isFinite(lineObj.threes)
            ? lineObj.threes
            : 0,
        blocks:
          typeof lineObj.blocks === 'number' && Number.isFinite(lineObj.blocks)
            ? lineObj.blocks
            : 0,
        freeThrowsMade:
          typeof lineObj.freeThrowsMade === 'number' &&
          Number.isFinite(lineObj.freeThrowsMade)
            ? lineObj.freeThrowsMade
            : typeof lineObj.ftm === 'number' && Number.isFinite(lineObj.ftm)
              ? lineObj.ftm
              : 0,
      }
      output[bucketKey][id] = line
    }
  }
  readBucket('teams')
  readBucket('players')
  return output
}

const getOrCreateTeamDerived = (
  derivedStats: DerivedStatsSnapshot,
  tricode: string | null
): DerivedStatLine | null => {
  if (!tricode) return null
  const key = tricode.trim().toUpperCase()
  if (!key) return null
  if (!derivedStats.teams[key]) {
    derivedStats.teams[key] = createEmptyDerivedStatLine()
  }
  return derivedStats.teams[key]
}

const getOrCreatePlayerDerived = (
  derivedStats: DerivedStatsSnapshot,
  playerId: number | null
): DerivedStatLine | null => {
  if (!playerId || !Number.isFinite(playerId)) return null
  const key = String(playerId)
  if (!derivedStats.players[key]) {
    derivedStats.players[key] = createEmptyDerivedStatLine()
  }
  return derivedStats.players[key]
}

const applyDerivedStatsForEvent = (
  derivedStats: DerivedStatsSnapshot,
  eventType: EventType,
  eventContext: NbaEventContext | null
) => {
  const teamCode =
    typeof eventContext?.teamTricode === 'string'
      ? eventContext.teamTricode.trim().toUpperCase()
      : null
  const primaryPlayerId =
    typeof eventContext?.primaryPlayerId === 'number'
      ? eventContext.primaryPlayerId
      : null
  const shot = eventContext?.shot
  const shotTeamCode =
    typeof shot?.teamTricode === 'string'
      ? shot.teamTricode.trim().toUpperCase()
      : teamCode
  const shotPlayerId =
    typeof shot?.shooterId === 'number' ? shot.shooterId : primaryPlayerId
  const assistPlayerId =
    typeof shot?.assistPlayerId === 'number' ? shot.assistPlayerId : null

  if (eventType === EventType.REBOUND) {
    const team = getOrCreateTeamDerived(derivedStats, teamCode)
    if (team) team.rebounds += 1
    const player = getOrCreatePlayerDerived(derivedStats, primaryPlayerId)
    if (player) player.rebounds += 1
    return
  }

  if (eventType === EventType.STEAL) {
    const team = getOrCreateTeamDerived(derivedStats, teamCode)
    if (team) team.steals += 1
    const player = getOrCreatePlayerDerived(derivedStats, primaryPlayerId)
    if (player) player.steals += 1
    return
  }

  if (eventType === EventType.BLOCK) {
    const team = getOrCreateTeamDerived(derivedStats, teamCode)
    if (team) team.blocks += 1
    const player = getOrCreatePlayerDerived(derivedStats, primaryPlayerId)
    if (player) player.blocks += 1
    return
  }

  if (eventType === EventType.MADE_3) {
    const team = getOrCreateTeamDerived(derivedStats, shotTeamCode)
    if (team) {
      team.points += 3
      team.threes += 1
    }
    const shooter = getOrCreatePlayerDerived(derivedStats, shotPlayerId)
    if (shooter) {
      shooter.points += 3
      shooter.threes += 1
    }
    const assister = getOrCreatePlayerDerived(derivedStats, assistPlayerId)
    if (assister) assister.assists += 1
    if (team && assister) team.assists += 1
    return
  }

  if (eventType === EventType.MADE_FG) {
    const team = getOrCreateTeamDerived(derivedStats, shotTeamCode)
    if (team) {
      team.points += 2
    }
    const shooter = getOrCreatePlayerDerived(derivedStats, shotPlayerId)
    if (shooter) {
      shooter.points += 2
    }
    const assister = getOrCreatePlayerDerived(derivedStats, assistPlayerId)
    if (assister) assister.assists += 1
    if (team && assister) team.assists += 1
    return
  }

  if (eventType === EventType.MADE_FT) {
    const team = getOrCreateTeamDerived(derivedStats, teamCode)
    if (team) {
      team.points += 1
      team.freeThrowsMade += 1
    }
    const shooter = getOrCreatePlayerDerived(derivedStats, primaryPlayerId)
    if (shooter) {
      shooter.points += 1
      shooter.freeThrowsMade += 1
    }
  }
}

const readBoxStat = (
  stats: { [key: string]: JsonValue } | null | undefined,
  keys: string[]
) => {
  if (!stats) return null
  for (const key of keys) {
    const raw = stats[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim().length) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

const reconcileDerivedWithBoxScore = (
  derivedStats: DerivedStatsSnapshot,
  boxScore: BoxScore | null
) => {
  if (!boxScore) return
  const teams = [boxScore.homeTeam, boxScore.awayTeam]
  for (const team of teams) {
    if (!team) continue
    const tricodeRaw = team.teamTricode
    const tricode =
      typeof tricodeRaw === 'string' ? tricodeRaw.trim().toUpperCase() : null
    if (!tricode) continue
    const line = getOrCreateTeamDerived(derivedStats, tricode)
    if (!line) continue
    const stats =
      team.statistics && typeof team.statistics === 'object'
        ? (team.statistics as { [key: string]: JsonValue })
        : null
    const teamScore =
      typeof team.score === 'number'
        ? team.score
        : typeof team.score === 'string'
          ? Number(team.score)
          : null
    const points =
      readBoxStat(stats, ['points']) ??
      (Number.isFinite(teamScore) ? Number(teamScore) : null)
    const assists = readBoxStat(stats, ['assists'])
    const rebounds = readBoxStat(stats, ['reboundsTotal', 'rebounds'])
    const steals = readBoxStat(stats, ['steals'])
    const threes = readBoxStat(stats, ['threePointersMade', 'fg3m'])
    const blocks = readBoxStat(stats, ['blocks'])
    const freeThrowsMade = readBoxStat(stats, ['freeThrowsMade', 'ftm'])
    if (points !== null) line.points = Math.max(line.points, points)
    if (assists !== null) line.assists = Math.max(line.assists, assists)
    if (rebounds !== null) line.rebounds = Math.max(line.rebounds, rebounds)
    if (steals !== null) line.steals = Math.max(line.steals, steals)
    if (threes !== null) line.threes = Math.max(line.threes, threes)
    if (blocks !== null) line.blocks = Math.max(line.blocks, blocks)
    if (freeThrowsMade !== null) {
      line.freeThrowsMade = Math.max(line.freeThrowsMade, freeThrowsMade)
    }

    const players = Array.isArray(team.players) ? team.players : []
    for (const player of players) {
      const playerId =
        typeof player?.personId === 'number'
          ? player.personId
          : typeof player?.playerId === 'number'
            ? player.playerId
            : null
      if (!playerId || !Number.isFinite(playerId)) continue
      const playerLine = getOrCreatePlayerDerived(derivedStats, playerId)
      if (!playerLine) continue
      const playerStats =
        player.statistics && typeof player.statistics === 'object'
          ? (player.statistics as { [key: string]: JsonValue })
          : null
      const pPoints = readBoxStat(playerStats, ['points'])
      const pAssists = readBoxStat(playerStats, ['assists'])
      const pRebounds = readBoxStat(playerStats, ['reboundsTotal', 'rebounds'])
      const pSteals = readBoxStat(playerStats, ['steals'])
      const pThrees = readBoxStat(playerStats, ['threePointersMade', 'fg3m'])
      const pBlocks = readBoxStat(playerStats, ['blocks'])
      const pFtm = readBoxStat(playerStats, ['freeThrowsMade', 'ftm'])
      if (pPoints !== null)
        playerLine.points = Math.max(playerLine.points, pPoints)
      if (pAssists !== null)
        playerLine.assists = Math.max(playerLine.assists, pAssists)
      if (pRebounds !== null)
        playerLine.rebounds = Math.max(playerLine.rebounds, pRebounds)
      if (pSteals !== null)
        playerLine.steals = Math.max(playerLine.steals, pSteals)
      if (pThrees !== null)
        playerLine.threes = Math.max(playerLine.threes, pThrees)
      if (pBlocks !== null)
        playerLine.blocks = Math.max(playerLine.blocks, pBlocks)
      if (pFtm !== null) {
        playerLine.freeThrowsMade = Math.max(playerLine.freeThrowsMade, pFtm)
      }
    }
  }
}

const cloneDerivedStatsSnapshot = (
  derivedStats: DerivedStatsSnapshot
): DerivedStatsSnapshot => {
  const copyBucket = (
    bucket: Record<
      string,
      {
        points: number
        assists: number
        rebounds: number
        steals: number
        threes: number
        blocks: number
        freeThrowsMade: number
      }
    >
  ) => {
    const output: Record<
      string,
      {
        points: number
        assists: number
        rebounds: number
        steals: number
        threes: number
        blocks: number
        freeThrowsMade: number
      }
    > = {}
    for (const [key, value] of Object.entries(bucket)) {
      output[key] = {
        points: value.points,
        assists: value.assists,
        rebounds: value.rebounds,
        steals: value.steals,
        threes: value.threes,
        blocks: value.blocks,
        freeThrowsMade: value.freeThrowsMade,
      }
    }
    return output
  }
  return {
    teams: copyBucket(derivedStats.teams),
    players: copyBucket(derivedStats.players),
  }
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

const persistBoxScoreSnapshot = async (
  gameId: string,
  actionNumber: number,
  boxScore: BoxScore | null
) => {
  if (
    !PERSIST_BOX_SCORE_SNAPSHOTS ||
    !boxScore ||
    !Number.isFinite(actionNumber) ||
    actionNumber <= 0
  )
    return

  const scoreHome =
    typeof boxScore.homeTeam?.score === 'number'
      ? boxScore.homeTeam.score
      : null
  const scoreAway =
    typeof boxScore.awayTeam?.score === 'number'
      ? boxScore.awayTeam.score
      : null

  await db
    .collection('games')
    .doc(gameId)
    .collection('boxScoreSnapshots')
    .doc(String(actionNumber))
    .set(
      {
        actionNumber,
        period: boxScore.period ?? boxScore.game?.period ?? null,
        clockMs: parseClockToMs(boxScore.gameClock ?? boxScore.game?.gameClock),
        scoreHome,
        scoreAway,
        boxScore,
        capturedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
}

const PERIOD_COMPARE_TYPES = new Set<string>([
  'TEAM_STAT_THIS_PERIOD',
  'TEAM_COMPARE_PERIOD',
  'TEAM_POINTS_THIS_PERIOD',
  'PLAYER_MILESTONE_PERIOD',
  'PLAYER_COMPARE_PERIOD',
  'TEAM_POINTS_NEXT_N',
  'TOTAL_POINTS_NEXT_N',
  'MADE_3_COUNT_NEXT_N',
  'PLAYER_COMPARE_NEXT_N',
])

const toFiniteNumber = (value: number | string | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const getOfficialTeamStat = (
  snapshot: OfficialCumulativeStatsSnapshot | null,
  tricode: string | null,
  statType: string
) => {
  if (!snapshot || !tricode) return null
  const line = snapshot.teams[String(tricode).toUpperCase()]
  if (!line) return null
  const stat = statType.toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getOfficialPlayerStat = (
  snapshot: OfficialCumulativeStatsSnapshot | null,
  playerId: number | null,
  statType: string
) => {
  if (!snapshot || !playerId) return null
  const line = snapshot.players[String(playerId)]
  if (!line) return null
  const stat = statType.toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getDerivedTeamStat = (
  derived: DerivedStatsSnapshot | undefined,
  tricode: string | null,
  statType: string
) => {
  if (!derived || !tricode) return null
  const line = derived.teams[String(tricode).toUpperCase()]
  if (!line) return null
  const stat = statType.toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getDerivedPlayerStat = (
  derived: DerivedStatsSnapshot | undefined,
  playerId: number | null,
  statType: string
) => {
  if (!derived || !playerId) return null
  const line = derived.players[String(playerId)]
  if (!line) return null
  const stat = statType.toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getBoxScoreTeamByTricode = (
  boxScore: BoxScore | null,
  tricode: string | null
) => {
  if (!boxScore || !tricode) return null
  const normalized = String(tricode).toUpperCase()
  const homeCode = String(boxScore.homeTeam?.teamTricode || '').toUpperCase()
  const awayCode = String(boxScore.awayTeam?.teamTricode || '').toUpperCase()
  if (homeCode === normalized) return boxScore.homeTeam ?? null
  if (awayCode === normalized) return boxScore.awayTeam ?? null
  return null
}

const getBoxScorePlayerById = (boxScore: BoxScore | null, playerId: number) => {
  if (!boxScore) return null
  const homePlayers = Array.isArray(boxScore.homeTeam?.players)
    ? boxScore.homeTeam.players
    : []
  const awayPlayers = Array.isArray(boxScore.awayTeam?.players)
    ? boxScore.awayTeam.players
    : []
  const all = [...homePlayers, ...awayPlayers]
  const found = all.find((player) => {
    const id = toFiniteNumber(
      typeof player?.personId === 'number'
        ? player.personId
        : typeof player?.playerId === 'number'
          ? player.playerId
          : null
    )
    return id === playerId
  })
  return found ?? null
}

const getBoxScoreTeamStat = (
  boxScore: BoxScore | null,
  tricode: string | null,
  statType: string
) => {
  const team = getBoxScoreTeamByTricode(boxScore, tricode)
  if (!team) return null
  const stats = team.statistics
  const stat = statType.toUpperCase()
  if (stat === 'POINTS')
    return toFiniteNumber(team.score ?? stats?.points ?? null)
  if (stat === 'ASSISTS') return toFiniteNumber(stats?.assists ?? null)
  if (stat === 'REBOUNDS')
    return toFiniteNumber(stats?.reboundsTotal ?? stats?.rebounds ?? null)
  if (stat === 'STEALS') return toFiniteNumber(stats?.steals ?? null)
  if (stat === 'THREES' || stat === 'FG3M')
    return toFiniteNumber(stats?.threePointersMade ?? stats?.fg3m ?? null)
  if (stat === 'BLOCKS') return toFiniteNumber(stats?.blocks ?? null)
  if (stat === 'FTM') return null
  return null
}

const getBoxScorePlayerStat = (
  boxScore: BoxScore | null,
  playerId: number | null,
  statType: string
) => {
  if (!playerId) return null
  const player = getBoxScorePlayerById(boxScore, playerId)
  if (!player) return null
  const stats = player.statistics
  const stat = statType.toUpperCase()
  if (stat === 'POINTS') return toFiniteNumber(stats?.points ?? null)
  if (stat === 'ASSISTS') return toFiniteNumber(stats?.assists ?? null)
  if (stat === 'REBOUNDS')
    return toFiniteNumber(stats?.reboundsTotal ?? stats?.rebounds ?? null)
  if (stat === 'STEALS') return toFiniteNumber(stats?.steals ?? null)
  if (stat === 'THREES' || stat === 'FG3M')
    return toFiniteNumber(stats?.threePointersMade ?? stats?.fg3m ?? null)
  if (stat === 'BLOCKS') return toFiniteNumber(stats?.blocks ?? null)
  if (stat === 'FTM')
    return toFiniteNumber(stats?.freeThrowsMade ?? stats?.ftm ?? null)
  return null
}

const toNumberRecord = (value: object | null | undefined) => {
  if (!value) return null
  const output: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const next = toFiniteNumber(
      typeof raw === 'number' || typeof raw === 'string' ? raw : null
    )
    if (next !== null) output[key] = next
  }
  return Object.keys(output).length ? output : null
}

const getPlayerIdsFromContext = (
  value: object | string | number | boolean | null | undefined
) => {
  if (!Array.isArray(value)) return [] as number[]
  const playerIds: number[] = []
  for (const item of value) {
    const parsed = toFiniteNumber(
      typeof item === 'number' || typeof item === 'string' ? item : null
    )
    if (parsed !== null) playerIds.push(parsed)
  }
  return playerIds
}

const logOfficialCompare = (params: {
  phase: 'creation' | 'resolution'
  gameId: string
  questionId?: string
  templateId?: string | null
  questionContext: object | null | undefined
  event: EngineEvent
  boxScore: BoxScore | null
  derivedStats?: DerivedStatsSnapshot
  decisionState?: string
  decisionAnswer?: string | null
}) => {
  if (!LOG_OFFICIAL_COMPARE) return
  const context = (params.questionContext ?? {}) as Record<
    string,
    object | string | number | boolean | null
  >
  const typeValue = context.type
  const type = typeof typeValue === 'string' ? typeValue : ''
  if (!PERIOD_COMPARE_TYPES.has(type)) return
  const statTypeValue = context.statType
  const statType =
    typeof statTypeValue === 'string' && statTypeValue.trim().length
      ? statTypeValue
      : 'POINTS'
  const official = params.event.context?.officialCumulativeStats ?? null
  const compare: Record<
    string,
    string | number | null | Record<string, number> | boolean
  > = {
    eventId: params.event.eventId,
    period: params.event.gameState?.period ?? null,
    clockMs: params.event.gameState?.clockMs ?? null,
    type,
    statType,
    hasOfficial: Boolean(official),
  }

  if (type === 'TEAM_STAT_THIS_PERIOD' || type === 'TEAM_POINTS_THIS_PERIOD') {
    const teamTricode =
      typeof context.teamTricode === 'string' ? context.teamTricode : null
    compare.teamTricode = teamTricode
    compare.start = toFiniteNumber(
      typeof context.startTeamStat === 'number' ||
        typeof context.startTeamStat === 'string'
        ? context.startTeamStat
        : null
    )
    compare.minTarget = toFiniteNumber(
      typeof context.minTeamStat === 'number' ||
        typeof context.minTeamStat === 'string'
        ? context.minTeamStat
        : null
    )
    compare.official = getOfficialTeamStat(official, teamTricode, statType)
    compare.derived = getDerivedTeamStat(
      params.derivedStats,
      teamTricode,
      statType
    )
    compare.boxScore = getBoxScoreTeamStat(
      params.boxScore,
      teamTricode,
      statType
    )
  } else if (type === 'TEAM_COMPARE_PERIOD') {
    const home =
      typeof context.homeTricode === 'string' ? context.homeTricode : null
    const away =
      typeof context.awayTricode === 'string' ? context.awayTricode : null
    compare.homeTricode = home
    compare.awayTricode = away
    compare.startHome = toFiniteNumber(
      typeof context.minHomeStat === 'number' ||
        typeof context.minHomeStat === 'string'
        ? context.minHomeStat
        : null
    )
    compare.startAway = toFiniteNumber(
      typeof context.minAwayStat === 'number' ||
        typeof context.minAwayStat === 'string'
        ? context.minAwayStat
        : null
    )
    compare.officialHome = getOfficialTeamStat(official, home, statType)
    compare.officialAway = getOfficialTeamStat(official, away, statType)
    compare.derivedHome = getDerivedTeamStat(
      params.derivedStats,
      home,
      statType
    )
    compare.derivedAway = getDerivedTeamStat(
      params.derivedStats,
      away,
      statType
    )
    compare.boxHome = getBoxScoreTeamStat(params.boxScore, home, statType)
    compare.boxAway = getBoxScoreTeamStat(params.boxScore, away, statType)
  } else if (type === 'PLAYER_MILESTONE_PERIOD') {
    const playerId = toFiniteNumber(
      typeof context.playerId === 'number' ||
        typeof context.playerId === 'string'
        ? context.playerId
        : null
    )
    compare.playerId = playerId
    compare.start = toFiniteNumber(
      typeof context.startGameStat === 'number' ||
        typeof context.startGameStat === 'string'
        ? context.startGameStat
        : null
    )
    compare.target = toFiniteNumber(
      typeof context.target === 'number' || typeof context.target === 'string'
        ? context.target
        : null
    )
    compare.official = getOfficialPlayerStat(official, playerId, statType)
    compare.derived = getDerivedPlayerStat(
      params.derivedStats,
      playerId,
      statType
    )
    compare.boxScore = getBoxScorePlayerStat(
      params.boxScore,
      playerId,
      statType
    )
  } else if (type === 'PLAYER_COMPARE_PERIOD') {
    const startMapRaw =
      typeof context.startPlayerGameStats === 'object' &&
      context.startPlayerGameStats &&
      !Array.isArray(context.startPlayerGameStats)
        ? context.startPlayerGameStats
        : null
    compare.startMap = toNumberRecord(startMapRaw as object | null)
    const playerIds = getPlayerIdsFromContext(context.playerIds)
    if (playerIds.length) {
      const officialMap: Record<string, number> = {}
      const derivedMap: Record<string, number> = {}
      const boxMap: Record<string, number> = {}
      for (const playerId of playerIds) {
        const officialValue = getOfficialPlayerStat(
          official,
          playerId,
          statType
        )
        const derivedValue = getDerivedPlayerStat(
          params.derivedStats,
          playerId,
          statType
        )
        const boxValue = getBoxScorePlayerStat(
          params.boxScore,
          playerId,
          statType
        )
        if (officialValue !== null)
          officialMap[String(playerId)] = officialValue
        if (derivedValue !== null) derivedMap[String(playerId)] = derivedValue
        if (boxValue !== null) boxMap[String(playerId)] = boxValue
      }
      compare.officialMap = Object.keys(officialMap).length ? officialMap : null
      compare.derivedMap = Object.keys(derivedMap).length ? derivedMap : null
      compare.boxMap = Object.keys(boxMap).length ? boxMap : null
    }
  } else if (type === 'PLAYER_COMPARE_NEXT_N') {
    const playerIds = getPlayerIdsFromContext(context.playerIds)
    const startMapRaw =
      typeof context.startPlayerStats === 'object' &&
      context.startPlayerStats &&
      !Array.isArray(context.startPlayerStats)
        ? context.startPlayerStats
        : null
    compare.startMap = toNumberRecord(startMapRaw as object | null)
    if (playerIds.length) {
      const officialMap: Record<string, number> = {}
      const derivedMap: Record<string, number> = {}
      const boxMap: Record<string, number> = {}
      for (const playerId of playerIds) {
        const officialValue = getOfficialPlayerStat(
          official,
          playerId,
          statType
        )
        const derivedValue = getDerivedPlayerStat(
          params.derivedStats,
          playerId,
          statType
        )
        const boxValue = getBoxScorePlayerStat(
          params.boxScore,
          playerId,
          statType
        )
        if (officialValue !== null)
          officialMap[String(playerId)] = officialValue
        if (derivedValue !== null) derivedMap[String(playerId)] = derivedValue
        if (boxValue !== null) boxMap[String(playerId)] = boxValue
      }
      compare.officialMap = Object.keys(officialMap).length ? officialMap : null
      compare.derivedMap = Object.keys(derivedMap).length ? derivedMap : null
      compare.boxMap = Object.keys(boxMap).length ? boxMap : null
    }
  } else if (type === 'TEAM_POINTS_NEXT_N') {
    const teamTricode =
      typeof context.teamTricode === 'string' ? context.teamTricode : null
    const homeScore = toFiniteNumber(params.event.gameState?.scoreHome)
    const awayScore = toFiniteNumber(params.event.gameState?.scoreAway)
    const teamFromScore =
      teamTricode &&
      params.boxScore &&
      String(params.boxScore.homeTeam?.teamTricode || '').toUpperCase() ===
        String(teamTricode).toUpperCase()
        ? homeScore
        : teamTricode &&
            params.boxScore &&
            String(
              params.boxScore.awayTeam?.teamTricode || ''
            ).toUpperCase() === String(teamTricode).toUpperCase()
          ? awayScore
          : null
    compare.teamTricode = teamTricode
    compare.start = toFiniteNumber(
      typeof context.initialValue === 'number' ||
        typeof context.initialValue === 'string'
        ? context.initialValue
        : null
    )
    compare.minTarget = toFiniteNumber(
      typeof context.minTeamScore === 'number' ||
        typeof context.minTeamScore === 'string'
        ? context.minTeamScore
        : null
    )
    compare.official = getOfficialTeamStat(official, teamTricode, 'POINTS')
    compare.derived = getDerivedTeamStat(
      params.derivedStats,
      teamTricode,
      'POINTS'
    )
    compare.boxScore = teamFromScore
  } else if (type === 'TOTAL_POINTS_NEXT_N') {
    const homeCode =
      params.boxScore &&
      typeof params.boxScore.homeTeam?.teamTricode === 'string'
        ? params.boxScore.homeTeam.teamTricode
        : null
    const awayCode =
      params.boxScore &&
      typeof params.boxScore.awayTeam?.teamTricode === 'string'
        ? params.boxScore.awayTeam.teamTricode
        : null
    const scoreHome = toFiniteNumber(params.event.gameState?.scoreHome)
    const scoreAway = toFiniteNumber(params.event.gameState?.scoreAway)
    compare.start = toFiniteNumber(
      typeof context.startTotal === 'number' ||
        typeof context.startTotal === 'string'
        ? context.startTotal
        : null
    )
    compare.minTarget = toFiniteNumber(
      typeof context.minTotalScore === 'number' ||
        typeof context.minTotalScore === 'string'
        ? context.minTotalScore
        : null
    )
    compare.boxScore =
      scoreHome !== null && scoreAway !== null ? scoreHome + scoreAway : null
    const derivedHome = getDerivedTeamStat(
      params.derivedStats,
      homeCode,
      'POINTS'
    )
    const derivedAway = getDerivedTeamStat(
      params.derivedStats,
      awayCode,
      'POINTS'
    )
    compare.derived =
      derivedHome !== null && derivedAway !== null
        ? derivedHome + derivedAway
        : null
    const officialHome = getOfficialTeamStat(official, homeCode, 'POINTS')
    const officialAway = getOfficialTeamStat(official, awayCode, 'POINTS')
    compare.official =
      officialHome !== null && officialAway !== null
        ? officialHome + officialAway
        : null
  } else if (type === 'MADE_3_COUNT_NEXT_N') {
    const homeCode =
      typeof context.homeTricode === 'string' ? context.homeTricode : null
    const awayCode =
      typeof context.awayTricode === 'string' ? context.awayTricode : null
    compare.startHome = toFiniteNumber(
      typeof context.startHomeThrees === 'number' ||
        typeof context.startHomeThrees === 'string'
        ? context.startHomeThrees
        : null
    )
    compare.startAway = toFiniteNumber(
      typeof context.startAwayThrees === 'number' ||
        typeof context.startAwayThrees === 'string'
        ? context.startAwayThrees
        : null
    )
    compare.minTarget = toFiniteNumber(
      typeof context.minMade3Count === 'number' ||
        typeof context.minMade3Count === 'string'
        ? context.minMade3Count
        : null
    )
    const officialHome = getOfficialTeamStat(official, homeCode, 'THREES')
    const officialAway = getOfficialTeamStat(official, awayCode, 'THREES')
    const derivedHome = getDerivedTeamStat(
      params.derivedStats,
      homeCode,
      'THREES'
    )
    const derivedAway = getDerivedTeamStat(
      params.derivedStats,
      awayCode,
      'THREES'
    )
    const boxHome = getBoxScoreTeamStat(params.boxScore, homeCode, 'THREES')
    const boxAway = getBoxScoreTeamStat(params.boxScore, awayCode, 'THREES')
    compare.officialHome = officialHome
    compare.officialAway = officialAway
    compare.derivedHome = derivedHome
    compare.derivedAway = derivedAway
    compare.boxHome = boxHome
    compare.boxAway = boxAway
  }

  const questionId = params.questionId ? ` question=${params.questionId}` : ''
  const template = params.templateId ? ` template=${params.templateId}` : ''
  const state = params.decisionState ? ` state=${params.decisionState}` : ''
  const answer = params.decisionAnswer ? ` answer=${params.decisionAnswer}` : ''
  console.log(
    `[nba_diag] official_compare phase=${params.phase} game=${params.gameId}${questionId}${template}${state}${answer} payload=${JSON.stringify(compare)}`
  )
}

const getResolutionSource = (params: {
  question: ResolvableQuestionDoc
  event: EngineEvent
  boxScore: BoxScore | null
  derivedStats?: DerivedStatsSnapshot
}): 'event' | 'derived' | 'boxscore' | 'official' | 'unknown' => {
  const context = params.question.resolutionContext
  const type = typeof context?.type === 'string' ? context.type : ''
  if (!type) return 'unknown'

  if (
    type === 'TOTAL_POINTS_NEXT_N' ||
    type === 'TEAM_POINTS_NEXT_N' ||
    type === 'TEAM_POINTS_REST_PERIOD' ||
    type === 'TEAM_POINTS_THIS_PERIOD' ||
    type === 'BOTH_TEAMS_10_REST_PERIOD' ||
    type === 'LEADER_END_OF_PERIOD'
  ) {
    return 'event'
  }

  const statType =
    typeof context?.statType === 'string' ? context.statType : 'POINTS'
  if (type === 'TEAM_STAT_THIS_PERIOD' || type === 'TEAM_COMPARE_PERIOD') {
    const homeTricode =
      typeof context?.homeTricode === 'string' ? context.homeTricode : null
    const awayTricode =
      typeof context?.awayTricode === 'string' ? context.awayTricode : null
    const teamTricode =
      typeof context?.teamTricode === 'string' ? context.teamTricode : null

    const hasOfficial =
      USE_OFFICIAL_CUMULATIVE_RESOLUTION &&
      (type === 'TEAM_COMPARE_PERIOD'
        ? getOfficialTeamStat(
            params.event.context?.officialCumulativeStats ?? null,
            homeTricode,
            statType
          ) !== null &&
          getOfficialTeamStat(
            params.event.context?.officialCumulativeStats ?? null,
            awayTricode,
            statType
          ) !== null
        : getOfficialTeamStat(
            params.event.context?.officialCumulativeStats ?? null,
            teamTricode,
            statType
          ) !== null)
    if (hasOfficial) return 'official'

    const hasDerived =
      type === 'TEAM_COMPARE_PERIOD'
        ? getDerivedTeamStat(params.derivedStats, homeTricode, statType) !==
            null &&
          getDerivedTeamStat(params.derivedStats, awayTricode, statType) !==
            null
        : getDerivedTeamStat(params.derivedStats, teamTricode, statType) !==
          null
    if (hasDerived) return 'derived'

    const hasBoxScore =
      type === 'TEAM_COMPARE_PERIOD'
        ? getBoxScoreTeamStat(params.boxScore, homeTricode, statType) !==
            null &&
          getBoxScoreTeamStat(params.boxScore, awayTricode, statType) !== null
        : getBoxScoreTeamStat(params.boxScore, teamTricode, statType) !== null
    return hasBoxScore ? 'boxscore' : 'unknown'
  }

  if (
    type === 'PLAYER_MILESTONE_PERIOD' ||
    type === 'PLAYER_COMPARE_PERIOD' ||
    type === 'PLAYER_COMPARE_NEXT_N'
  ) {
    const playerId =
      typeof context?.playerId === 'number' && Number.isFinite(context.playerId)
        ? context.playerId
        : null
    const playerIds = getPlayerIdsFromContext(context?.playerIds)

    const hasOfficial =
      USE_OFFICIAL_CUMULATIVE_RESOLUTION &&
      (playerId !== null
        ? getOfficialPlayerStat(
            params.event.context?.officialCumulativeStats ?? null,
            playerId,
            statType
          ) !== null
        : playerIds.length > 0 &&
          playerIds.every(
            (id) =>
              getOfficialPlayerStat(
                params.event.context?.officialCumulativeStats ?? null,
                id,
                statType
              ) !== null
          ))
    if (hasOfficial) return 'official'

    const hasDerived =
      playerId !== null
        ? getDerivedPlayerStat(params.derivedStats, playerId, statType) !== null
        : playerIds.length > 0 &&
          playerIds.every(
            (id) =>
              getDerivedPlayerStat(params.derivedStats, id, statType) !== null
          )
    if (hasDerived) return 'derived'

    const hasBoxScore =
      playerId !== null
        ? getBoxScorePlayerStat(params.boxScore, playerId, statType) !== null
        : playerIds.length > 0 &&
          playerIds.every(
            (id) =>
              getBoxScorePlayerStat(params.boxScore, id, statType) !== null
          )
    return hasBoxScore ? 'boxscore' : 'unknown'
  }

  if (type === 'MADE_3_COUNT_NEXT_N') {
    const homeTricode =
      typeof context?.homeTricode === 'string' ? context.homeTricode : null
    const awayTricode =
      typeof context?.awayTricode === 'string' ? context.awayTricode : null
    const hasOfficial =
      USE_OFFICIAL_CUMULATIVE_RESOLUTION &&
      getOfficialTeamStat(
        params.event.context?.officialCumulativeStats ?? null,
        homeTricode,
        'THREES'
      ) !== null &&
      getOfficialTeamStat(
        params.event.context?.officialCumulativeStats ?? null,
        awayTricode,
        'THREES'
      ) !== null
    if (hasOfficial) return 'official'
    const hasDerived =
      getDerivedTeamStat(params.derivedStats, homeTricode, 'THREES') !== null &&
      getDerivedTeamStat(params.derivedStats, awayTricode, 'THREES') !== null
    if (hasDerived) return 'derived'
    const hasBoxScore =
      getBoxScoreTeamStat(params.boxScore, homeTricode, 'THREES') !== null &&
      getBoxScoreTeamStat(params.boxScore, awayTricode, 'THREES') !== null
    return hasBoxScore ? 'boxscore' : 'unknown'
  }

  return 'event'
}

const resolveOpenQuestionsForEvent = async (
  gameId: string,
  event: EngineEvent,
  boxScore: BoxScore | null,
  windowTypes: string[],
  derivedStats?: DerivedStatsSnapshot
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
  for (const doc of docs) {
    const data = doc.data() as ResolvableQuestionDoc
    const decision = resolveQuestionForEvent(
      data,
      event,
      boxScore,
      derivedStats
    )
    if (!decision) continue
    const resolutionSource = getResolutionSource({
      question: data,
      event,
      boxScore,
      derivedStats,
    })
    const resolutionContext = buildFinalResolutionContext(data, event, boxScore)
    logOfficialCompare({
      phase: 'resolution',
      gameId,
      questionId: doc.id,
      templateId: typeof data?.templateId === 'string' ? data.templateId : null,
      questionContext:
        data?.resolutionContext && typeof data.resolutionContext === 'object'
          ? (data.resolutionContext as object)
          : null,
      event,
      boxScore,
      derivedStats,
      decisionState: decision.state,
      decisionAnswer: decision.answer,
    })

    if (decision.state === 'resolved') {
      await doc.ref.set(
        {
          state: 'resolved',
          answer: decision.answer ?? null,
          resolutionContext,
          resolvedEventId: event.eventId,
          resolutionSource,
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await calculateScores(gameId, doc.id)
    } else {
      await doc.ref.set(
        {
          state: 'cancelled',
          cancelReason: decision.reason || 'VOID',
          resolutionContext,
          resolvedEventId: event.eventId,
          resolutionSource,
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
    const isTie = normalizedAnswer === 'tie' || decision.reason === 'TIE'
    const resolutionType: 'normal' | 'void' =
      decision.state === 'resolved' && !isTie ? 'normal' : 'void'
    const voidReason =
      resolutionType === 'void'
        ? isTie
          ? 'tie'
          : decision.reason === 'NO_ATTEMPT'
            ? 'no_attempt'
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
      `[nba] question resolved game=${gameId} question=${doc.id} state=${decision.state} answer=${decision.answer ?? 'null'} event=${event.eventId} type=${event.type} template=${String(data.engineTag || '')}`
    )
    resolvedCount += 1
  }

  return resolvedCount
}

const resolveQuestionsAtGameEnd = async (
  gameId: string,
  lastActionNumber: number,
  boxScore: BoxScore | null,
  derivedStats?: DerivedStatsSnapshot
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
    ['NEXT_EVENT', 'NEXT_N_MIN', 'PERIOD', 'GAME'],
    derivedStats
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
  writes: FirestoreWrite[],
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

const OPEN_NBA_GAMES_CACHE = new Map<string, CachedOpenNbaGame>()
let openNbaGamesCacheReady = false
let openNbaGamesLastRefreshMs = 0
let openNbaGamesRefreshPromise: Promise<void> | null = null
let openNbaGamesWatchStarted = false
let openNbaGamesWatchInitialLoad: Promise<void> | null = null
let openNbaGamesWatchUnsubscribe: (() => void) | null = null
let openNbaGamesLastWatchErrorMs = 0

const buildOpenNbaGamesQuery = () =>
  db
    .collection('games')
    .where('state', '==', 'open')
    .where('league', '==', 'NBA')

const replaceOpenNbaGamesCache = (
  docs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]
) => {
  OPEN_NBA_GAMES_CACHE.clear()
  for (const doc of docs) {
    OPEN_NBA_GAMES_CACHE.set(doc.id, {
      id: doc.id,
      ref: doc.ref,
      data: doc.data(),
    })
  }
  openNbaGamesCacheReady = true
  openNbaGamesLastRefreshMs = Date.now()
}

const mergeOpenNbaGameCacheData = (
  gameId: string,
  data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
) => {
  const cached = OPEN_NBA_GAMES_CACHE.get(gameId)
  if (!cached) return
  cached.data = {
    ...cached.data,
    ...data,
  }
}

const removeOpenNbaGameFromCache = (gameId: string) => {
  OPEN_NBA_GAMES_CACHE.delete(gameId)
}

const refreshOpenNbaGamesCache = async (reason: string): Promise<void> => {
  if (openNbaGamesRefreshPromise) return openNbaGamesRefreshPromise

  openNbaGamesRefreshPromise = (async () => {
    const snap = await buildOpenNbaGamesQuery().get()
    replaceOpenNbaGamesCache(snap.docs)
    console.log(
      `[nba] open_games_cache refresh reason=${reason} games=${snap.size}`
    )
  })().finally(() => {
    openNbaGamesRefreshPromise = null
  })

  return openNbaGamesRefreshPromise
}

const startOpenNbaGamesWatch = (): Promise<void> => {
  if (openNbaGamesWatchStarted && openNbaGamesWatchInitialLoad) {
    return openNbaGamesWatchInitialLoad
  }

  const nowMs = Date.now()
  if (
    openNbaGamesLastWatchErrorMs > 0 &&
    nowMs - openNbaGamesLastWatchErrorMs < NBA_OPEN_GAMES_WATCH_RESTART_MS
  ) {
    return Promise.resolve()
  }

  openNbaGamesWatchStarted = true
  let initialLoadResolved = false
  if (openNbaGamesWatchUnsubscribe) {
    openNbaGamesWatchUnsubscribe()
    openNbaGamesWatchUnsubscribe = null
  }
  openNbaGamesWatchInitialLoad = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (initialLoadResolved) return
      initialLoadResolved = true
      console.warn(
        `[nba] open_games_cache watch_initial_timeout timeoutMs=${NBA_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS}`
      )
      resolve()
    }, NBA_OPEN_GAMES_WATCH_INITIAL_TIMEOUT_MS)

    openNbaGamesWatchUnsubscribe = buildOpenNbaGamesQuery().onSnapshot(
      (snapshot) => {
        replaceOpenNbaGamesCache(snapshot.docs)
        if (!initialLoadResolved) {
          initialLoadResolved = true
          clearTimeout(timeout)
          resolve()
        }
        if (snapshot.docChanges().length > 0) {
          console.log(
            `[nba] open_games_cache watch games=${snapshot.size} changes=${snapshot.docChanges().length}`
          )
        }
      },
      (error: Error) => {
        console.error('[nba] open_games_cache watch_error', error)
        openNbaGamesLastWatchErrorMs = Date.now()
        openNbaGamesWatchStarted = false
        openNbaGamesWatchUnsubscribe = null
        if (!initialLoadResolved) {
          initialLoadResolved = true
          clearTimeout(timeout)
          resolve()
        }
      }
    )
  })

  return openNbaGamesWatchInitialLoad
}

const getOpenNbaGamesForLiveSync = async (): Promise<CachedOpenNbaGame[]> => {
  await startOpenNbaGamesWatch()

  const nowMs = Date.now()
  const shouldRefresh =
    !openNbaGamesCacheReady ||
    nowMs - openNbaGamesLastRefreshMs >= NBA_OPEN_GAMES_REFRESH_MS

  if (shouldRefresh) {
    await refreshOpenNbaGamesCache(openNbaGamesCacheReady ? 'ttl' : 'initial')
  }

  return Array.from(OPEN_NBA_GAMES_CACHE.values()).map((game) => ({
    ...game,
    data: { ...game.data },
  }))
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
  const openGames = await getOpenNbaGamesForLiveSync()

  if (!openGames.length) {
    return {
      openGames: 0,
      updatedGames: 0,
      actionsProcessed: 0,
      commitRetries: 0,
    } satisfies NbaLiveSyncStats
  }

  const processGame = async (cachedGame: CachedOpenNbaGame) => {
    let updated = 0
    let actionsProcessed = 0
    let commitRetries = 0
    const gameId = cachedGame.id
    const gameRef = cachedGame.ref
    const game = cachedGame.data
    const nbaGameId = String(game?.nbaGameId || '')
    if (!nbaGameId) {
      console.log(
        `[nba] live sync skip game=${gameId} missing nbaGameId homeTeam=${String(
          game?.homeTeam || ''
        )} awayTeam=${String(game?.awayTeam || '')}`
      )
      return { updated, actionsProcessed, commitRetries }
    }

    const lastActionNumber =
      typeof game?.lastNbaActionNumber === 'number'
        ? game.lastNbaActionNumber
        : 0
    const derivedStats =
      lastActionNumber > 0
        ? normalizeDerivedSnapshot(
            game?.nbaDerivedStats &&
              typeof game.nbaDerivedStats === 'object' &&
              !Array.isArray(game.nbaDerivedStats)
              ? (game.nbaDerivedStats as Record<string, unknown>)
              : null
          )
        : ({ teams: {}, players: {} } as DerivedStatsSnapshot)
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
      payload = await fetchPlayByPlay(nbaGameId)
    } catch (err) {
      const message = String(err)
      if (message.includes('NBA not modified')) {
        return { updated, actionsProcessed, commitRetries }
      }
      if (message.includes('NBA request failed 403') && !lastActionNumber) {
        console.log(
          `[nba] live sync skip game=${gameId} nbaGameId=${nbaGameId} reason=pbp_forbidden_not_started`
        )
        return { updated, actionsProcessed, commitRetries }
      }
      console.error(`[nba] live sync game error game=${gameId}`, err)
      return { updated, actionsProcessed, commitRetries }
    }
    try {
      boxScore = await fetchBoxScore(nbaGameId)
    } catch (err) {
      const message = String(err)
      if (!message.includes('NBA not modified')) {
        console.error(
          `[nba] live sync boxscore fetch error game=${gameId} nbaGameId=${nbaGameId}`,
          err
        )
      }
      boxScore = null
    }
    const actions = payload?.actions || []
    const nbaGameStatus =
      payload?.game?.gameStatus ?? boxScore?.gameStatus ?? game?.nbaGameStatus
    const nbaGameStatusText =
      payload?.game?.gameStatusText ??
      boxScore?.gameStatusText ??
      game?.nbaGameStatusText ??
      ''
    const isGameFinal = isFinalStatus(nbaGameStatus, nbaGameStatusText)
    const persistedGameStatusText =
      typeof game?.nbaGameStatusText === 'string'
        ? game.nbaGameStatusText
        : String(game?.nbaGameStatusText ?? '')
    const shouldPersistLiveSyncStatus =
      !lastSyncMs ||
      nowMs - lastSyncMs >= NBA_LIVE_HEARTBEAT_MS ||
      game?.nbaGameStatus !== nbaGameStatus ||
      persistedGameStatusText !== nbaGameStatusText
    const persistLiveSyncStatus = async () => {
      const cachedTimestamp = admin.firestore.Timestamp.now()
      await gameRef.set(
        {
          nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          nbaGameStatus: nbaGameStatus ?? null,
          nbaGameStatusText,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      mergeOpenNbaGameCacheData(gameId, {
        nbaLastSyncAt: cachedTimestamp,
        nbaGameStatus: nbaGameStatus ?? null,
        nbaGameStatusText,
        updatedAt: cachedTimestamp,
      })
    }
    const isGameInProgress = isInProgressStatus(
      nbaGameStatus,
      nbaGameStatusText
    )

    if (isCatchup && !isGameInProgress) {
      console.log(
        `[nba] live sync skip game=${gameId} nbaGameId=${nbaGameId} reason=catchup_non_live status=${String(nbaGameStatus ?? '')} statusText=${String(nbaGameStatusText)}`
      )
      if (shouldPersistLiveSyncStatus || isGameFinal) {
        await persistLiveSyncStatus()
      }
      if (isGameFinal) {
        await resolveQuestionsAtGameEnd(
          gameId,
          lastActionNumber,
          boxScore,
          derivedStats
        )
        console.log(`[nba] live sync game=${gameId} status=final auto-end`)
        await endGameById(gameId)
        removeOpenNbaGameFromCache(gameId)
      }
      return { updated, actionsProcessed, commitRetries }
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
      const cachedTimestamp = admin.firestore.Timestamp.now()
      await gameRef.set(
        {
          gameStartQuestionsScheduledAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      mergeOpenNbaGameCacheData(gameId, {
        gameStartQuestionsScheduledAt: cachedTimestamp,
      })
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
      if (shouldPersistLiveSyncStatus || isGameFinal) {
        await persistLiveSyncStatus()
      }
      if (isGameFinal) {
        await resolveQuestionsAtGameEnd(
          gameId,
          lastActionNumber,
          boxScore,
          derivedStats
        )
        console.log(`[nba] live sync game=${gameId} status=final auto-end`)
        await endGameById(gameId)
        removeOpenNbaGameFromCache(gameId)
      }
      return { updated, actionsProcessed, commitRetries }
    }

    const latestFetchedAction = newActions[newActions.length - 1]
    const latestFetchedActionNumber =
      typeof latestFetchedAction?.actionNumber === 'number'
        ? latestFetchedAction.actionNumber
        : 0
    if (latestFetchedActionNumber > 0) {
      const gameRecord =
        game && typeof game === 'object' && !Array.isArray(game)
          ? (game as Record<string, JsonValue>)
          : null
      const entitySportMatchId = gameRecord
        ? readEntitySportMatchId(gameRecord, nbaGameId)
        : nbaGameId
      if (entitySportMatchId) {
        const startTimeMs =
          typeof game?.startTime?.toMillis === 'function'
            ? game.startTime.toMillis()
            : typeof game?.startTime === 'string'
              ? Number.isFinite(new Date(game.startTime).getTime())
                ? new Date(game.startTime).getTime()
                : null
              : null
        const anchorPeriod =
          typeof latestFetchedAction?.period === 'number'
            ? latestFetchedAction.period
            : null
        const anchorClock =
          typeof latestFetchedAction?.clock === 'string'
            ? latestFetchedAction.clock
            : null
        void captureEntitySportShadowForAction({
          gameId,
          nbaGameId,
          matchId: entitySportMatchId,
          homeTeam:
            typeof game?.homeTeam === 'string'
              ? normalizeTeamCode(game.homeTeam)
              : null,
          awayTeam:
            typeof game?.awayTeam === 'string'
              ? normalizeTeamCode(game.awayTeam)
              : null,
          startTimeMs,
          persistResolvedMatchId: async (resolvedMatchId: string) => {
            const cachedTimestamp = admin.firestore.Timestamp.now()
            await gameRef.set(
              {
                entitySportMatchId: resolvedMatchId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
            mergeOpenNbaGameCacheData(gameId, {
              entitySportMatchId: resolvedMatchId,
              updatedAt: cachedTimestamp,
            })
          },
          anchorActionNumber: latestFetchedActionNumber,
          anchorPeriod,
          anchorClock,
        })
      }
    }
    if (latestFetchedActionNumber > 0) {
      await persistBoxScoreSnapshot(gameId, latestFetchedActionNumber, boxScore)
    }

    actionsProcessed += newActions.length
    const officialPageBaseUrl = buildOfficialGamePageBaseUrl(
      typeof game?.nbaGameSlug === 'string' ? game.nbaGameSlug : null,
      typeof game?.awayTeam === 'string' ? game.awayTeam : null,
      typeof game?.homeTeam === 'string' ? game.homeTeam : null,
      nbaGameId
    )

    const batchSize = 200
    let latestActionObj = newActions[newActions.length - 1]
    for (let i = 0; i < newActions.length; i += batchSize) {
      const batch = newActions.slice(i, i + batchSize)
      const eventWrites: FirestoreWrite[] = []
      const newEventPayloads: EngineEvent[] = []
      const previewDerivedStats = cloneDerivedStatsSnapshot(derivedStats)

      for (const action of batch) {
        const actionNumber = action.actionNumber as number
        if (PERSIST_RAW_NBA_EVENTS) {
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
          eventWrites.push({ ref: rawRef, data: rawPayload })
        }

        const eventRef = db
          .collection(`games/${gameId}/events`)
          .doc(String(actionNumber))
        const gameState: EngineGameState = {
          period: action?.period ?? boxScore?.period ?? null,
          clockMs: parseClockToMs(action?.clock ?? boxScore?.gameClock),
          scoreHome: action?.scoreHome ?? boxScore?.homeTeam?.score ?? null,
          scoreAway: action?.scoreAway ?? boxScore?.awayTeam?.score ?? null,
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
        let eventContext = toEventContext(eventType, eventSubType, action)
        const periodNumber =
          typeof action?.period === 'number' && Number.isFinite(action.period)
            ? action.period
            : null
        if (
          ENABLE_OFFICIAL_CUMULATIVE_FETCH &&
          eventType === EventType.PERIOD_END &&
          periodNumber !== null &&
          periodNumber > 0
        ) {
          // Official stats are fetched asynchronously in the processing phase so
          // they never block write/trigger path for this cycle.
        }

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

        applyDerivedStatsForEvent(previewDerivedStats, eventType, eventContext)
        reconcileDerivedWithBoxScore(previewDerivedStats, gameState.boxScore)
        eventPayload.derivedStatsSnapshot =
          cloneDerivedStatsSnapshot(previewDerivedStats)

        eventWrites.push({ ref: eventRef, data: eventPayload })
        newEventPayloads.push(eventPayload)
      }

      await commitInBatches(eventWrites, () => {
        commitRetries += 1
      })
      for (const eventPayload of newEventPayloads) {
        applyDerivedStatsForEvent(
          derivedStats,
          eventPayload.type,
          eventPayload.context
        )
        reconcileDerivedWithBoxScore(
          derivedStats,
          eventPayload.gameState.boxScore
        )
        const eventForEngine: EngineEvent = eventPayload
        const eventPeriod = eventPayload.gameState?.period
        if (
          ENABLE_OFFICIAL_CUMULATIVE_FETCH &&
          !isCatchup &&
          typeof eventPeriod === 'number' &&
          Number.isFinite(eventPeriod) &&
          eventPeriod > 0
        ) {
          const forceRefresh = eventPayload.type === EventType.PERIOD_END
          void (async () => {
            try {
              const officialAtEvent = await getOfficialCumulativeForGamePeriod(
                gameId,
                officialPageBaseUrl,
                eventPeriod,
                forceRefresh
              )
              if (!officialAtEvent) return
              const eventRef = db
                .collection('games')
                .doc(gameId)
                .collection('events')
                .doc(String(eventPayload.eventId))
              await eventRef.update({
                'context.officialCumulativeStats': officialAtEvent,
              })
              if (LOG_OFFICIAL_COMPARE) {
                console.log(
                  `[nba_diag] official_fetch game=${gameId} nbaGameId=${nbaGameId} event=${eventPayload.eventId} period=${eventPeriod} forceRefresh=${forceRefresh ? '1' : '0'} teams=${Object.keys(officialAtEvent.teams).length} players=${Object.keys(officialAtEvent.players).length}`
                )
              }
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              console.warn(
                `[nba] official cumulative fetch failed game=${gameId} nbaGameId=${nbaGameId} event=${eventPayload.eventId} period=${eventPeriod} error=${message}`
              )
            }
          })()
        }
        const createdQuestionPayload = await triggerBasketballQuestion(
          gameId,
          eventForEngine,
          boxScore,
          {
            persistQuestions: !isCatchup,
            skipQuestionGeneration: isCatchup,
            suppressLogs: isCatchup,
            seasonProfiles,
            derivedStats,
          }
        )
        if (createdQuestionPayload) {
          logOfficialCompare({
            phase: 'creation',
            gameId,
            templateId: createdQuestionPayload.templateId,
            questionContext:
              createdQuestionPayload.resolutionContext &&
              typeof createdQuestionPayload.resolutionContext === 'object'
                ? (createdQuestionPayload.resolutionContext as object)
                : null,
            event: eventForEngine,
            boxScore,
            derivedStats,
          })
        }
        const windowTypes: string[] = ['NEXT_EVENT', 'NEXT_N_MIN', 'PERIOD']
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
          eventForEngine,
          boxScore,
          uniqueWindowTypes,
          derivedStats
        )
      }

      latestActionObj = batch[batch.length - 1] ?? latestActionObj
    }

    const latestAction = latestActionObj?.actionNumber ?? 0
    const cachedTimestamp = admin.firestore.Timestamp.now()
    await gameRef.set(
      {
        lastNbaActionNumber: latestAction,
        nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        nbaGameStatus: nbaGameStatus ?? null,
        nbaGameStatusText,
        nbaDerivedStats: derivedStats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    mergeOpenNbaGameCacheData(gameId, {
      lastNbaActionNumber: latestAction,
      nbaLastSyncAt: cachedTimestamp,
      nbaGameStatus: nbaGameStatus ?? null,
      nbaGameStatusText,
      nbaDerivedStats: derivedStats,
      updatedAt: cachedTimestamp,
    })
    console.log(
      `[nba] live sync game=${gameId} nbaGameId=${nbaGameId} newActions=${newActions.length} latestAction=${latestAction}`
    )
    if (latestActionObj) {
      console.log(
        `[nba] live sync latest action game=${gameId} action=${latestActionObj.actionNumber} period=${latestActionObj.period} clock=${latestActionObj.clock} desc=${latestActionObj.description}`
      )
    }
    if (latestActionObj && isGameEndAction(latestActionObj)) {
      await resolveQuestionsAtGameEnd(
        gameId,
        latestAction,
        boxScore,
        derivedStats
      )
      console.log(`[nba] live sync game=${gameId} action=game_end auto-end`)
      await endGameById(gameId)
      removeOpenNbaGameFromCache(gameId)
    } else if (isFinalStatus(nbaGameStatus, nbaGameStatusText)) {
      await resolveQuestionsAtGameEnd(
        gameId,
        latestAction,
        boxScore,
        derivedStats
      )
      console.log(`[nba] live sync game=${gameId} status=final auto-end`)
      await endGameById(gameId)
      removeOpenNbaGameFromCache(gameId)
    }
    updated += 1
    return { updated, actionsProcessed, commitRetries }
  }

  const gameResults = await Promise.all(
    openGames.map((cachedGame) => processGame(cachedGame))
  )
  const totals = gameResults.reduce(
    (acc, result) => ({
      updated: acc.updated + result.updated,
      actionsProcessed: acc.actionsProcessed + result.actionsProcessed,
      commitRetries: acc.commitRetries + result.commitRetries,
    }),
    { updated: 0, actionsProcessed: 0, commitRetries: 0 }
  )
  const updated = totals.updated
  const actionsProcessed = totals.actionsProcessed
  const commitRetries = totals.commitRetries

  if (updated > 0 || actionsProcessed > 0 || commitRetries > 0) {
    console.log(
      `[nba] live sync done updated=${updated} actionsProcessed=${actionsProcessed} commitRetries=${commitRetries}`
    )
  }
  return {
    openGames: openGames.length,
    updatedGames: updated,
    actionsProcessed,
    commitRetries,
  } satisfies NbaLiveSyncStats
}
