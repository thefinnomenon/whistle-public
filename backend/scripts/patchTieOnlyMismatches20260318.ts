import { admin, db } from '../src/firebase'

type TieFix = {
  gameId: string
  questionId: string
}

const TIE_FIXES: TieFix[] = [
  { gameId: 'nba_0022500651', questionId: 'Y4gfvOTt2EEyyIB4rkl1' },
  { gameId: 'nba_0022500651', questionId: 'vXGHrxJAvjOWyA2n2yH6' },
  { gameId: 'nba_0022501001', questionId: 'ZWJgPR1ebGvOdG69Ls2w' },
  { gameId: 'nba_0022501000', questionId: 'FDsXHYN2JV5VWER5dTzq' },
]

const main = async () => {
  let patched = 0
  for (const row of TIE_FIXES) {
    const ref = db
      .collection('games')
      .doc(row.gameId)
      .collection('questions')
      .doc(row.questionId)

    await ref.set(
      {
        state: 'cancelled',
        answer: admin.firestore.FieldValue.delete(),
        cancelReason: 'TIE',
        resolvedAt: admin.firestore.FieldValue.delete(),
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        resolutionPatchTag: 'confidence_tie_patch_2026_03_18',
        resolutionPatchAppliedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    patched += 1
    console.log(
      `[patch-tie-only-2026-03-18] patched game=${row.gameId} question=${row.questionId} state=cancelled reason=TIE`
    )
  }

  console.log(`[patch-tie-only-2026-03-18] done patched=${patched}`)
}

main().catch((error: Error) => {
  console.error('[patch-tie-only-2026-03-18] error', error)
  process.exit(1)
})
