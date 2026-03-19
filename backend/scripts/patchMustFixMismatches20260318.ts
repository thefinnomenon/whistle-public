import { admin, db } from '../src/firebase'

type FixRow = {
  gameId: string
  questionId: string
  answer: string
}

const FIXES: FixRow[] = [
  {
    gameId: 'nba_0022501007',
    questionId: 'lerk5AC75Jz6dfqrhHS0',
    answer: 'yes',
  },
  {
    gameId: 'nba_0022501007',
    questionId: 'rhbyk65FXS4wv2pRqGiI',
    answer: 'no',
  },
  {
    gameId: 'nba_0022501006',
    questionId: 'e3COL4TyotIIFHaFzNip',
    answer: 'no',
  },
  {
    gameId: 'nba_0022500651',
    questionId: 'u8gtVyLKVpjT1R2o5Bgg',
    answer: 'no',
  },
  {
    gameId: 'nba_0022501004',
    questionId: 'K1jtxbB0Wmk9YabZ5qIo',
    answer: 'no',
  },
  {
    gameId: 'nba_0022501002',
    questionId: 'YhsQftKaeKmG3VsAkGml',
    answer: 'no',
  },
  {
    gameId: 'nba_0022500999',
    questionId: 'hFrKre4Zw5HCEf4zVkuU',
    answer: 'yes',
  },
]

const main = async () => {
  let patched = 0
  for (const row of FIXES) {
    const ref = db
      .collection('games')
      .doc(row.gameId)
      .collection('questions')
      .doc(row.questionId)

    await ref.set(
      {
        state: 'resolved',
        answer: row.answer,
        cancelReason: admin.firestore.FieldValue.delete(),
        closedAt: admin.firestore.FieldValue.delete(),
        resolutionPatchTag: 'confidence_audit_2026_03_18',
        resolutionPatchAppliedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    patched += 1
    console.log(
      `[patch-must-fix-2026-03-18] patched game=${row.gameId} question=${row.questionId} answer=${row.answer}`
    )
  }

  console.log(`[patch-must-fix-2026-03-18] done patched=${patched}`)
}

main().catch((error: Error) => {
  console.error('[patch-must-fix-2026-03-18] error', error)
  process.exit(1)
})
