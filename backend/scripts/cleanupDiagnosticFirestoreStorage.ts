/**
 * One-off cleanup for bulky diagnostic Firestore data.
 *
 * Default mode is dry-run (no writes).
 *
 * Usage:
 *   yarn run:prod scripts/cleanupDiagnosticFirestoreStorage.ts
 *   yarn run:prod scripts/cleanupDiagnosticFirestoreStorage.ts --apply
 *   yarn run:prod scripts/cleanupDiagnosticFirestoreStorage.ts --apply --skip-official-cumulative
 */
import { admin, db } from '../src/firebase'

type CleanupOptions = {
  apply: boolean
  pageSize: number
  maxDocs: number | null
  includeRawEvents: boolean
  includeBoxScoreSnapshots: boolean
  includeEntitySportShadow: boolean
  includeOfficialCumulative: boolean
}

type CleanupResult = {
  label: string
  action: 'delete' | 'update'
  matched: number
  applied: number
  batchesCommitted: number
}

type FirestoreErrorLike = Error & {
  code?: number | string
  details?: string
}

type GameRef =
  FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>

const DEFAULT_PAGE_SIZE = 250
const MAX_PAGE_SIZE = 450
const MAX_COMMIT_ATTEMPTS = 8

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })

const isRetryableCommitError = (error: FirestoreErrorLike): boolean => {
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

  const message = error.message || ''
  const details = error.details || ''
  return (
    message.includes('DEADLINE_EXCEEDED') ||
    message.includes('Deadline exceeded') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('UNAVAILABLE') ||
    details.includes('DEADLINE_EXCEEDED') ||
    details.includes('Deadline exceeded') ||
    details.includes('RESOURCE_EXHAUSTED') ||
    details.includes('UNAVAILABLE')
  )
}

const commitBatchWithRetry = async (
  batch: FirebaseFirestore.WriteBatch,
  label: string,
  action: CleanupResult['action']
): Promise<number> => {
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      await batch.commit()
      return attempt
    } catch (error) {
      const commitError = error as FirestoreErrorLike
      if (
        attempt === MAX_COMMIT_ATTEMPTS ||
        !isRetryableCommitError(commitError)
      ) {
        throw commitError
      }

      const delayMs = 500 * 2 ** (attempt - 1)
      console.warn(
        `[cleanup/diagnostic-storage] retry label=${label} action=${action} attempt=${attempt} delayMs=${delayMs} reason=${commitError.code ?? commitError.message}`
      )
      await sleep(delayMs)
    }
  }

  return MAX_COMMIT_ATTEMPTS
}

const getQueryPageWithRetry = async (
  query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
  label: string,
  action: CleanupResult['action']
): Promise<FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>> => {
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      return await query.get()
    } catch (error) {
      const queryError = error as FirestoreErrorLike
      if (
        attempt === MAX_COMMIT_ATTEMPTS ||
        !isRetryableCommitError(queryError)
      ) {
        throw queryError
      }

      const delayMs = 500 * 2 ** (attempt - 1)
      console.warn(
        `[cleanup/diagnostic-storage] retry label=${label} action=${action} phase=query attempt=${attempt} delayMs=${delayMs} reason=${queryError.code ?? queryError.message}`
      )
      await sleep(delayMs)
    }
  }

  throw new Error(`Query failed after retries: ${label}`)
}

const parsePositiveIntegerArg = (
  argv: string[],
  name: string,
  fallback: number,
  maxValue: number
): number => {
  const prefix = `--${name}=`
  const arg = argv.find((value) => value.startsWith(prefix))
  if (!arg) return fallback

  const rawValue = arg.slice(prefix.length)
  const parsed = Number(rawValue)
  if (Number.isInteger(parsed) && parsed > 0) {
    return Math.min(parsed, maxValue)
  }

  console.warn(
    `[cleanup/diagnostic-storage] invalid_number arg=${name} value=${rawValue} fallback=${fallback}`
  )
  return fallback
}

const parseOptionalPositiveIntegerArg = (
  argv: string[],
  name: string
): number | null => {
  const prefix = `--${name}=`
  const arg = argv.find((value) => value.startsWith(prefix))
  if (!arg) return null

  const rawValue = arg.slice(prefix.length)
  const parsed = Number(rawValue)
  if (Number.isInteger(parsed) && parsed > 0) return parsed

  console.warn(
    `[cleanup/diagnostic-storage] invalid_number arg=${name} value=${rawValue} ignored=1`
  )
  return null
}

const parseOptions = (argv: string[]): CleanupOptions => ({
  apply: argv.includes('--apply'),
  pageSize: parsePositiveIntegerArg(
    argv,
    'page-size',
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  ),
  maxDocs: parseOptionalPositiveIntegerArg(argv, 'max-docs'),
  includeRawEvents: !argv.includes('--skip-raw-events'),
  includeBoxScoreSnapshots: !argv.includes('--skip-box-score-snapshots'),
  includeEntitySportShadow: !argv.includes('--skip-entitysport-shadow'),
  includeOfficialCumulative: !argv.includes('--skip-official-cumulative'),
})

const limitedPageSize = (
  pageSize: number,
  applied: number,
  maxDocs: number | null
): number => {
  if (maxDocs === null) return pageSize
  return Math.min(pageSize, Math.max(0, maxDocs - applied))
}

const countQuery = async (
  query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>
): Promise<number> => {
  const snap = await query.count().get()
  return snap.data().count
}

const loadGameRefs = async (): Promise<GameRef[]> => {
  const snap = await db.collection('games').select().get()
  return snap.docs.map((doc) => doc.ref)
}

const countGameSubcollectionDocs = async (
  gameRefs: GameRef[],
  collectionName: string
): Promise<number> => {
  let total = 0
  for (const gameRef of gameRefs) {
    total += await countQuery(gameRef.collection(collectionName))
  }
  return total
}

const deleteGameSubcollectionDocs = async (
  label: string,
  collectionName: string,
  gameRefs: GameRef[],
  options: CleanupOptions
): Promise<CleanupResult> => {
  if (!options.apply) {
    const matched = await countGameSubcollectionDocs(gameRefs, collectionName)
    console.log(
      `[cleanup/diagnostic-storage] dry_run label=${label} action=delete matched=${matched}`
    )
    return {
      label,
      action: 'delete',
      matched,
      applied: 0,
      batchesCommitted: 0,
    }
  }

  let applied = 0
  let batchesCommitted = 0

  for (const gameRef of gameRefs) {
    while (true) {
      const pageSize = limitedPageSize(
        options.pageSize,
        applied,
        options.maxDocs
      )
      if (pageSize <= 0) break

      const query = gameRef.collection(collectionName).limit(pageSize).select()
      const snap = await getQueryPageWithRetry(query, label, 'delete')
      if (snap.empty) break

      const batch = db.batch()
      for (const doc of snap.docs) {
        batch.delete(doc.ref)
      }
      const attempts = await commitBatchWithRetry(batch, label, 'delete')

      applied += snap.size
      batchesCommitted += 1
      if (attempts > 1 || batchesCommitted % 25 === 0 || snap.size < pageSize) {
        console.log(
          `[cleanup/diagnostic-storage] progress label=${label} action=delete applied=${applied} game=${gameRef.id} lastBatch=${snap.size} batches=${batchesCommitted} attempts=${attempts}`
        )
      }

      if (snap.size < pageSize) break
    }

    if (options.maxDocs !== null && applied >= options.maxDocs) break
  }

  return {
    label,
    action: 'delete',
    matched: applied,
    applied,
    batchesCommitted,
  }
}

const clearOfficialCumulativeStats = async (
  gameRefs: GameRef[],
  options: CleanupOptions
): Promise<CleanupResult> => {
  if (!options.apply) {
    const matched = await countGameSubcollectionDocs(gameRefs, 'events')
    console.log(
      `[cleanup/diagnostic-storage] dry_run label=events.context.officialCumulativeStats action=update candidateEvents=${matched}`
    )
    return {
      label: 'events.context.officialCumulativeStats',
      action: 'update',
      matched,
      applied: 0,
      batchesCommitted: 0,
    }
  }

  let applied = 0
  let batchesCommitted = 0
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData> | null =
    null
  const updateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> =
    {
      'context.officialCumulativeStats': admin.firestore.FieldValue.delete(),
    }

  for (const gameRef of gameRefs) {
    lastDoc = null

    while (true) {
      const pageSize = limitedPageSize(
        options.pageSize,
        applied,
        options.maxDocs
      )
      if (pageSize <= 0) break

      const orderedQuery = gameRef
        .collection('events')
        .orderBy(admin.firestore.FieldPath.documentId())
      const pageQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> =
        lastDoc
          ? orderedQuery.startAfter(lastDoc).limit(pageSize).select()
          : orderedQuery.limit(pageSize).select()
      const snap = await getQueryPageWithRetry(
        pageQuery,
        'events.context.officialCumulativeStats',
        'update'
      )
      if (snap.empty) break

      const batch = db.batch()
      for (const doc of snap.docs) {
        batch.update(doc.ref, updateData)
      }
      const attempts = await commitBatchWithRetry(
        batch,
        'events.context.officialCumulativeStats',
        'update'
      )

      applied += snap.size
      batchesCommitted += 1
      lastDoc = snap.docs[snap.docs.length - 1] ?? lastDoc
      if (attempts > 1 || batchesCommitted % 25 === 0 || snap.size < pageSize) {
        console.log(
          `[cleanup/diagnostic-storage] progress label=events.context.officialCumulativeStats action=update candidateEvents=${applied} game=${gameRef.id} lastBatch=${snap.size} batches=${batchesCommitted} attempts=${attempts}`
        )
      }

      if (snap.size < pageSize) break
    }

    if (options.maxDocs !== null && applied >= options.maxDocs) break
  }

  return {
    label: 'events.context.officialCumulativeStats',
    action: 'update',
    matched: applied,
    applied,
    batchesCommitted,
  }
}

const logSummary = (results: CleanupResult[], apply: boolean) => {
  const matched = results.reduce((sum, result) => sum + result.matched, 0)
  const applied = results.reduce((sum, result) => sum + result.applied, 0)
  const batches = results.reduce(
    (sum, result) => sum + result.batchesCommitted,
    0
  )

  for (const result of results) {
    console.log(
      `[cleanup/diagnostic-storage] result label=${result.label} action=${result.action} matched=${result.matched} applied=${result.applied} batches=${result.batchesCommitted}`
    )
  }

  console.log(
    `[cleanup/diagnostic-storage] complete apply=${apply ? '1' : '0'} matched=${matched} applied=${applied} batches=${batches}`
  )
}

const main = async () => {
  const options = parseOptions(process.argv.slice(2))
  console.log(
    `[cleanup/diagnostic-storage] start apply=${options.apply ? '1' : '0'} pageSize=${options.pageSize} maxDocs=${options.maxDocs ?? 'none'}`
  )

  const results: CleanupResult[] = []
  const gameRefs = await loadGameRefs()
  console.log(`[cleanup/diagnostic-storage] games=${gameRefs.length}`)

  if (options.includeRawEvents) {
    results.push(
      await deleteGameSubcollectionDocs(
        'rawEvents',
        'rawEvents',
        gameRefs,
        options
      )
    )
  }

  if (options.includeBoxScoreSnapshots) {
    results.push(
      await deleteGameSubcollectionDocs(
        'boxScoreSnapshots',
        'boxScoreSnapshots',
        gameRefs,
        options
      )
    )
  }

  if (options.includeEntitySportShadow) {
    results.push(
      await deleteGameSubcollectionDocs(
        'entitySportShadow',
        'entitySportShadow',
        gameRefs,
        options
      )
    )
  }

  if (options.includeOfficialCumulative) {
    results.push(await clearOfficialCumulativeStats(gameRefs, options))
  }

  logSummary(results, options.apply)
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error('[cleanup/diagnostic-storage] failed', error)
    process.exit(1)
  })
