/**
 * One-off cleanup for NBA games with unrecognized team codes.
 *
 * Default mode is dry-run (no writes).
 *
 * Usage:
 *   yarn run:dev scripts/removeUnrecognizedNbaGames.ts
 *   yarn run:dev scripts/removeUnrecognizedNbaGames.ts --apply
 *   yarn run:dev scripts/removeUnrecognizedNbaGames.ts --apply --mode=delete
 *   yarn run:prod scripts/removeUnrecognizedNbaGames.ts --apply --mode=cancel
 */
import { admin, db } from '../src/firebase'

type CleanupMode = 'cancel' | 'delete'

type GameDoc = {
  league?: string
  state?: string
  homeTeam?: string | null
  awayTeam?: string | null
  nbaGameId?: string | null
}

type CliOptions = {
  apply: boolean
  mode: CleanupMode
}

type InvalidGame = {
  docId: string
  nbaGameId: string
  state: string
  homeTeam: string
  awayTeam: string
  reason: string
  ref: FirebaseFirestore.DocumentReference
}

const NBA_TEAM_CODES = new Set<string>([
  'ATL',
  'BOS',
  'BKN',
  'CHA',
  'CHI',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GSW',
  'HOU',
  'IND',
  'LAC',
  'LAL',
  'MEM',
  'MIA',
  'MIL',
  'MIN',
  'NOP',
  'NYK',
  'OKC',
  'ORL',
  'PHI',
  'PHX',
  'POR',
  'SAC',
  'SAS',
  'TOR',
  'UTA',
  'WAS',
])

const normalizeTeamCode = (value: string) =>
  value.trim().replace(/\s+/g, '').toUpperCase()

const parseOptions = (argv: string[]): CliOptions => {
  const apply = argv.includes('--apply')
  const modeArg = argv.find((arg) => arg.startsWith('--mode='))
  const modeValue = modeArg ? modeArg.split('=')[1] : 'cancel'
  const mode: CleanupMode = modeValue === 'delete' ? 'delete' : 'cancel'
  return { apply, mode }
}

const toText = (value: string | null | undefined) => (value ? value : '')

type TeamRecognitionReason =
  | 'recognized'
  | 'home_unrecognized'
  | 'away_unrecognized'
  | 'home_and_away_unrecognized'

const getUnrecognizedReason = (
  homeTeam: string,
  awayTeam: string
): TeamRecognitionReason => {
  const homeOk = NBA_TEAM_CODES.has(homeTeam)
  const awayOk = NBA_TEAM_CODES.has(awayTeam)
  if (homeOk && awayOk) return 'recognized'
  if (!homeOk && !awayOk) return 'home_and_away_unrecognized'
  if (!homeOk) return 'home_unrecognized'
  return 'away_unrecognized'
}

const commitInBatches = async (
  games: InvalidGame[],
  mode: CleanupMode
): Promise<void> => {
  const limit = 400
  let batch = db.batch()
  let count = 0

  for (const game of games) {
    if (mode === 'delete') {
      batch.delete(game.ref)
    } else {
      batch.set(
        game.ref,
        {
          state: 'cancelled',
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelReason: 'unrecognized_team_cleanup',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    count += 1

    if (count >= limit) {
      await batch.commit()
      batch = db.batch()
      count = 0
    }
  }

  if (count > 0) {
    await batch.commit()
  }
}

const main = async () => {
  const options = parseOptions(process.argv.slice(2))
  console.log(
    `[cleanup/unrecognized-nba] start apply=${options.apply} mode=${options.mode}`
  )

  const snap = await db.collection('games').where('league', '==', 'NBA').get()
  if (snap.empty) {
    console.log('[cleanup/unrecognized-nba] no NBA games found')
    return
  }

  const invalidGames: InvalidGame[] = []
  for (const doc of snap.docs) {
    const data = doc.data() as GameDoc
    const homeTeam = normalizeTeamCode(toText(data.homeTeam))
    const awayTeam = normalizeTeamCode(toText(data.awayTeam))
    const reason = getUnrecognizedReason(homeTeam, awayTeam)

    if (reason !== 'recognized') {
      invalidGames.push({
        docId: doc.id,
        nbaGameId: toText(data.nbaGameId),
        state: toText(data.state) || 'unknown',
        homeTeam: homeTeam || 'missing',
        awayTeam: awayTeam || 'missing',
        reason,
        ref: doc.ref,
      })
    }
  }

  console.log(
    `[cleanup/unrecognized-nba] found=${invalidGames.length} totalNbaGames=${snap.size}`
  )
  for (const game of invalidGames) {
    console.log(
      `[cleanup/unrecognized-nba] game=${game.docId} nbaGameId=${game.nbaGameId || 'missing'} state=${game.state} homeTeam=${game.homeTeam} awayTeam=${game.awayTeam} reason=${game.reason}`
    )
  }

  if (!options.apply) {
    console.log(
      '[cleanup/unrecognized-nba] dry-run complete. Re-run with --apply to execute.'
    )
    return
  }

  await commitInBatches(invalidGames, options.mode)
  console.log(
    `[cleanup/unrecognized-nba] complete action=${options.mode} count=${invalidGames.length}`
  )
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('[cleanup/unrecognized-nba] failed', err)
    process.exit(1)
  })
