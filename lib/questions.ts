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
    choices: [
      { id: 'yes', value: 'Yes' },
      { id: 'no', value: 'No' },
    ],
    timeoutAt: (Date.now() + 30 * 1000).toString(), // 30 seconds from now (ms string),
    updatedAt: serverTimestamp() as any,
  })
}
