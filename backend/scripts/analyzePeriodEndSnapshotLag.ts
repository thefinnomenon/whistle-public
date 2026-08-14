import https from 'https'
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
  nbaGameId?: string | number | null
  homeTeam?: string | null
  awayTeam?: string | null
}

type BoxScoreTeamStats = {
  points?: number
  assists?: number
  reboundsTotal?: number
  steals?: number
  threePointersMade?: number
}

type BoxScoreTeam = {
  teamTricode?: string | null
  statistics?: BoxScoreTeamStats | null
}

type BoxScore = {
  homeTeam?: BoxScoreTeam | null
  awayTeam?: BoxScoreTeam | null
  game?: {
    homeTeam?: BoxScoreTeam | null
    awayTeam?: BoxScoreTeam | null
  } | null
}

type BoxScoreSnapshotDoc = {
  actionNumber?: number
  boxScore?: BoxScore | null
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type OfficialStatLine = {
  points: number
  assists: number
  reboundsTotal: number
  steals: number
  threePointersMade: number
}

const NBA_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Encoding': 'identity',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const toDate = (value: TimestampLike): Date | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const parsed = value.toDate()
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
}

const asObject = (
  value: JsonValue | null | undefined
): { [key: string]: JsonValue } | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const fetchHtml = (url: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { headers: NBA_HEADERS }, (res) => {
      const { statusCode } = res
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        if (statusCode && statusCode >= 400) {
          reject(new Error(`NBA html request failed ${statusCode}: ${url}`))
          return
        }
        resolve(raw)
      })
    })
    req.setTimeout(90_000, () => {
      req.destroy(new Error(`NBA html timeout: ${url}`))
    })
    req.on('error', (error) => reject(error))
  })

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

const readStat = (
  stats: { [key: string]: JsonValue } | null,
  key: string
): number => {
  if (!stats) return 0
  const value = stats[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const extractQuarterTeamStats = (
  html: string
): Map<string, OfficialStatLine> | null => {
  const next = parseNextData(html)
  if (!next) return null
  const root = asObject(next)
  const props = root ? asObject(root.props) : null
  const pageProps = props ? asObject(props.pageProps) : null
  const game = pageProps ? asObject(pageProps.game) : null
  if (!game) return null

  const result = new Map<string, OfficialStatLine>()
  for (const key of ['homeTeam', 'awayTeam'] as const) {
    const teamObj = asObject(game[key])
    if (!teamObj) continue
    const tricode = normalizeCode(
      teamObj.teamTricode as string | null | undefined
    )
    if (!tricode) continue
    const stats = asObject(teamObj.statistics)
    result.set(tricode, {
      points: readStat(stats, 'points'),
      assists: readStat(stats, 'assists'),
      reboundsTotal: readStat(stats, 'reboundsTotal'),
      steals: readStat(stats, 'steals'),
      threePointersMade: readStat(stats, 'threePointersMade'),
    })
  }
  return result
}

const sumStats = (
  base: OfficialStatLine,
  add: OfficialStatLine
): OfficialStatLine => ({
  points: base.points + add.points,
  assists: base.assists + add.assists,
  reboundsTotal: base.reboundsTotal + add.reboundsTotal,
  steals: base.steals + add.steals,
  threePointersMade: base.threePointersMade + add.threePointersMade,
})

const buildOfficialCumulativeStats = async (
  gameSlug: string,
  endPeriod: number
): Promise<Map<string, OfficialStatLine>> => {
  const totals = new Map<string, OfficialStatLine>()
  for (let period = 1; period <= endPeriod; period += 1) {
    const url = `https://www.nba.com/game/${gameSlug}/box-score?period=Q${period}`
    const html = await fetchHtml(url)
    const periodStats = extractQuarterTeamStats(html)
    if (!periodStats) {
      throw new Error(`missing quarter stats for ${url}`)
    }
    for (const [tricode, stats] of periodStats.entries()) {
      const current = totals.get(tricode) ?? {
        points: 0,
        assists: 0,
        reboundsTotal: 0,
        steals: 0,
        threePointersMade: 0,
      }
      totals.set(tricode, sumStats(current, stats))
    }
  }
  return totals
}

const getTeams = (boxScore: BoxScore | null) => {
  const home = boxScore?.homeTeam ?? boxScore?.game?.homeTeam ?? null
  const away = boxScore?.awayTeam ?? boxScore?.game?.awayTeam ?? null
  return { home, away }
}

const extractSnapshotTeamStats = (
  boxScore: BoxScore | null
): Map<string, OfficialStatLine> => {
  const map = new Map<string, OfficialStatLine>()
  const { home, away } = getTeams(boxScore)
  for (const team of [home, away]) {
    const tricode = normalizeCode(team?.teamTricode ?? null)
    if (!tricode) continue
    const stats = team?.statistics ?? {}
    map.set(tricode, {
      points: Number(stats.points ?? 0),
      assists: Number(stats.assists ?? 0),
      reboundsTotal: Number(stats.reboundsTotal ?? 0),
      steals: Number(stats.steals ?? 0),
      threePointersMade: Number(stats.threePointersMade ?? 0),
    })
  }
  return map
}

const compareStats = (
  actual: Map<string, OfficialStatLine>,
  expected: Map<string, OfficialStatLine>
): { match: boolean; detail: string } => {
  const keys = Array.from(
    new Set([...actual.keys(), ...expected.keys()])
  ).sort()
  const parts: string[] = []
  let match = true
  for (const key of keys) {
    const a = actual.get(key) ?? {
      points: 0,
      assists: 0,
      reboundsTotal: 0,
      steals: 0,
      threePointersMade: 0,
    }
    const e = expected.get(key) ?? {
      points: 0,
      assists: 0,
      reboundsTotal: 0,
      steals: 0,
      threePointersMade: 0,
    }
    const same =
      a.points === e.points &&
      a.assists === e.assists &&
      a.reboundsTotal === e.reboundsTotal &&
      a.steals === e.steals &&
      a.threePointersMade === e.threePointersMade
    if (!same) match = false
    parts.push(
      `${key} actual={PTS:${a.points},AST:${a.assists},REB:${a.reboundsTotal},STL:${a.steals},3PM:${a.threePointersMade}} expected={PTS:${e.points},AST:${e.assists},REB:${e.reboundsTotal},STL:${e.steals},3PM:${e.threePointersMade}}`
    )
  }
  return { match, detail: parts.join(' | ') }
}

const main = async () => {
  const requested = Number(process.argv[2] ?? 5)
  const specificGameIdArg =
    process.argv[3] && process.argv[3].startsWith('nba_')
      ? process.argv[3]
      : null
  const gameLimit =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, 25) : 5

  const selectedGames: { id: string; data: GameDoc }[] = []
  if (specificGameIdArg) {
    const gameDoc = await db.collection('games').doc(specificGameIdArg).get()
    if (!gameDoc.exists) {
      throw new Error(`Game not found: ${specificGameIdArg}`)
    }
    selectedGames.push({ id: gameDoc.id, data: gameDoc.data() as GameDoc })
  } else {
    const gamesSnap = await db
      .collection('games')
      .orderBy('startTime', 'desc')
      .limit(gameLimit * 20)
      .get()
    const candidates = gamesSnap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
      .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)
    for (const game of candidates) {
      if (selectedGames.length >= gameLimit) break
      selectedGames.push(game)
    }
  }

  const quarterCache = new Map<string, Map<string, OfficialStatLine>>()
  let periodRows = 0
  const nonZeroClockRows: string[] = []

  for (const game of selectedGames) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const eventsSnap = await db
      .collection('games')
      .doc(gameId)
      .collection('events')
      .orderBy('eventId', 'asc')
      .get()
    const snapshotSnap = await db
      .collection('games')
      .doc(gameId)
      .collection('boxScoreSnapshots')
      .orderBy('actionNumber', 'asc')
      .get()

    const events = eventsSnap.docs
      .map((doc) => hydrateStoredEngineEvent(doc.data() as StoredEngineEvent))
      .filter((event) => Number.isFinite(event.eventId))
    const periodEnds = events.filter(
      (event) =>
        event.type === 'PERIOD_END' &&
        typeof event.gameState?.period === 'number' &&
        event.gameState.period >= 1 &&
        event.gameState.period <= 4
    )
    if (!periodEnds.length) continue

    const snapshots = snapshotSnap.docs
      .map((doc) => doc.data() as BoxScoreSnapshotDoc)
      .filter(
        (snap): snap is BoxScoreSnapshotDoc & { actionNumber: number } =>
          typeof snap.actionNumber === 'number' &&
          Number.isFinite(snap.actionNumber)
      )

    const referenceBoxScore =
      periodEnds[periodEnds.length - 1]?.gameState?.boxScore ?? null
    const { home, away } = getTeams(referenceBoxScore)
    const homeCode = normalizeCode(home?.teamTricode ?? null)
    const awayCode = normalizeCode(away?.teamTricode ?? null)
    if (!homeCode || !awayCode) {
      console.log(
        `[snapshot-lag] game=${gameId} nbaGameId=${nbaGameId} skipped reason=missing_team_tricode`
      )
      continue
    }
    const gameSlug = `${awayCode.toLowerCase()}-vs-${homeCode.toLowerCase()}-${nbaGameId}`

    console.log(
      `\n[snapshot-lag] game=${gameId} nbaGameId=${nbaGameId} matchup=${awayCode}vs${homeCode} periodEnds=${periodEnds.length}`
    )

    for (const periodEnd of periodEnds) {
      const period = periodEnd.gameState?.period as number
      const clockMs =
        typeof periodEnd.gameState?.clockMs === 'number'
          ? periodEnd.gameState.clockMs
          : null
      const nonZeroClock = clockMs !== null && clockMs !== 0
      if (nonZeroClock) {
        nonZeroClockRows.push(
          `game=${gameId} nbaGameId=${nbaGameId} period=${period} eventId=${periodEnd.eventId} clockMs=${clockMs}`
        )
      }
      const cacheKey = `${gameSlug}:Q${period}`
      let official = quarterCache.get(cacheKey)
      if (!official) {
        try {
          official = await buildOfficialCumulativeStats(gameSlug, period)
          quarterCache.set(cacheKey, official)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.log(
            `[snapshot-lag] game=${gameId} period=${period} eventId=${periodEnd.eventId} official_fetch_failed error=${message}`
          )
          continue
        }
      }

      const eventSnapshotStats = extractSnapshotTeamStats(
        periodEnd.gameState?.boxScore ?? null
      )
      const atEndCompare = compareStats(eventSnapshotStats, official)

      const laterSnapshots = snapshots.filter(
        (snap) => snap.actionNumber >= periodEnd.eventId
      )
      let firstMatchAction: number | null = null
      let firstMatchOffset: number | null = null
      let inspected = 0
      for (const snap of laterSnapshots) {
        inspected += 1
        const compare = compareStats(
          extractSnapshotTeamStats(snap.boxScore ?? null),
          official
        )
        if (compare.match) {
          firstMatchAction = snap.actionNumber
          firstMatchOffset = snap.actionNumber - periodEnd.eventId
          break
        }
      }

      const laterEventBoxes = events
        .filter((evt) => evt.eventId >= periodEnd.eventId)
        .map((evt) => ({
          actionNumber: evt.eventId,
          boxScore: evt.gameState?.boxScore ?? null,
        }))
      let firstEventMatchAction: number | null = null
      let firstEventMatchOffset: number | null = null
      let eventsInspected = 0
      for (const entry of laterEventBoxes) {
        eventsInspected += 1
        const compare = compareStats(
          extractSnapshotTeamStats(entry.boxScore),
          official
        )
        if (compare.match) {
          firstEventMatchAction = entry.actionNumber
          firstEventMatchOffset = entry.actionNumber - periodEnd.eventId
          break
        }
      }

      const startDate = toDate(game.data.startTime)
      console.log(
        [
          `[snapshot-lag]`,
          `game=${gameId}`,
          `nbaGameId=${nbaGameId}`,
          `start=${startDate ? startDate.toISOString() : '—'}`,
          `period=${period}`,
          `periodEndEventId=${periodEnd.eventId}`,
          `clockMs=${clockMs ?? 'null'}`,
          `nonZeroClock=${nonZeroClock}`,
          `atPeriodEndMatch=${atEndCompare.match}`,
          `firstMatchAction=${firstMatchAction ?? 'none'}`,
          `actionsAfterEnd=${firstMatchOffset ?? 'none'}`,
          `snapshotsInspected=${inspected}`,
          `firstEventMatchAction=${firstEventMatchAction ?? 'none'}`,
          `eventActionsAfterEnd=${firstEventMatchOffset ?? 'none'}`,
          `eventsInspected=${eventsInspected}`,
        ].join(' ')
      )
      if (!atEndCompare.match) {
        console.log(
          `[snapshot-lag] detail game=${gameId} period=${period} ${atEndCompare.detail}`
        )
      }
      periodRows += 1
    }
  }

  console.log(`\n[snapshot-lag] analyzed_period_end_rows=${periodRows}`)
  console.log(
    `[snapshot-lag] non_zero_clock_period_ends=${nonZeroClockRows.length}`
  )
  for (const row of nonZeroClockRows) {
    console.log(`[snapshot-lag] non_zero_clock ${row}`)
  }
}

main().catch((error: Error) => {
  console.error('[analyze-period-end-snapshot-lag] error', error)
  process.exit(1)
})
