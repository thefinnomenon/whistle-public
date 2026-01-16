/**
 * Import game fixtures from a JSON file and create Firestore game documents.
 *
 * JSON shape:
 * {
 *   "games": [
 *     { "startUtc": "2026-01-09T00:00:00Z", "visitor": "IND", "home": "CHA" }
 *   ]
 * }
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT=... ts-node backend/scripts/importGames.ts path/to/games.json
 */
import fs from 'fs'
import path from 'path'
import { admin, db } from '../src/firebase'

type InputGame = {
  startUtc: string
  visitor: string
  home: string
}

const readJson = (filePath: string): InputGame[] => {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath)
  const raw = fs.readFileSync(absolutePath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed?.games || !Array.isArray(parsed.games)) {
    throw new Error('JSON must contain a "games" array')
  }
  return parsed.games
}

const toDate = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid startUtc: ${iso}`)
  }
  return d
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error(
      'Usage: ts-node backend/scripts/importGames.ts <path-to-json>'
    )
    process.exit(1)
  }

  const items = readJson(filePath)
  console.log(`Importing ${items.length} games from ${filePath}`)

  for (const item of items) {
    const { startUtc, visitor, home } = item as InputGame
    if (!startUtc || !visitor || !home) {
      console.warn('Skipping invalid item', item)
      continue
    }

    const startTime = admin.firestore.Timestamp.fromDate(toDate(startUtc))
    const payload = {
      state: 'scheduled',
      prizeAmount: 0,
      prizeType: 'POINTS',
      homeTeam: home,
      awayTeam: visitor,
      sport: 'BASKETBALL',
      league: 'NBA',
      playerCount: 0,
      leaderboard: [],
      startTime,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    const docRef = db.collection('games').doc()
    await docRef.set(payload)
    console.log(
      `Created game ${docRef.id}: ${visitor} @ ${home} ${startTime.toDate().toISOString()}`
    )
  }

  console.log('Done.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
