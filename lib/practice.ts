import auth from '@react-native-firebase/auth'

import { env } from './env'

export const createPracticeQuestion = async (): Promise<{
  ok: boolean
  questionId?: string
  gameId?: string
}> => {
  const user = auth().currentUser
  if (!user) throw new Error('Not authenticated')

  const idToken = await user.getIdToken()
  const resp = await fetch(`${env.DOMAIN}/api/games/practice/question`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
  })

  const data = await resp.json()
  if (!resp.ok) {
    const err = data?.error || `Request failed with status ${resp.status}`
    throw new Error(err)
  }

  return data
}
