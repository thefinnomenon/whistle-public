export const CASH_ELIGIBILITY_MIN_ANSWERS = 5

export type CashEligibilityReason = 'qualified' | 'minimum_answers'

export type CashEligibilityMember = {
  userId: string
  score: number
  predictionsByQuestionId: Record<string, string>
}

export type CashEligibilityResult = {
  userId: string
  score: number
  answered: number
  requiredAnswers: number
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

export const evaluateCashEligibility = (
  members: CashEligibilityMember[]
): CashEligibilityResult[] =>
  members.map((member) => {
    const answered = Object.keys(member.predictionsByQuestionId).length
    const qualified = answered >= CASH_ELIGIBILITY_MIN_ANSWERS

    return {
      userId: member.userId,
      score: member.score,
      answered,
      requiredAnswers: CASH_ELIGIBILITY_MIN_ANSWERS,
      qualified,
      reason: qualified ? 'qualified' : 'minimum_answers',
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
