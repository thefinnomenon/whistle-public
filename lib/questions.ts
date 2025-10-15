import { serverTimestamp } from '@react-native-firebase/firestore'

import { addQuestion } from './firebase'

export const createQuestionFromTrigger = async (
  gameId: string,
  trigger: string
) => {
  await addQuestion(gameId, {
    state: 'open',
    type: 'YESNO',
    question: 'Will the next play be a pass?',
    choices: ['Yes', 'No'],
    updatedAt: serverTimestamp() as any,
  })
}
