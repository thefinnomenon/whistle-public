/**
 * Resolve stale open NBA games and remove only their player-count history.
 *
 * Default mode is a dry run. Applying requires the explicit confirmation arg:
 *
 *   yarn run:prod scripts/resolveStaleNbaGamesAndDeletePlayerCounts.ts
 *   yarn run:prod scripts/resolveStaleNbaGamesAndDeletePlayerCounts.ts \
 *     --apply --confirm=resolve-stale-nba-games
 */
import { admin, db } from '../src/firebase'

const APPLY = process.argv.includes('--apply')
const CONFIRMED = process.argv.includes('--confirm=resolve-stale-nba-games')
const STALE_BEFORE_MS = Date.now() - 24 * 60 * 60 * 1000
const DELETE_CONCURRENCY = 3
const TARGET_GAME_IDS = [
  'nba_0042500127',
  'nba_0042500145',
  'nba_0042500146',
  'nba_0042500147',
  'nba_0042500156',
  'nba_0042500157',
  'nba_0042500167',
  'nba_0042500177',
  'nba_0042500215',
  'nba_0042500216',
  'nba_0042500217',
  'nba_0042500225',
  'nba_0042500226',
  'nba_0042500227',
  'nba_0042500237',
  'nba_0042500305',
  'nba_0042500306',
  'nba_0042500307',
] as const

type StaleNbaGame = {
  id: string
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
  startTimeMs: number
  playerCountHistoryDocs: number
  state: string
}

const readStartTimeMs = (
  value: admin.firestore.Timestamp | undefined
): number | null => {
  if (!value || typeof value.toMillis !== 'function') return null
  const valueMs = value.toMillis()
  return Number.isFinite(valueMs) ? valueMs : null
}

const loadStaleNbaGames = async (): Promise<StaleNbaGame[]> => {
  const refs = TARGET_GAME_IDS.map((gameId) =>
    db.collection('games').doc(gameId)
  )
  const snapshots = await db.getAll(...refs)

  const games: StaleNbaGame[] = []
  for (const snapshot of snapshots) {
    const data = snapshot.data()
    const state = typeof data?.state === 'string' ? data.state : ''
    const isResumableCleanup =
      state === 'resolved' && data?.resolutionReason === 'stale_nba_cleanup'
    if (
      !snapshot.exists ||
      data?.league !== 'NBA' ||
      (state !== 'open' && !isResumableCleanup)
    ) {
      continue
    }
    const startTimeMs = readStartTimeMs(
      data.startTime as admin.firestore.Timestamp | undefined
    )
    if (startTimeMs === null || startTimeMs >= STALE_BEFORE_MS) continue

    const countSnapshot = await snapshot.ref
      .collection('playerCounts')
      .count()
      .get()
    const playerCountHistoryDocs = countSnapshot.data().count
    if (isResumableCleanup && playerCountHistoryDocs === 0) continue
    games.push({
      id: snapshot.id,
      ref: snapshot.ref,
      startTimeMs,
      playerCountHistoryDocs,
      state,
    })
  }
  return games
}

const applyCleanup = async (games: StaleNbaGame[]): Promise<void> => {
  let nextIndex = 0
  const applyNext = async (): Promise<void> => {
    const index = nextIndex
    nextIndex += 1
    const game = games[index]
    if (!game) return

    const current = await game.ref.get()
    const data = current.data()
    const isResumableCleanup =
      data?.state === 'resolved' &&
      data?.resolutionReason === 'stale_nba_cleanup'
    if (
      !current.exists ||
      data?.league !== 'NBA' ||
      (data?.state !== 'open' && !isResumableCleanup)
    ) {
      console.warn(
        `[cleanup/stale-nba] skip game=${game.id} reason=state_changed`
      )
      await applyNext()
      return
    }

    if (data?.state === 'open') {
      await game.ref.set(
        {
          state: 'resolved',
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          resolutionReason: 'stale_nba_cleanup',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }

    await db.recursiveDelete(game.ref.collection('playerCounts'))
    console.log(
      `[cleanup/stale-nba] applied game=${game.id} index=${index + 1}/${games.length} historyDeleted=${game.playerCountHistoryDocs}`
    )
    await applyNext()
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DELETE_CONCURRENCY, games.length) },
      applyNext
    )
  )
}

const main = async (): Promise<void> => {
  if (APPLY && !CONFIRMED) {
    throw new Error('Applying requires --confirm=resolve-stale-nba-games')
  }

  const games = await loadStaleNbaGames()
  const historyDocs = games.reduce(
    (sum, game) => sum + game.playerCountHistoryDocs,
    0
  )
  console.log(
    `[cleanup/stale-nba] plan apply=${APPLY ? '1' : '0'} games=${games.length} historyDocs=${historyDocs}`
  )
  for (const game of games) {
    console.log(
      `[cleanup/stale-nba] target game=${game.id} state=${game.state} start=${new Date(game.startTimeMs).toISOString()} historyDocs=${game.playerCountHistoryDocs}`
    )
  }

  if (!APPLY) {
    console.log('[cleanup/stale-nba] dry_run complete')
    return
  }

  await applyCleanup(games)
  console.log(
    `[cleanup/stale-nba] complete games=${games.length} historyDeleted=${historyDocs}`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error('[cleanup/stale-nba] failed', error)
    process.exit(1)
  })
