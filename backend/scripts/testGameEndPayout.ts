import assert from 'node:assert/strict'
import { db } from '../src/firebase'
import { endGameById } from '../src/routes/game'

const gameId = 'game-end-payout-integration-test'
const userId = 'game-end-payout-integration-user'
const gameRef = db.collection('games').doc(gameId)
const userRef = db.collection('users').doc(userId)

const cleanup = async (): Promise<void> => {
  await db.recursiveDelete(gameRef)
  await db.recursiveDelete(userRef)
}

const run = async (): Promise<void> => {
  await cleanup()
  const batch = db.batch()
  batch.set(gameRef, {
    state: 'open',
    isFeatured: true,
    prizeType: 'USD',
    prizeAmount: 25,
    prizeAmountCents: 2_500,
    homeTeam: 'HOME',
    awayTeam: 'AWAY',
    playerCount: 1,
  })
  batch.set(userRef, { id: userId })
  batch.set(gameRef.collection('users').doc(userId), {
    username: userId,
    score: 20,
    predictionsByQuestionId: {
      q1: 'yes',
      q2: 'yes',
      q3: 'yes',
      q4: 'yes',
      q5: 'yes',
    },
  })
  batch.set(gameRef.collection('questions').doc('q1'), {
    state: 'resolved',
    answer: 'yes',
    statistics: {
      totalResponses: 1,
      correctCount: 1,
      incorrectCount: 0,
      responseRate: 100,
    },
  })
  await batch.commit()

  const firstResult = await endGameById(gameId)
  assert.equal(firstResult.status, 200)
  assert.equal(firstResult.alreadyResolved, false)

  const [gameSnap, payoutSnap, userSnap, playerCountsSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('payouts').doc(userId).get(),
    userRef.get(),
    gameRef.collection('playerCounts').get(),
  ])
  const game = gameSnap.data()
  assert.equal(playerCountsSnap.empty, true)
  assert.equal(game?.state, 'resolved')
  assert.equal(game?.payoutStatus, 'completed')
  assert.equal(game?.statistics?.highestPlayerCount, undefined)
  assert.equal(game?.payoutWinnerCount, 1)
  assert.equal(game?.payoutEligiblePlayerCount, 1)
  assert.equal(game?.payoutTopScore, 20)
  assert.equal(payoutSnap.data()?.amountUnits, 2_500)
  assert.equal(userSnap.data()?.winningsCents, 2_500)

  const secondResult = await endGameById(gameId)
  assert.equal(secondResult.status, 200)
  assert.equal(secondResult.alreadyResolved, true)
  assert.equal((await userRef.get()).data()?.winningsCents, 2_500)

  console.log('[game-end-payout-test] result=pass')
}

run()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[game-end-payout-test] result=fail', error)
    await cleanup()
    process.exit(1)
  })
