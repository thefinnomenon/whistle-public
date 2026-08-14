/**
 * Converts legacy NBA event gameState.boxScore values to compressed replay data.
 *
 * The default mode is a read-only dry run. Apply mode requires an exact
 * confirmation string and performs one atomic, retry-safe update per event.
 *
 * Usage:
 *   yarn run:prod scripts/migrateNbaEventBoxScores.ts --max-docs=1000
 *   yarn run:prod scripts/migrateNbaEventBoxScores.ts --apply \
 *     --confirm=compress-nba-event-box-scores
 */
import { admin, db } from '../src/firebase'
import {
  encodeReplayBoxScore,
  REPLAY_BOX_SCORE_ENCODING,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import type { BoxScore } from '../src/types/engine'

type MigrationOptions = {
  apply: boolean
  pageSize: number
  concurrency: number
  maxDocs: number | null
  gameId: string | null
}

type MigrationTotals = {
  games: number
  scanned: number
  matched: number
  converted: number
  alreadyCompressed: number
  withoutBoxScore: number
  rawBytes: number
  compressedBytes: number
  batchesCommitted: number
}

type FirestoreErrorLike = Error & {
  code?: number | string
  details?: string
}

type GameRef =
  FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>

const CONFIRMATION = 'compress-nba-event-box-scores'
const DEFAULT_PAGE_SIZE = 250
const MAX_PAGE_SIZE = 250
const DEFAULT_CONCURRENCY = 5
const MAX_CONCURRENCY = 8
const MAX_ATTEMPTS = 8

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })

const parsePositiveIntegerArg = (
  argv: string[],
  name: string,
  fallback: number,
  maximum: number | null
): number => {
  const prefix = `--${name}=`
  const arg = argv.find((value) => value.startsWith(prefix))
  if (!arg) return fallback

  const parsed = Number(arg.slice(prefix.length))
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }

  return maximum === null ? parsed : Math.min(parsed, maximum)
}

const parseOptionalStringArg = (
  argv: string[],
  name: string
): string | null => {
  const prefix = `--${name}=`
  const arg = argv.find((value) => value.startsWith(prefix))
  if (!arg) return null
  const value = arg.slice(prefix.length).trim()
  return value || null
}

const parseOptions = (argv: string[]): MigrationOptions => {
  const apply = argv.includes('--apply')
  const confirmation = parseOptionalStringArg(argv, 'confirm')

  if (apply && confirmation !== CONFIRMATION) {
    throw new Error(`Apply mode requires --confirm=${CONFIRMATION}`)
  }

  const maxDocsArg = parseOptionalStringArg(argv, 'max-docs')
  return {
    apply,
    pageSize: parsePositiveIntegerArg(
      argv,
      'page-size',
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    ),
    concurrency:
      maxDocsArg === null
        ? parsePositiveIntegerArg(
            argv,
            'concurrency',
            DEFAULT_CONCURRENCY,
            MAX_CONCURRENCY
          )
        : 1,
    maxDocs:
      maxDocsArg === null
        ? null
        : parsePositiveIntegerArg(argv, 'max-docs', 1, null),
    gameId: parseOptionalStringArg(argv, 'game-id'),
  }
}

const isRetryableError = (error: FirestoreErrorLike): boolean => {
  const code = error.code
  if (
    code === 4 ||
    code === '4' ||
    code === 'DEADLINE_EXCEEDED' ||
    code === 8 ||
    code === '8' ||
    code === 'RESOURCE_EXHAUSTED' ||
    code === 14 ||
    code === '14' ||
    code === 'UNAVAILABLE'
  ) {
    return true
  }

  const detail = `${error.message} ${error.details ?? ''}`
  return (
    detail.includes('DEADLINE_EXCEEDED') ||
    detail.includes('Deadline exceeded') ||
    detail.includes('RESOURCE_EXHAUSTED') ||
    detail.includes('UNAVAILABLE')
  )
}

const runWithRetry = async <Result>(
  label: string,
  operation: () => Promise<Result>
): Promise<Result> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const migrationError = error as FirestoreErrorLike
      if (attempt === MAX_ATTEMPTS || !isRetryableError(migrationError)) {
        throw migrationError
      }

      const delayMs = 500 * 2 ** (attempt - 1)
      console.warn(
        `[migration/nba-event-box-scores] retry label=${label} attempt=${attempt} delayMs=${delayMs} reason=${migrationError.code ?? migrationError.message}`
      )
      await sleep(delayMs)
    }
  }

  throw new Error(`Operation exhausted retries: ${label}`)
}

const loadGameRefs = async (gameId: string | null): Promise<GameRef[]> => {
  if (gameId) {
    const ref = db.collection('games').doc(gameId)
    const snap = await ref.get()
    if (!snap.exists) throw new Error(`Game not found: ${gameId}`)
    if (snap.get('league') !== 'NBA') {
      throw new Error(`Game is not an NBA game: ${gameId}`)
    }
    return [ref]
  }

  const snap = await db
    .collection('games')
    .where('league', '==', 'NBA')
    .select()
    .get()
  return snap.docs.map((doc) => doc.ref)
}

const getInlineBoxScore = (event: StoredEngineEvent): BoxScore | null =>
  event.gameState?.boxScore ?? null

const migrateGame = async (
  gameRef: GameRef,
  options: MigrationOptions,
  totals: MigrationTotals
): Promise<void> => {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null

  while (options.maxDocs === null || totals.scanned < options.maxDocs) {
    const remaining =
      options.maxDocs === null
        ? options.pageSize
        : Math.min(options.pageSize, options.maxDocs - totals.scanned)
    if (remaining <= 0) return

    let query = gameRef
      .collection('events')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(remaining)
    if (cursor) query = query.startAfter(cursor)

    const snap = await runWithRetry(
      `read:${gameRef.id}`,
      async () => await query.get()
    )
    if (snap.empty) return

    const batch = db.batch()
    let queued = 0

    for (const doc of snap.docs) {
      totals.scanned += 1
      const event = doc.data() as StoredEngineEvent
      const boxScore = getInlineBoxScore(event)

      if (!boxScore) {
        if (
          event.replayBoxScoreEncoding === REPLAY_BOX_SCORE_ENCODING &&
          event.replayBoxScoreGzip
        ) {
          totals.alreadyCompressed += 1
        } else {
          totals.withoutBoxScore += 1
        }
        continue
      }

      const encoded = encodeReplayBoxScore(boxScore)
      totals.matched += 1
      totals.rawBytes += encoded.rawBytes
      totals.compressedBytes += encoded.compressedBytes

      if (options.apply) {
        batch.update(doc.ref, {
          'gameState.boxScore': admin.firestore.FieldValue.delete(),
          replayBoxScoreEncoding: REPLAY_BOX_SCORE_ENCODING,
          replayBoxScoreGzip: encoded.compressed,
        })
        queued += 1
      }
    }

    if (queued > 0) {
      await runWithRetry(
        `write:${gameRef.id}`,
        async () => await batch.commit()
      )
      totals.converted += queued
      totals.batchesCommitted += 1
      console.log(
        `[migration/nba-event-box-scores] batch gameId=${gameRef.id} converted=${queued} totalConverted=${totals.converted}`
      )
    }

    cursor = snap.docs[snap.docs.length - 1] ?? null
    if (snap.size < remaining) return
  }
}

const formatGiB = (bytes: number): string => (bytes / 1024 ** 3).toFixed(3)

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2))
  const gameRefs = await loadGameRefs(options.gameId)
  const totals: MigrationTotals = {
    games: gameRefs.length,
    scanned: 0,
    matched: 0,
    converted: 0,
    alreadyCompressed: 0,
    withoutBoxScore: 0,
    rawBytes: 0,
    compressedBytes: 0,
    batchesCommitted: 0,
  }

  console.log(
    `[migration/nba-event-box-scores] start mode=${options.apply ? 'apply' : 'dry-run'} games=${gameRefs.length} pageSize=${options.pageSize} concurrency=${options.concurrency} maxDocs=${options.maxDocs ?? 'all'} gameId=${options.gameId ?? 'all'}`
  )

  let nextGameIndex = 0
  const migrateNextGame = async (): Promise<void> => {
    while (nextGameIndex < gameRefs.length) {
      if (options.maxDocs !== null && totals.scanned >= options.maxDocs) return
      const gameRef = gameRefs[nextGameIndex]
      nextGameIndex += 1
      if (!gameRef) return
      await migrateGame(gameRef, options, totals)
    }
  }

  const workerCount = Math.min(options.concurrency, gameRefs.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => await migrateNextGame())
  )

  const bytesSaved = Math.max(0, totals.rawBytes - totals.compressedBytes)
  const ratio =
    totals.rawBytes > 0
      ? ((bytesSaved / totals.rawBytes) * 100).toFixed(1)
      : '0.0'

  console.log(
    `[migration/nba-event-box-scores] complete mode=${options.apply ? 'apply' : 'dry-run'} games=${totals.games} scanned=${totals.scanned} matched=${totals.matched} converted=${totals.converted} alreadyCompressed=${totals.alreadyCompressed} withoutBoxScore=${totals.withoutBoxScore} batches=${totals.batchesCommitted} rawGiB=${formatGiB(totals.rawBytes)} compressedGiB=${formatGiB(totals.compressedBytes)} savedGiB=${formatGiB(bytesSaved)} savedPercent=${ratio}`
  )
}

main()
  .catch((error) => {
    const migrationError = error as Error
    console.error(
      `[migration/nba-event-box-scores] failed reason=${migrationError.message}`
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await admin.app().delete()
  })
