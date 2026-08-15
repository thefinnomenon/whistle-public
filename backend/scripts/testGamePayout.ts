import assert from 'node:assert/strict'
import {
  buildPayoutPlan,
  CASH_ELIGIBILITY_MIN_ANSWERS,
  evaluateCashEligibility,
} from '../src/lib/gamePayout'

const eligibility = evaluateCashEligibility([
  {
    userId: 'early-qualified',
    score: 40,
    predictionsByQuestionId: {
      q1: 'yes',
      q2: 'yes',
      q3: 'yes',
      q4: 'yes',
      q5: 'yes',
    },
  },
  {
    userId: 'late-qualified',
    score: 40,
    predictionsByQuestionId: {
      q5: 'yes',
      q6: 'yes',
      q7: 'yes',
      q8: 'yes',
      q9: 'yes',
    },
  },
  {
    userId: 'too-few',
    score: 60,
    predictionsByQuestionId: {
      q1: 'yes',
      q2: 'yes',
      q3: 'yes',
      q4: 'yes',
    },
  },
])

assert.equal(CASH_ELIGIBILITY_MIN_ANSWERS, 5)
assert.deepEqual(
  eligibility.map(({ userId, answered, qualified, reason }) => ({
    userId,
    answered,
    qualified,
    reason,
  })),
  [
    {
      userId: 'early-qualified',
      answered: 5,
      qualified: true,
      reason: 'qualified',
    },
    {
      userId: 'late-qualified',
      answered: 5,
      qualified: true,
      reason: 'qualified',
    },
    {
      userId: 'too-few',
      answered: 4,
      qualified: false,
      reason: 'minimum_answers',
    },
  ]
)

const payout = buildPayoutPlan(
  2_500,
  eligibility.map((entrant) => ({
    userId: entrant.userId,
    score: entrant.score,
    eligible: entrant.qualified,
  }))
)
assert.equal(payout.topScore, 40)
assert.deepEqual(payout.winners, [
  { userId: 'early-qualified', amountUnits: 1_250 },
  { userId: 'late-qualified', amountUnits: 1_250 },
])

assert.deepEqual(buildPayoutPlan(100, []), {
  topScore: null,
  totalUnits: 100,
  winners: [],
})

assert.deepEqual(
  buildPayoutPlan(2_500, [
    { userId: 'charlie', score: 10, eligible: true },
    { userId: 'alpha', score: 10, eligible: true },
    { userId: 'bravo', score: 10, eligible: true },
  ]).winners,
  [
    { userId: 'alpha', amountUnits: 834 },
    { userId: 'bravo', amountUnits: 833 },
    { userId: 'charlie', amountUnits: 833 },
  ]
)

console.log('[game-payout-test] result=pass')
