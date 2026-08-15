import assert from 'node:assert/strict'
import { db } from '../src/firebase'
import { distributeWinnings } from '../src/routes/game'

const gameId = 'payout-integration-test'
const userIds = [
  'payout-alpha',
  'payout-bravo',
  'payout-charlie',
  'payout-high',
]
const gameRef = db.collection('games').doc(gameId)

const cleanup = async (): Promise<void> => {
  await db.recursiveDelete(gameRef)
  for (const userId of userIds) {
    await db.recursiveDelete(db.collection('users').doc(userId))
  }
}

const run = async (): Promise<void> => {
  await cleanup()
  const batch = db.batch()
  batch.set(gameRef, {
    state: 'resolved',
    isFeatured: true,
    prizeType: 'USD',
    prizeAmount: 25,
    prizeAmountCents: 2_500,
  })

  for (const userId of userIds) {
    const isIneligible = userId === 'payout-high'
    batch.set(db.collection('users').doc(userId), {
      id: userId,
      ...(userId === 'payout-alpha' ? { winnings: 1 } : {}),
    })
    batch.set(gameRef.collection('users').doc(userId), {
      username: userId,
      score: isIneligible ? 100 : 50,
      predictionsByQuestionId: Object.fromEntries(
        Array.from({ length: isIneligible ? 4 : 5 }, (_, index) => [
          `q${index + 1}`,
          'yes',
        ])
      ),
    })
  }
  await batch.commit()

  const concurrentNotifications = await Promise.all([
    distributeWinnings(gameId),
    distributeWinnings(gameId),
  ])
  const firstNotifications = concurrentNotifications.flat()
  assert.equal(firstNotifications.length, 3)
  assert.equal(
    firstNotifications.reduce(
      (total, notification) => total + notification.amount,
      0
    ),
    25
  )

  const firstBalances = await Promise.all(
    userIds.map(async (userId) => {
      const snap = await db.collection('users').doc(userId).get()
      return snap.data()?.winningsCents ?? 0
    })
  )
  assert.deepEqual(firstBalances, [934, 833, 833, 0])

  const secondNotifications = await distributeWinnings(gameId)
  assert.deepEqual(secondNotifications, [])
  const secondBalances = await Promise.all(
    userIds.map(async (userId) => {
      const snap = await db.collection('users').doc(userId).get()
      return snap.data()?.winningsCents ?? 0
    })
  )
  assert.deepEqual(secondBalances, firstBalances)

  const [gameSnap, payoutSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('payouts').get(),
  ])
  assert.equal(gameSnap.data()?.payoutStatus, 'completed')
  assert.equal(gameSnap.data()?.payoutWinnerCount, 3)
  assert.deepEqual(gameSnap.data()?.cashWinnerUserIds, [
    'payout-alpha',
    'payout-bravo',
    'payout-charlie',
  ])
  assert.equal(payoutSnap.size, 3)
  console.log('[game-payout-integration-test] result=pass')
}

run()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[game-payout-integration-test] result=fail', error)
    await cleanup()
    process.exit(1)
  })
