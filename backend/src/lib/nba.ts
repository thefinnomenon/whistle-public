import https from 'https'
import { admin, db } from '../firebase'
import { endGameById } from '../routes/game'

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

const isFinalStatus = (status: any, statusText: any) => {
  const numeric = typeof status === 'number' ? status : Number(status)
  const text = String(statusText || '').toLowerCase()
  if (numeric === 3) return true
  if (text.includes('final')) return true
  if (text.includes('game over')) return true
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
  writes: { ref: FirebaseFirestore.DocumentReference; data: any }[]
) => {
  const limit = 450
  let batch = db.batch()
  let count = 0
  for (const write of writes) {
    batch.set(write.ref, write.data, { merge: true })
    count += 1
    if (count >= limit) {
      await batch.commit()
      batch = db.batch()
      count = 0
    }
  }
  if (count > 0) await batch.commit()
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
  const gamesSnap = await db
    .collection('games')
    .where('state', '==', 'open')
    .where('league', '==', 'NBA')
    .get()

  if (gamesSnap.empty) return 0

  console.log(`[nba] live sync start openGames=${gamesSnap.size}`)
  let updated = 0
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

    let payload
    try {
      payload = await fetchPlayByPlay(nbaGameId)
    } catch (err) {
      const message = String(err)
      if (message.includes('NBA not modified')) {
        continue
      }
      throw err
    }
    const actions = payload?.actions || []
    const lastActionNumber =
      typeof game?.lastNbaActionNumber === 'number'
        ? game.lastNbaActionNumber
        : 0

    const newActions = actions
      .filter(
        (action: any) =>
          typeof action?.actionNumber === 'number' &&
          action.actionNumber > lastActionNumber
      )
      .sort((a: any, b: any) => a.actionNumber - b.actionNumber)

    if (newActions.length === 0) {
      await doc.ref.set(
        {
          nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
          nbaGameStatus:
            payload?.game?.gameStatus ?? game?.nbaGameStatus ?? null,
          nbaGameStatusText:
            payload?.game?.gameStatusText ?? game?.nbaGameStatusText ?? '',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      if (
        isFinalStatus(payload?.game?.gameStatus, payload?.game?.gameStatusText)
      ) {
        console.log(`[nba] live sync game=${gameId} status=final auto-end`)
        await endGameById(gameId)
      }
      continue
    }

    const eventWrites = newActions.map((action: any) => {
      const actionNumber = action.actionNumber as number
      const eventRef = db
        .collection(`games/${gameId}/events`)
        .doc(String(actionNumber))
      const eventPayload = {
        source: 'nba.com',
        nbaGameId,
        actionNumber,
        period: action?.period ?? null,
        clock: action?.clock ?? null,
        description: action?.description ?? '',
        teamId: action?.teamId ?? null,
        teamTricode: action?.teamTricode ?? null,
        scoreHome: action?.scoreHome ?? null,
        scoreAway: action?.scoreAway ?? null,
        actionType: action?.actionType ?? null,
        subType: action?.subType ?? null,
        shotResult: action?.shotResult ?? null,
        raw: action,
        ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
      return { ref: eventRef, data: eventPayload }
    })

    await commitInBatches(eventWrites)

    const latestAction = newActions[newActions.length - 1]?.actionNumber ?? 0
    const latestActionObj = newActions[newActions.length - 1]
    await doc.ref.set(
      {
        lastNbaActionNumber: latestAction,
        nbaLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        nbaGameStatus: payload?.game?.gameStatus ?? game?.nbaGameStatus ?? null,
        nbaGameStatusText:
          payload?.game?.gameStatusText ?? game?.nbaGameStatusText ?? '',
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
      console.log(`[nba] live sync game=${gameId} action=game_end auto-end`)
      await endGameById(gameId)
    } else if (
      isFinalStatus(payload?.game?.gameStatus, payload?.game?.gameStatusText)
    ) {
      console.log(`[nba] live sync game=${gameId} status=final auto-end`)
      await endGameById(gameId)
    }
    updated += 1
  }

  console.log(`[nba] live sync done updated=${updated}`)
  return updated
}
