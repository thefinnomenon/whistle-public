import https from 'https'
import { db } from '../src/firebase'

type TimestampLike =
  | { toDate: () => Date }
  | Date
  | string
  | number
  | null
  | undefined

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type GameDoc = {
  league?: string | null
  startTime?: TimestampLike
  homeTeam?: string | null
  awayTeam?: string | null
  nbaGameId?: string | number | null
  entitySportMatchId?: string | number | null
}

type EntitySportMatchSummary = {
  mid: string
  homeAbbr: string
  awayAbbr: string
  timestampStartMs: number | null
}

const ENTITYSPORT_TOKEN = process.env.ENTITYSPORT_TOKEN ?? ''
const CACHE = new Map<string, EntitySportMatchSummary[]>()

const toDate = (value: TimestampLike): Date | null => {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
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

const readPath = (root: JsonValue, path: string[]): JsonValue | null => {
  let cursor: JsonValue | null = root
  for (const key of path) {
    const obj = asObject(cursor)
    if (!obj) return null
    cursor = obj[key] ?? null
  }
  return cursor
}

const toDateYmdUtc = (date: Date): string => date.toISOString().slice(0, 10)

const shiftDateYmdUtc = (dateYmd: string, dayDelta: number): string => {
  const base = new Date(`${dateYmd}T00:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + dayDelta)
  return toDateYmdUtc(base)
}

const normalizeCode = (value: string | null | undefined) =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

const fetchJson = (url: string): Promise<JsonValue | null> =>
  new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        if (typeof res.statusCode === 'number' && res.statusCode >= 400) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(raw) as JsonValue)
        } catch {
          resolve(null)
        }
      })
    })
    req.setTimeout(15000, () => req.destroy())
    req.on('error', () => resolve(null))
  })

const fetchMatchesByDate = async (
  dateYmd: string
): Promise<EntitySportMatchSummary[]> => {
  const cached = CACHE.get(dateYmd)
  if (cached) return cached
  const url = `https://basketballapi.entitysport.com/matches?token=${encodeURIComponent(
    ENTITYSPORT_TOKEN
  )}&date=${encodeURIComponent(dateYmd)}`
  const payload = await fetchJson(url)
  const status = asObject(payload)?.status
  if (typeof status !== 'string' || status.toLowerCase() !== 'ok') {
    CACHE.set(dateYmd, [])
    return []
  }
  const items = asArray(readPath(payload as JsonValue, ['response', 'items']))
  if (!items) {
    CACHE.set(dateYmd, [])
    return []
  }
  const matches: EntitySportMatchSummary[] = []
  for (const item of items) {
    const obj = asObject(item)
    if (!obj) continue
    const midRaw = obj.mid
    const mid =
      typeof midRaw === 'number'
        ? String(midRaw)
        : typeof midRaw === 'string'
          ? midRaw.trim()
          : ''
    if (!mid) continue
    const teams = asObject(obj.teams)
    const home = asObject(teams?.home ?? null)
    const away = asObject(teams?.away ?? null)
    const homeAbbr = normalizeCode(
      typeof home?.abbr === 'string' ? home.abbr : null
    )
    const awayAbbr = normalizeCode(
      typeof away?.abbr === 'string' ? away.abbr : null
    )
    const tsRaw = obj.timestampstart
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string' && Number.isFinite(Number(tsRaw))
          ? Number(tsRaw)
          : null
    matches.push({
      mid,
      homeAbbr,
      awayAbbr,
      timestampStartMs: ts === null ? null : ts * 1000,
    })
  }
  CACHE.set(dateYmd, matches)
  return matches
}

const findBestMatchId = async (game: GameDoc): Promise<string | null> => {
  const home = normalizeCode(game.homeTeam)
  const away = normalizeCode(game.awayTeam)
  const start = toDate(game.startTime)
  if (!home || !away || !start) return null
  const ymd = toDateYmdUtc(start)
  const candidates = [shiftDateYmdUtc(ymd, -1), ymd, shiftDateYmdUtc(ymd, 1)]
  let best: { mid: string; diffMs: number } | null = null
  for (const dateYmd of candidates) {
    const matches = await fetchMatchesByDate(dateYmd)
    for (const match of matches) {
      if (match.homeAbbr !== home || match.awayAbbr !== away) continue
      const diffMs =
        match.timestampStartMs === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(match.timestampStartMs - start.getTime())
      if (!best || diffMs < best.diffMs) {
        best = { mid: match.mid, diffMs }
      }
    }
  }
  if (
    !best ||
    !Number.isFinite(best.diffMs) ||
    best.diffMs > 8 * 60 * 60 * 1000
  ) {
    return null
  }
  return best.mid
}

const main = async () => {
  if (!ENTITYSPORT_TOKEN) {
    console.error('[backfill-entitysport-match-ids] missing ENTITYSPORT_TOKEN')
    process.exit(1)
  }
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 50
  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit((Number.isFinite(limit) && limit > 0 ? limit : 50) * 3)
    .get()

  let updated = 0
  let skipped = 0
  for (const doc of gamesSnap.docs) {
    const game = doc.data() as GameDoc
    if ((game.league ?? '').toUpperCase() !== 'NBA') {
      skipped += 1
      continue
    }
    if (game.entitySportMatchId) {
      skipped += 1
      continue
    }
    const mapped = await findBestMatchId(game)
    if (!mapped) {
      skipped += 1
      continue
    }
    await doc.ref.set(
      {
        entitySportMatchId: mapped,
      },
      { merge: true }
    )
    updated += 1
    console.log(
      `[backfill-entitysport-match-ids] mapped game=${doc.id} nbaGameId=${String(game.nbaGameId ?? '')} entitySportMatchId=${mapped}`
    )
  }
  console.log(
    `[backfill-entitysport-match-ids] done updated=${updated} skipped=${skipped}`
  )
}

main().catch((error: Error) => {
  console.error('[backfill-entitysport-match-ids] error', error)
  process.exit(1)
})
