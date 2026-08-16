import assert from 'node:assert/strict'
import {
  calculateQuestionPoints,
  calculateQuestionScoreUpdate,
  getStoredQuestionPoints,
} from '../src/lib/questionPoints'

assert.equal(calculateQuestionPoints(2), 10)
assert.equal(calculateQuestionPoints(3), 15)
assert.equal(calculateQuestionPoints(4), 20)
assert.equal(calculateQuestionPoints(5), 25)
assert.equal(calculateQuestionPoints(1), 10)
assert.equal(getStoredQuestionPoints({ points: 20 }), 20)
assert.equal(getStoredQuestionPoints({}), 10)

assert.deepEqual(calculateQuestionScoreUpdate(0, 0, 20), {
  changed: true,
  score: 20,
})
assert.deepEqual(calculateQuestionScoreUpdate(20, 20, 20), {
  changed: false,
  score: 20,
})
assert.deepEqual(calculateQuestionScoreUpdate(20, 20, 0), {
  changed: true,
  score: 0,
})
assert.deepEqual(calculateQuestionScoreUpdate(30, 20, 10), {
  changed: true,
  score: 20,
})

console.log('[test-question-points] all assertions passed')
