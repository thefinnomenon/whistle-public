export const BASE_QUESTION_POINTS = 10

export const calculateQuestionPoints = (choiceCount: number): number => {
  if (!Number.isInteger(choiceCount) || choiceCount < 2) {
    return BASE_QUESTION_POINTS
  }
  return Math.max(BASE_QUESTION_POINTS, choiceCount * 5)
}

export const getStoredQuestionPoints = (question: {
  points?: number
}): number => {
  if (
    typeof question.points === 'number' &&
    Number.isInteger(question.points) &&
    question.points > 0
  ) {
    return question.points
  }
  return BASE_QUESTION_POINTS
}

export const calculateQuestionScoreUpdate = (
  currentScore: number,
  previousAward: number,
  desiredAward: number
): { changed: boolean; score: number } => ({
  changed: previousAward !== desiredAward,
  score: Math.max(0, currentScore + desiredAward - previousAward),
})
