import https from 'https'
import { db } from '../src/firebase'
import {
  EventType,
  type EngineEvent,
  type OfficialCumulativeStatsSnapshot,
  type OfficialStatLine,
} from '../src/types/engine'

type GameDoc = {
  nbaGameId?: string | number | null
  nbaGameSlug?: string | null
  homeTeam?: string | null
  awayTeam?: string | null
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

const NBA_HTML_TIMEOUT_MS = Number(process.env.NBA_HTML_TIMEOUT_MS ?? 120_000)

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
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

const toNumber = (value: JsonValue | undefined | null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
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

const readStatNumber = (
  stats: { [key: string]: JsonValue } | null,
  key: string
): number => {
  if (!stats) return 0
  return toNumber(stats[key] ?? null) ?? 0
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
  const keys: ('homeTeam' | 'awayTeam')[] = ['homeTeam', 'awayTeam']
  for (const key of keys) {
    const teamObj = asObject(gameObj[key])
    if (!teamObj) continue
    const tricode = normalizeCode(
      typeof teamObj.teamTricode === 'string' ? teamObj.teamTricode : null
    )
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
      const stats = asObject(playerObj.statistics)
      players[String(playerId)] = {
        points: readStatNumber(stats, 'points'),
        assists: readStatNumber(stats, 'assists'),
        rebounds: readStatNumber(stats, 'reboundsTotal'),
        steals: readStatNumber(stats, 'steals'),
        threes: readStatNumber(stats, 'threePointersMade'),
        blocks: readStatNumber(stats, 'blocks'),
        freeThrowsMade: readStatNumber(stats, 'freeThrowsMade'),
      }
    }
  }
  return { teams, players }
}

const buildGameSlug = (
  awayCode: string,
  homeCode: string,
  nbaGameId: string
): string => {
  if (!awayCode || !homeCode || !nbaGameId) return ''
  return `${awayCode.toLowerCase()}-vs-${homeCode.toLowerCase()}-${nbaGameId}`
}

const buildOfficialGamePageBaseUrl = (
  game: GameDoc,
  nbaGameId: string
): string => {
  const away = normalizeCode(game.awayTeam ?? null) ?? ''
  const home = normalizeCode(game.homeTeam ?? null) ?? ''
  const slug =
    typeof game.nbaGameSlug === 'string' && game.nbaGameSlug.trim()
      ? game.nbaGameSlug.trim()
      : buildGameSlug(away, home, nbaGameId)
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
      throw new Error(`missing __NEXT_DATA__ for ${periodUrl}`)
    }
    const stats = extractOfficialPeriodStats(nextData)
    if (!stats) {
      throw new Error(`missing period stats for ${periodUrl}`)
    }
    for (const [tricode, line] of Object.entries(stats.teams)) {
      if (!teams[tricode]) teams[tricode] = emptyOfficialStatLine()
      addOfficialStatLine(teams[tricode], line)
    }
    for (const [playerId, line] of Object.entries(stats.players)) {
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

const main = async () => {
  const gameId = process.argv[2]
  if (!gameId) {
    console.error(
      'Usage: env-cmd -f .env.production -- ts-node scripts/backfillOfficialCumulativeEventStats.ts <gameId>'
    )
    process.exit(1)
  }

  const gameRef = db.collection('games').doc(gameId)
  const gameSnap = await gameRef.get()
  if (!gameSnap.exists) {
    console.error(`Game not found: ${gameId}`)
    process.exit(1)
  }
  const game = gameSnap.data() as GameDoc
  const nbaGameId = String(game.nbaGameId ?? '')
  if (!nbaGameId) {
    console.error(`Game missing nbaGameId: ${gameId}`)
    process.exit(1)
  }

  const eventsSnap = await gameRef
    .collection('events')
    .orderBy('eventId', 'asc')
    .get()

  const events = eventsSnap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data() as EngineEvent,
  }))

  const periodEndRows = events
    .filter(
      (row) =>
        row.data.type === EventType.PERIOD_END &&
        typeof row.data.gameState?.period === 'number' &&
        Number.isFinite(row.data.gameState.period) &&
        row.data.gameState.period > 0
    )
    .map((row) => ({
      id: row.id,
      period: row.data.gameState.period as number,
    }))

  if (!periodEndRows.length) {
    console.log(`No PERIOD_END events found for game=${gameId}`)
    return
  }

  const uniquePeriods = Array.from(
    new Set(periodEndRows.map((row) => row.period))
  ).sort((a, b) => a - b)
  const baseUrl = buildOfficialGamePageBaseUrl(game, nbaGameId)
  const byPeriod = new Map<number, OfficialCumulativeStatsSnapshot | null>()

  for (const period of uniquePeriods) {
    try {
      const snapshot = await fetchOfficialCumulativeStatsThroughPeriod(
        baseUrl,
        period
      )
      byPeriod.set(period, snapshot)
      console.log(
        `[backfill-official-cumulative] fetched game=${gameId} period=${period} ok=${snapshot ? 'yes' : 'no'}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      byPeriod.set(period, null)
      console.warn(
        `[backfill-official-cumulative] fetch_failed game=${gameId} period=${period} error=${message}`
      )
    }
  }

  let updated = 0
  let skipped = 0
  let batch = db.batch()
  let count = 0
  const commitBatch = async () => {
    if (count === 0) return
    await batch.commit()
    batch = db.batch()
    count = 0
  }

  for (const row of periodEndRows) {
    const snapshot = byPeriod.get(row.period) ?? null
    if (!snapshot) {
      skipped += 1
      continue
    }
    const ref = gameRef.collection('events').doc(row.id)
    batch.set(
      ref,
      {
        context: {
          officialCumulativeStats: snapshot,
        },
      },
      { merge: true }
    )
    count += 1
    updated += 1
    if (count >= 200) {
      await commitBatch()
    }
  }
  await commitBatch()

  console.log(
    `Backfill official cumulative done game=${gameId} nbaGameId=${nbaGameId} periodEndEvents=${periodEndRows.length} updated=${updated} skipped=${skipped}`
  )
}

main().catch((error: Error) => {
  console.error('[backfill-official-cumulative] error', error)
  process.exit(1)
})
