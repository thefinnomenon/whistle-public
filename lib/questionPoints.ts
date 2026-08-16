export const getQuestionPoints = (question: { points?: number }): number =>
  typeof question.points === 'number' && question.points > 0
    ? question.points
    : 10
