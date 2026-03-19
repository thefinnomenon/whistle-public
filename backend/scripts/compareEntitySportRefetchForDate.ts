import fs from 'fs'
import path from 'path'
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
  state?: string | null
  startTime?: TimestampLike
  nbaGameId?: string | number | null
  homeTeam?: string | null
  awayTeam?: string | null
  entitySportMatchId?: string | number | null
}

type QuestionDoc = {
  state?: string | null
  resolvedEventId?: number | null
  resolutionContext?: {
    startEventId?: number | null
  } | null
}

type EventDoc = {
  eventId?: number
  gameState?: {
    scoreHome?: number | null
    scoreAway?: number | null
  } | null
}

type ShadowDoc = {
  kind?: string | null
  refetch?: boolean | null
  anchorActionNumber?: number | null
  durationMs?: number | null
  error?: string | null
  payload?: JsonValue | null
}

type GameReportRow = {
  gameId: string
  nbaGameId: string
  matchup: string
  state: string
  entitySportMatchId: string
  totalAnchors: number
  okPairs: number
  errorPairs: number
  partialPairs: number
  missingPairs: number
  pbpAvgMs: number | null
  boxAvgMs: number | null
  nbaFinalScore: string
  entityFinalScore: string
  finalScoreMatches: boolean | null
}

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

const readPath = (
  root: JsonValue | null | undefined,
  pathParts: string[]
): JsonValue | null => {
  let cursor: JsonValue | null | undefined = root
  for (const key of pathParts) {
    const obj = asObject(cursor)
    if (!obj) return null
    cursor = obj[key] ?? null
  }
  return cursor ?? null
}

const toNumber = (value: JsonValue | undefined | null): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const scoreText = (home: number | null, away: number | null): string => {
  if (home === null || away === null) return '—'
  return `${away}-${home}`
}

const extractEntityFinalScore = (
  payload: JsonValue | null
): { home: number | null; away: number | null } => {
  const ftHome = toNumber(
    readPath(payload, [
      'response',
      'items',
      'match_info',
      'quarters',
      'ft',
      'home',
    ])
  )
  const ftAway = toNumber(
    readPath(payload, [
      'response',
      'items',
      'match_info',
      'quarters',
      'ft',
      'away',
    ])
  )
  if (ftHome !== null && ftAway !== null) {
    return { home: ftHome, away: ftAway }
  }
  const resHome = toNumber(
    readPath(payload, ['response', 'items', 'match_info', 'result', 'home'])
  )
  const resAway = toNumber(
    readPath(payload, ['response', 'items', 'match_info', 'result', 'away'])
  )
  return { home: resHome, away: resAway }
}

const average = (values: number[]): number | null => {
  if (!values.length) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return Math.round(total / values.length)
}

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const main = async () => {
  const dateArg = process.argv.find((arg) => arg.startsWith('--date='))
  const outArg = process.argv.find((arg) => arg.startsWith('--out='))
  const explicitDate = dateArg ? dateArg.slice('--date='.length) : null
  const outPath = outArg
    ? outArg.slice('--out='.length)
    : 'backend/reports/entitysport-refetch-compare.html'

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const targetDateEt = explicitDate ?? toEtDateKey(yesterday)

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(300)
    .get()

  const selectedGames = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => {
      if ((data.league ?? '').toUpperCase() !== 'NBA') return false
      const start = toDate(data.startTime)
      if (!start) return false
      return toEtDateKey(start) === targetDateEt
    })

  const rows: GameReportRow[] = []

  for (const game of selectedGames) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const entitySportMatchId = String(game.data.entitySportMatchId ?? '')
    const matchup = `${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`

    const [questionsSnap, eventsSnap, shadowSnap] = await Promise.all([
      db.collection('games').doc(gameId).collection('questions').get(),
      db
        .collection('games')
        .doc(gameId)
        .collection('events')
        .orderBy('eventId', 'desc')
        .limit(1)
        .get(),
      db.collection('games').doc(gameId).collection('entitySportShadow').get(),
    ])

    const anchors = new Set<number>()
    for (const qDoc of questionsSnap.docs) {
      const question = qDoc.data() as QuestionDoc
      if (
        typeof question.resolvedEventId === 'number' &&
        Number.isFinite(question.resolvedEventId)
      ) {
        anchors.add(question.resolvedEventId)
      }
      const startEventId = question.resolutionContext?.startEventId
      if (typeof startEventId === 'number' && Number.isFinite(startEventId)) {
        anchors.add(startEventId)
      }
    }

    const pbpByAnchor = new Map<number, ShadowDoc>()
    const boxByAnchor = new Map<number, ShadowDoc>()

    for (const sDoc of shadowSnap.docs) {
      const shadow = sDoc.data() as ShadowDoc
      if (shadow.refetch !== true) continue
      if (
        typeof shadow.anchorActionNumber !== 'number' ||
        !Number.isFinite(shadow.anchorActionNumber)
      ) {
        continue
      }
      if (shadow.kind === 'play_by_play') {
        pbpByAnchor.set(shadow.anchorActionNumber, shadow)
      } else if (shadow.kind === 'box_score') {
        boxByAnchor.set(shadow.anchorActionNumber, shadow)
      }
    }

    let okPairs = 0
    let errorPairs = 0
    let partialPairs = 0
    let missingPairs = 0

    const pbpDurations: number[] = []
    const boxDurations: number[] = []

    const sortedAnchors = Array.from(anchors.values()).sort((a, b) => a - b)
    for (const anchor of sortedAnchors) {
      const pbp = pbpByAnchor.get(anchor)
      const box = boxByAnchor.get(anchor)
      if (!pbp && !box) {
        missingPairs += 1
        continue
      }
      if (
        pbp &&
        typeof pbp.durationMs === 'number' &&
        Number.isFinite(pbp.durationMs)
      ) {
        pbpDurations.push(pbp.durationMs)
      }
      if (
        box &&
        typeof box.durationMs === 'number' &&
        Number.isFinite(box.durationMs)
      ) {
        boxDurations.push(box.durationMs)
      }
      const pbpErr = !!pbp?.error
      const boxErr = !!box?.error
      if (pbp && box && !pbpErr && !boxErr) {
        okPairs += 1
      } else if ((pbp && box && (pbpErr || boxErr)) || !pbp || !box) {
        if (pbp && box && pbpErr && boxErr) {
          errorPairs += 1
        } else {
          partialPairs += 1
        }
      }
    }

    let nbaFinalHome: number | null = null
    let nbaFinalAway: number | null = null
    if (!eventsSnap.empty) {
      const event = eventsSnap.docs[0].data() as EventDoc
      nbaFinalHome =
        typeof event.gameState?.scoreHome === 'number' &&
        Number.isFinite(event.gameState.scoreHome)
          ? event.gameState.scoreHome
          : null
      nbaFinalAway =
        typeof event.gameState?.scoreAway === 'number' &&
        Number.isFinite(event.gameState.scoreAway)
          ? event.gameState.scoreAway
          : null
    }

    const latestBox = sortedAnchors
      .map((anchor) => boxByAnchor.get(anchor))
      .filter((doc): doc is ShadowDoc => !!doc)
      .reverse()[0]
    const entityFinal = extractEntityFinalScore(latestBox?.payload ?? null)

    const finalScoreMatches =
      nbaFinalHome === null ||
      nbaFinalAway === null ||
      entityFinal.home === null ||
      entityFinal.away === null
        ? null
        : nbaFinalHome === entityFinal.home && nbaFinalAway === entityFinal.away

    rows.push({
      gameId,
      nbaGameId,
      matchup,
      state: String(game.data.state ?? 'unknown'),
      entitySportMatchId,
      totalAnchors: sortedAnchors.length,
      okPairs,
      errorPairs,
      partialPairs,
      missingPairs,
      pbpAvgMs: average(pbpDurations),
      boxAvgMs: average(boxDurations),
      nbaFinalScore: scoreText(nbaFinalHome, nbaFinalAway),
      entityFinalScore: scoreText(entityFinal.home, entityFinal.away),
      finalScoreMatches,
    })
  }

  const totalAnchors = rows.reduce((sum, row) => sum + row.totalAnchors, 0)
  const totalOk = rows.reduce((sum, row) => sum + row.okPairs, 0)
  const totalErr = rows.reduce((sum, row) => sum + row.errorPairs, 0)
  const totalPartial = rows.reduce((sum, row) => sum + row.partialPairs, 0)
  const totalMissing = rows.reduce((sum, row) => sum + row.missingPairs, 0)

  console.log(
    `[entitysport-refetch-compare] dateET=${targetDateEt} games=${rows.length} anchors=${totalAnchors} okPairs=${totalOk} errorPairs=${totalErr} partialPairs=${totalPartial} missingPairs=${totalMissing}`
  )
  for (const row of rows) {
    console.log(
      [
        `game=${row.gameId}`,
        `nbaGameId=${row.nbaGameId}`,
        `matchId=${row.entitySportMatchId || '—'}`,
        `anchors=${row.totalAnchors}`,
        `ok=${row.okPairs}`,
        `error=${row.errorPairs}`,
        `partial=${row.partialPairs}`,
        `missing=${row.missingPairs}`,
        `pbpAvgMs=${row.pbpAvgMs ?? '—'}`,
        `boxAvgMs=${row.boxAvgMs ?? '—'}`,
        `nbaFinal=${row.nbaFinalScore}`,
        `entityFinal=${row.entityFinalScore}`,
        `finalMatch=${row.finalScoreMatches === null ? '—' : row.finalScoreMatches ? 'yes' : 'no'}`,
      ].join(' ')
    )
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EntitySport Refetch Compare</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; color: #111827; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>EntitySport Refetch Compare</h1>
  <p>Date (ET): ${htmlEscape(targetDateEt)}</p>
  <p>Games: ${rows.length} • Anchors: ${totalAnchors} • okPairs: ${totalOk} • errorPairs: ${totalErr} • partialPairs: ${totalPartial} • missingPairs: ${totalMissing}</p>
  <table>
    <thead>
      <tr>
        <th>Game</th>
        <th>Matchup</th>
        <th>Entity Match ID</th>
        <th>Anchors</th>
        <th>Pair Health</th>
        <th>Avg Latency</th>
        <th>Final Score</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) => `<tr>
            <td class="mono">${htmlEscape(row.gameId)}<br/>${htmlEscape(row.nbaGameId)}</td>
            <td>${htmlEscape(row.matchup)}<br/><span class="mono">state=${htmlEscape(row.state)}</span></td>
            <td class="mono">${htmlEscape(row.entitySportMatchId || '—')}</td>
            <td class="mono">total=${row.totalAnchors}</td>
            <td class="mono">ok=${row.okPairs}<br/>error=${row.errorPairs}<br/>partial=${row.partialPairs}<br/>missing=${row.missingPairs}</td>
            <td class="mono">pbp=${row.pbpAvgMs ?? '—'}ms<br/>box=${row.boxAvgMs ?? '—'}ms</td>
            <td class="mono">nba=${htmlEscape(row.nbaFinalScore)}<br/>entity=${htmlEscape(row.entityFinalScore)}<br/>match=${row.finalScoreMatches === null ? '—' : row.finalScoreMatches ? 'yes' : 'no'}</td>
          </tr>`
        )
        .join('\n')}
    </tbody>
  </table>
</body>
</html>`

  const resolvedOutPath = path.isAbsolute(outPath)
    ? outPath
    : path.resolve(process.cwd(), outPath)
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true })
  fs.writeFileSync(resolvedOutPath, html, 'utf8')
  console.log(`[entitysport-refetch-compare] html=${resolvedOutPath}`)
}

main().catch((error: Error) => {
  console.error('[entitysport-refetch-compare] error', error)
  process.exit(1)
})
