import https from 'https'
import { createHash } from 'crypto'
import { admin, db } from '../src/firebase'

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
  state?: string | null
  startTime?: TimestampLike
  nbaGameId?: string | number | null
  homeTeam?: string | null
  awayTeam?: string | null
  entitySportMatchId?: string | number | null
}

type EventDoc = {
  eventId?: number
  gameState?: {
    period?: number | null
    boxScore?: {
      gameClock?: string | null
    } | null
  } | null
}

type QuestionDoc = {
  resolvedEventId?: number | null
  resolutionContext?: {
    startEventId?: number | null
  } | null
}

type FetchResult = {
  url: string
  durationMs: number
  statusCode: number | null
  payload: JsonValue | null
  payloadBytes: number
  payloadSha1: string | null
  payloadPreview: string | null
  error: string | null
}

const ENTITYSPORT_TOKEN = process.env.ENTITYSPORT_TOKEN ?? ''
const ENTITYSPORT_TIMEOUT_MS = 15_000

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

const toEtDateKey = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

const asObject = (
  value: JsonValue | undefined | null
): { [key: string]: JsonValue } | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const fetchJson = async (url: string): Promise<FetchResult> => {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
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
            payloadPreview: raw.slice(0, 512),
            error: `status_${statusCode}`,
          })
          return
        }
        try {
          const payload = JSON.parse(raw) as JsonValue
          const payloadObject = asObject(payload)
          const status = payloadObject?.status
          if (typeof status === 'string' && status.toLowerCase() !== 'ok') {
            resolve({
              url,
              durationMs,
              statusCode,
              payload,
              payloadBytes: raw.length,
              payloadSha1:
                raw.length > 0
                  ? createHash('sha1').update(raw).digest('hex')
                  : null,
              payloadPreview: raw.slice(0, 512),
              error: `non_ok:${status}`,
            })
            return
          }
          resolve({
            url,
            durationMs,
            statusCode,
            payload,
            payloadBytes: raw.length,
            payloadSha1:
              raw.length > 0
                ? createHash('sha1').update(raw).digest('hex')
                : null,
            payloadPreview: null,
            error: null,
          })
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
            payloadPreview: raw.slice(0, 512),
            error: `parse_error:${message}`,
          })
        }
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
        payloadPreview: null,
        error: `request_error:${message}`,
      })
    })
  })
}

const main = async () => {
  if (!ENTITYSPORT_TOKEN) {
    console.error('[refetch-entitysport-shadow] missing ENTITYSPORT_TOKEN')
    process.exit(1)
  }

  const dateArg = process.argv.find((arg) => arg.startsWith('--date='))
  const explicitDate = dateArg ? dateArg.slice('--date='.length) : null
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const targetDateEt = explicitDate ?? toEtDateKey(yesterday)

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(250)
    .get()

  const targetGames = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => {
      if ((data.league ?? '').toUpperCase() !== 'NBA') return false
      const start = toDate(data.startTime)
      if (!start) return false
      return toEtDateKey(start) === targetDateEt
    })

  console.log(
    `[refetch-entitysport-shadow] targetDateET=${targetDateEt} games=${targetGames.length}`
  )

  let storedDocs = 0
  let fetchErrors = 0

  for (const game of targetGames) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const matchIdRaw = game.data.entitySportMatchId
    const matchId =
      typeof matchIdRaw === 'number'
        ? String(matchIdRaw)
        : typeof matchIdRaw === 'string'
          ? matchIdRaw.trim()
          : ''
    if (!matchId) {
      console.warn(
        `[refetch-entitysport-shadow] skip game=${gameId} nbaGameId=${nbaGameId} reason=missing_match_id`
      )
      continue
    }

    const [questionsSnap, eventsSnap] = await Promise.all([
      db.collection('games').doc(gameId).collection('questions').get(),
      db.collection('games').doc(gameId).collection('events').get(),
    ])

    const eventMap = new Map<number, EventDoc>()
    for (const doc of eventsSnap.docs) {
      const event = doc.data() as EventDoc
      if (typeof event.eventId === 'number' && Number.isFinite(event.eventId)) {
        eventMap.set(event.eventId, event)
      }
    }

    const anchorEventIds = new Set<number>()
    for (const doc of questionsSnap.docs) {
      const question = doc.data() as QuestionDoc
      if (
        typeof question.resolvedEventId === 'number' &&
        Number.isFinite(question.resolvedEventId)
      ) {
        anchorEventIds.add(question.resolvedEventId)
      }
      const startEventId = question.resolutionContext?.startEventId
      if (typeof startEventId === 'number' && Number.isFinite(startEventId)) {
        anchorEventIds.add(startEventId)
      }
    }

    const sortedAnchors = Array.from(anchorEventIds.values()).sort(
      (a, b) => a - b
    )
    console.log(
      `[refetch-entitysport-shadow] game=${gameId} nbaGameId=${nbaGameId} matchId=${matchId} anchors=${sortedAnchors.length}`
    )

    for (const anchorEventId of sortedAnchors) {
      const event = eventMap.get(anchorEventId)
      const period =
        typeof event?.gameState?.period === 'number' &&
        Number.isFinite(event.gameState.period)
          ? event.gameState.period
          : null
      const clock =
        typeof event?.gameState?.boxScore?.gameClock === 'string'
          ? event.gameState.boxScore.gameClock
          : null

      const infoUrl = `https://basketballapi.entitysport.com/matches/${encodeURIComponent(
        matchId
      )}/info?token=${encodeURIComponent(ENTITYSPORT_TOKEN)}`
      const statsUrl = `https://basketballapi.entitysport.com/matches/${encodeURIComponent(
        matchId
      )}/stats?token=${encodeURIComponent(ENTITYSPORT_TOKEN)}`

      const [pbpResult, boxResult] = await Promise.all([
        fetchJson(infoUrl),
        fetchJson(statsUrl),
      ])

      if (pbpResult.error || boxResult.error) {
        fetchErrors += 1
      }

      const common = {
        source: 'entitysport',
        refetch: true,
        refetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        nbaGameId,
        entitySportMatchId: matchId,
        anchorActionNumber: anchorEventId,
        anchorPeriod: period,
        anchorClock: clock,
      }

      const shadowRef = db
        .collection('games')
        .doc(gameId)
        .collection('entitySportShadow')
      await Promise.all([
        shadowRef.doc(`pbp_${anchorEventId}`).set(
          {
            ...common,
            kind: 'play_by_play',
            ...pbpResult,
          },
          { merge: true }
        ),
        shadowRef.doc(`boxscore_${anchorEventId}`).set(
          {
            ...common,
            kind: 'box_score',
            ...boxResult,
          },
          { merge: true }
        ),
      ])
      storedDocs += 2
    }
  }

  console.log(
    `[refetch-entitysport-shadow] done storedDocs=${storedDocs} fetchErrorPairs=${fetchErrors}`
  )
}

main().catch((error: Error) => {
  console.error('[refetch-entitysport-shadow] error', error)
  process.exit(1)
})
