import { db } from '../src/firebase'

type TimestampLike =
  | { toDate: () => Date }
  | Date
  | string
  | number
  | null
  | undefined

type GameDoc = {
  league?: string | null
  state?: string | null
  startTime?: TimestampLike
  nbaGameId?: string | number | null
  homeTeam?: string | null
  awayTeam?: string | null
  entitySportMatchId?: string | number | null
}

type ShadowDoc = {
  kind?: string | null
  refetch?: boolean | null
  anchorActionNumber?: number | null
  durationMs?: number | null
  statusCode?: number | null
  error?: string | null
  payloadPreview?: string | null
  entitySportMatchId?: string | number | null
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

const etDateKey = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

const parseArg = (name: string): string | null => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (!found) return null
  return found.slice(name.length + 3)
}

const main = async () => {
  const explicitDate = parseArg('date')
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const targetDate = explicitDate ?? etDateKey(yesterday)

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(300)
    .get()

  const selected = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => {
      const start = toDate(data.startTime)
      if (!start) return false
      if ((data.league ?? '').toUpperCase() !== 'NBA') return false
      return etDateKey(start) === targetDate
    })

  console.log(
    `[shadow-audit] targetDateET=${targetDate} nbaGames=${selected.length}`
  )

  if (!selected.length) return

  for (const game of selected) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const start = toDate(game.data.startTime)
    const shadowSnap = await db
      .collection('games')
      .doc(gameId)
      .collection('entitySportShadow')
      .get()
    const eventsSnap = await db
      .collection('games')
      .doc(gameId)
      .collection('events')
      .orderBy('eventId', 'desc')
      .limit(1)
      .get()

    const shadows = shadowSnap.docs.map((doc) => doc.data() as ShadowDoc)
    const refetched = shadows.filter((doc) => doc.refetch === true)
    const pbpDocs = shadows.filter((doc) => doc.kind === 'play_by_play')
    const boxDocs = shadows.filter((doc) => doc.kind === 'box_score')
    const pbpRefetchDocs = refetched.filter(
      (doc) => doc.kind === 'play_by_play'
    )
    const boxRefetchDocs = refetched.filter((doc) => doc.kind === 'box_score')
    const pbpErrors = pbpDocs.filter(
      (doc) => typeof doc.error === 'string' && doc.error.length > 0
    )
    const boxErrors = boxDocs.filter(
      (doc) => typeof doc.error === 'string' && doc.error.length > 0
    )
    const pbpRefetchErrors = pbpRefetchDocs.filter(
      (doc) => typeof doc.error === 'string' && doc.error.length > 0
    )
    const boxRefetchErrors = boxRefetchDocs.filter(
      (doc) => typeof doc.error === 'string' && doc.error.length > 0
    )
    const uniquePbpErrors = Array.from(
      new Set(
        pbpErrors
          .map((doc) => doc.error)
          .filter((value): value is string => typeof value === 'string')
      )
    )
    const uniqueBoxErrors = Array.from(
      new Set(
        boxErrors
          .map((doc) => doc.error)
          .filter((value): value is string => typeof value === 'string')
      )
    )
    const pbpDurations = pbpDocs
      .map((doc) => doc.durationMs)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value)
      )
    const boxDurations = boxDocs
      .map((doc) => doc.durationMs)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value)
      )

    const avg = (values: number[]) =>
      values.length
        ? Math.round(
            values.reduce((sum, value) => sum + value, 0) / values.length
          )
        : null
    const pbpPreview =
      pbpErrors.find((doc) => typeof doc.payloadPreview === 'string')
        ?.payloadPreview ?? null
    const boxPreview =
      boxErrors.find((doc) => typeof doc.payloadPreview === 'string')
        ?.payloadPreview ?? null
    const maxAnchor = shadows.reduce<number | null>((acc, doc) => {
      if (typeof doc.anchorActionNumber !== 'number') return acc
      if (!Number.isFinite(doc.anchorActionNumber)) return acc
      if (acc === null) return doc.anchorActionNumber
      return Math.max(acc, doc.anchorActionNumber)
    }, null)
    const lastEventId =
      eventsSnap.empty || typeof eventsSnap.docs[0].data().eventId !== 'number'
        ? null
        : (eventsSnap.docs[0].data().eventId as number)

    console.log(
      [
        `[shadow-audit] game=${gameId}`,
        `nbaGameId=${nbaGameId}`,
        `startET=${start ? start.toISOString() : '—'}`,
        `matchup=${game.data.awayTeam ?? 'AWAY'}_vs_${game.data.homeTeam ?? 'HOME'}`,
        `state=${game.data.state ?? 'unknown'}`,
        `matchId=${String(game.data.entitySportMatchId ?? nbaGameId)}`,
        `shadowDocs=${shadows.length}`,
        `refetchDocs=${refetched.length}`,
        `pbpDocs=${pbpDocs.length}`,
        `boxDocs=${boxDocs.length}`,
        `pbpErrors=${pbpErrors.length}`,
        `boxErrors=${boxErrors.length}`,
        `pbpRefetchErrors=${pbpRefetchErrors.length}/${pbpRefetchDocs.length}`,
        `boxRefetchErrors=${boxRefetchErrors.length}/${boxRefetchDocs.length}`,
        `pbpErrorTypes=${uniquePbpErrors.slice(0, 3).join('|') || 'none'}`,
        `boxErrorTypes=${uniqueBoxErrors.slice(0, 3).join('|') || 'none'}`,
        `pbpErrorPreview=${(pbpPreview ?? '—').slice(0, 120).replace(/\s+/g, ' ')}`,
        `boxErrorPreview=${(boxPreview ?? '—').slice(0, 120).replace(/\s+/g, ' ')}`,
        `pbpAvgMs=${avg(pbpDurations) ?? '—'}`,
        `boxAvgMs=${avg(boxDurations) ?? '—'}`,
        `lastShadowAction=${maxAnchor ?? '—'}`,
        `lastEventAction=${lastEventId ?? '—'}`,
      ].join(' ')
    )
  }
}

main().catch((error: Error) => {
  console.error('[shadow-audit] error', error)
  process.exit(1)
})
