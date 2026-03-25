import { Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { db } from '../firebase'
import { sendUserCreatedToSlack } from '../lib/slack'

type UserLoginMethod = 'Google' | 'Apple'

type UserRecord = {
  id: string
  email?: string
  username?: string
  loginMethod?: UserLoginMethod
  createdAt?: Timestamp
}

const USER_CREATED_SLACK_START_TS = new Date()

const toUserRecord = (doc: QueryDocumentSnapshot): UserRecord => {
  const data = doc.data()
  const createdAtValue = data.createdAt
  const createdAt =
    createdAtValue instanceof Date
      ? Timestamp.fromDate(createdAtValue)
      : createdAtValue instanceof Timestamp
        ? createdAtValue
        : undefined

  const email = typeof data.email === 'string' ? data.email : undefined
  const username = typeof data.username === 'string' ? data.username : undefined
  const loginMethod =
    data.loginMethod === 'Google' || data.loginMethod === 'Apple'
      ? data.loginMethod
      : undefined

  return {
    id: doc.id,
    email,
    username,
    loginMethod,
    createdAt,
  }
}

export const startUserCreatedSlackWorker = () => {
  console.log(
    `[worker] user created slack worker started startAt=${USER_CREATED_SLACK_START_TS.toISOString()}`
  )

  const startTimestamp = Timestamp.fromDate(USER_CREATED_SLACK_START_TS)

  db.collection('users')
    .where('createdAt', '>=', startTimestamp)
    .onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type !== 'added') return

          const user = toUserRecord(change.doc)

          if (!user.createdAt) {
            console.warn(
              `[user_created/slack] skipped reason=missing_created_at userId=${user.id}`
            )
            return
          }

          void sendUserCreatedToSlack({
            userId: user.id,
            email: user.email,
            username: user.username,
            loginMethod: user.loginMethod,
            createdAtIso: user.createdAt.toDate().toISOString(),
          })
            .then(() => {
              console.log(
                `[user_created/slack] delivered userId=${user.id} loginMethod=${user.loginMethod || 'unknown'}`
              )
            })
            .catch((error: Error) => {
              console.error(
                `[user_created/slack] failed userId=${user.id} loginMethod=${user.loginMethod || 'unknown'}`,
                error
              )
            })
        })
      },
      (error: Error) => {
        console.error('[worker] user created slack snapshot_error', error)
      }
    )
}
