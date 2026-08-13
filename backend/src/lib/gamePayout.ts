export const CASH_ELIGIBILITY_MIN_ANSWERS = 5
export const CASH_ELIGIBILITY_MIN_RATE = 0.5

export type CashEligibilityReason =
  | 'qualified'
  | 'missing_join_time'
  | 'minimum_answers'
  | 'answer_rate'

export type CashEligibilityMember = {
  userId: string
  score: number
  joinedAtMs: number | null
  predictionsByQuestionId: Record<string, string>
}

export type CashEligibilityQuestion = {
  id: string
  state: string
  triggeredAtMs: number | null
}

export type CashEligibilityResult = {
  userId: string
  score: number
  answered: number
  offered: number
  requiredAnswers: number
  answerRate: number
  qualified: boolean
  reason: CashEligibilityReason
}

export type PayoutPlanItem = {
  userId: string
  amountUnits: number
}

export type PayoutPlan = {
  topScore: number | null
  totalUnits: number
  winners: PayoutPlanItem[]
}

const countRequiredAnswers = (offered: number): number =>
  Math.max(
    CASH_ELIGIBILITY_MIN_ANSWERS,
    Math.ceil(offered * CASH_ELIGIBILITY_MIN_RATE)
  )

export const evaluateCashEligibility = (
  members: CashEligibilityMember[],
  questions: CashEligibilityQuestion[]
): CashEligibilityResult[] =>
  members.map((member) => {
    if (member.joinedAtMs === null) {
      return {
        userId: member.userId,
        score: member.score,
        answered: 0,
        offered: 0,
        requiredAnswers: CASH_ELIGIBILITY_MIN_ANSWERS,
        answerRate: 0,
        qualified: false,
        reason: 'missing_join_time',
      }
    }

    const offeredQuestionIds = questions
      .filter(
        (question) =>
          question.state === 'resolved' &&
          question.triggeredAtMs !== null &&
          question.triggeredAtMs >= member.joinedAtMs!
      )
      .map((question) => question.id)
    const offered = offeredQuestionIds.length
    const answered = offeredQuestionIds.filter(
      (questionId) => member.predictionsByQuestionId[questionId] !== undefined
    ).length
    const answerRate = offered === 0 ? 0 : answered / offered
    const meetsMinimum = answered >= CASH_ELIGIBILITY_MIN_ANSWERS
    const meetsRate = offered > 0 && answerRate >= CASH_ELIGIBILITY_MIN_RATE
    const qualified = meetsMinimum && meetsRate

    return {
      userId: member.userId,
      score: member.score,
      answered,
      offered,
      requiredAnswers: countRequiredAnswers(offered),
      answerRate,
      qualified,
      reason: qualified
        ? 'qualified'
        : !meetsMinimum
          ? 'minimum_answers'
          : 'answer_rate',
    }
  })

export const buildPayoutPlan = (
  totalUnits: number,
  entrants: { userId: string; score: number; eligible: boolean }[]
): PayoutPlan => {
  const safeTotalUnits = Math.max(0, Math.floor(totalUnits))
  const eligibleEntrants = entrants.filter((entrant) => entrant.eligible)
  if (safeTotalUnits === 0 || eligibleEntrants.length === 0) {
    return { topScore: null, totalUnits: safeTotalUnits, winners: [] }
  }

  const topScore = Math.max(...eligibleEntrants.map((entrant) => entrant.score))
  const winnerIds = eligibleEntrants
    .filter((entrant) => entrant.score === topScore)
    .map((entrant) => entrant.userId)
    .sort((left, right) => left.localeCompare(right))
  const baseAmount = Math.floor(safeTotalUnits / winnerIds.length)
  const remainder = safeTotalUnits % winnerIds.length

  return {
    topScore,
    totalUnits: safeTotalUnits,
    winners: winnerIds.map((userId, index) => ({
      userId,
      amountUnits: baseAmount + (index < remainder ? 1 : 0),
    })),
  }
}
