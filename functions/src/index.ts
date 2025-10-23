import { createHash } from 'crypto'
import type { ExpoPushMessage } from 'expo-server-sdk'
import { Expo } from 'expo-server-sdk'
import admin from 'firebase-admin'
import { defineSecret } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'
import {
  onDocumentCreated,
  onDocumentUpdated,
} from 'firebase-functions/v2/firestore'
import { onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

const expoAccessToken = defineSecret('EXPO_ACCESS_TOKEN')

setGlobalOptions({ region: 'us-east1' })

admin.initializeApp()

// https://stackoverflow.com/a/55251598/6775987
const flattenObject = (obj: any) => {
  const flattened: { [key: string]: any } = {}
  if (!obj) return flattened

  Object.keys(obj).forEach((key) => {
    const value = obj[key]

    // Skip flattening updatedAt since it's a Firestore Timestamp
    if (key === 'updatedAt') {
      flattened[key] = value // keep it unflattened
      return // continue to next key
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value))
    } else {
      flattened[key] = value
    }
  })

  return flattened
}

// Test function to send a notification to the app_notifications topic
exports.testPushNotification = onCall(async (request) => {
  const topic = 'app_notifications'

  try {
    console.log('[Test] Sending test notification to topic:', topic)
    console.log('[Test] Request auth:', request.auth)

    const message = {
      topic,
      notification: {
        title: '🧪 Test Notification',
        body: 'This is a test push notification!',
      },
      android: {
        priority: 'high' as const,
        notification: {
          channelId: 'default',
          priority: 'high' as const,
          sound: 'whistle',
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '🧪 Test Notification',
              body: 'This is a test push notification!',
            },
            contentAvailable: true,
            sound: 'whistle.wav',
          },
        },
      },
    }

    console.log('[Test] Message to send:', JSON.stringify(message, null, 2))

    const response = await admin.messaging().send(message)
    console.log(
      '[Test] Successfully sent test notification. Message ID:',
      response
    )

    return { success: true, messageId: response }
  } catch (error) {
    console.error('[Test] Failed to send test notification:', error)
    throw error
  }
})

// Send notification to game topic when game starts (state changes to "open")
exports.notifyGameStart = onDocumentUpdated('games/{gameId}', async (event) => {
  const { gameId } = event.params
  const game = event.data?.after.data() as Game
  const oldGame = event.data?.before.data() as Game

  if (!game || !oldGame) {
    console.error('No data associated with event', { event })
    return
  }

  // Check if game state changed to "open"
  if (game.state === 'open' && oldGame.state !== 'open') {
    console.log(`Game ${gameId} started, notifying all app users`)

    const topic = 'app_notifications'

    try {
      // Send FCM message to main app topic
      const message = {
        topic,
        notification: {
          title: '🏈 Game Started!',
          body: `${game.homeTeam} vs ${game.awayTeam} is now live. Get ready to predict!`,
        },
        data: {
          gameId,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
        },
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'default',
            priority: 'high' as const,
            sound: 'whistle',
          },
        },
        apns: {
          payload: {
            aps: {
              contentAvailable: true,
              sound: 'whistle.wav',
            },
          },
        },
      }

      const response = await admin.messaging().send(message)
      console.log(
        `Successfully sent game start notification to topic ${topic}:`,
        response
      )
    } catch (error) {
      console.error(
        `Failed to send game start notification to topic ${topic}:`,
        error
      )
    }
  }
})

// Send notification to game topic when new question is created
exports.pushNewQuestion = onDocumentCreated(
  {
    document: 'games/{gameId}/questions/{questionId}',
    secrets: [expoAccessToken],
  },
  async (event) => {
    const { gameId, questionId } = event.params
    console.log(`Pushing new question ${questionId} for game ${gameId}`)

    const question = event.data?.data() as Question
    if (!question || !event.data) {
      console.error('No data associated with the event', { event })
      return
    }

    const topic = `game_${gameId}`

    try {
      // Capture sentAt BEFORE sending to get accurate timing
      const sentAt = Date.now()

      // Send data-only FCM message to topic (so background handler can add action buttons)
      const message = {
        topic,
        data: {
          gameId,
          questionId,
          question: question.question,
          title: '🏈 New Question!',
          body: question.question,
          triggeredAt: question.triggeredAt?.toMillis().toString() || '',
          createdAt: event.data.createTime.toMillis().toString(),
          sentAt: sentAt.toString(),
        },
        android: {
          priority: 'high' as const,
        },
        apns: {
          payload: {
            aps: {
              contentAvailable: true,
              sound: 'whistle.wav',
            },
          },
          headers: {
            'apns-priority': '10',
          },
        },
      }

      const response = await admin.messaging().send(message)
      console.log(`Successfully sent notification to topic ${topic}:`, response)
    } catch (error) {
      console.error(`Failed to send notification to topic ${topic}:`, error)
    }
  }
)

const getCorrectUsers = async (
  gameId: string,
  questionId: string,
  question: Question
) => {
  if (!question.closedAt) {
    console.error(
      'Trying to get correct users but question has no closedAt timestamp'
    )
    return []
  }

  console.log(
    '[getCorrectUsers] Question answer:',
    question.answer,
    typeof question.answer
  )
  console.log('[getCorrectUsers] Question closedAt:', question.closedAt)

  // Get all predictions that match the answer
  const allPredictions = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .where('prediction', '==', question.answer)
    .get()

  console.log(
    '[getCorrectUsers] All matching predictions:',
    allPredictions.docs.length
  )

  // Filter by document createTime (metadata) to ensure prediction was made before question closed
  const correctPredictions = allPredictions.docs.filter((doc) => {
    const createTime = doc.createTime?.toDate()
    const closedAt = question.closedAt?.toDate()
    const isBeforeClose = createTime && closedAt && createTime < closedAt

    console.log(`[getCorrectUsers] Prediction ${doc.id}:`, {
      prediction: doc.data().prediction,
      createTime: createTime?.toISOString(),
      closedAt: closedAt?.toISOString(),
      isBeforeClose,
    })

    return isBeforeClose
  })

  console.log(
    '[getCorrectUsers] Found correct users (before close):',
    correctPredictions.length
  )

  return correctPredictions.map((p) => p.id)
}

const updateScores = async (
  gameId: string,
  questionId: string,
  users: string[],
  value: number
) => {
  // Firestore batch limit is 500 operations
  const BATCH_SIZE = 500
  const batches = []

  console.log(
    `${value > 0 ? 'In' : 'De'}crementing score for ${users.length} users`
  )

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = admin.firestore().batch()
    const batchUsers = users.slice(i, i + BATCH_SIZE)

    batchUsers.forEach((user) => {
      const userRef = admin.firestore().doc(`games/${gameId}/users/${user}`)
      batch.update(userRef, {
        score: admin.firestore.FieldValue.increment(value),
      })
    })

    batches.push(batch.commit())
  }

  return await Promise.allSettled(batches)
}

type LeaderboardDoc =
  admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>[]
const calculatePlaces = (leaderboardDocs: LeaderboardDoc) => {
  console.log('Calculating places...')
  let currentScore = -1
  let currentPlace = 0
  const numOfPeopleInPlace = [0]

  const places = leaderboardDocs.map((userData) => {
    if (userData.data().score !== currentScore) {
      currentScore = userData.data().score
      numOfPeopleInPlace[currentPlace] = numOfPeopleInPlace[currentPlace] + 1
      currentPlace++
      numOfPeopleInPlace.push(0)
    } else {
      numOfPeopleInPlace[currentPlace] = numOfPeopleInPlace[currentPlace] + 1
    }

    return currentPlace
  })

  return places
}

exports.calculateScores = onDocumentUpdated(
  'games/{gameId}/questions/{questionId}',
  async (event) => {
    const { gameId, questionId } = event.params
    const question = event.data?.after.data() as Question
    const oldQuestion = event.data?.before.data() as Question

    if (!question || !oldQuestion) {
      console.error('No data associated with event', { event })
      return
    }

    console.log(`Update for question (${questionId}) in game ${gameId}`, {
      state: question.state,
    })

    // Ignore if question was closed
    if (question.state === 'closed') {
      console.log('Question was closed! Skipping updates...')
      return
    }

    // Question was resolved -> Update scores
    if (question.state === 'resolved' && oldQuestion.state !== 'resolved') {
      console.log('Question was resolved! Updating scores...')
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
      if (correctUsers.length === 0) return
      await updateScores(gameId, questionId, correctUsers, 1)
    }

    // Question cancelled after being resolved -> Revert scores
    if (question.state === 'cancelled' && oldQuestion.state === 'resolved') {
      console.log('Question was cancelled! Reverting scores...')
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
      if (correctUsers.length === 0) return
      await updateScores(gameId, questionId, correctUsers, -1)
    }

    // Question answer changes -> Revert and update scores
    if (
      question.answer &&
      oldQuestion.answer &&
      question.answer !== oldQuestion.answer
    ) {
      console.log(
        'Question answer was changed! Reverting and updating scores...'
      )
      const [oldCorrectUsers, correctUsers] = await Promise.all([
        getCorrectUsers(gameId, questionId, oldQuestion),
        getCorrectUsers(gameId, questionId, question),
      ])

      if (oldCorrectUsers.length === 0 && correctUsers.length === 0) return

      await Promise.all([
        updateScores(gameId, questionId, oldCorrectUsers, -1),
        updateScores(gameId, questionId, correctUsers, 1),
      ])
    }

    // Retrieve top 100 users (sorted by score desc, then username asc for stable tie-breaking)
    const leaderboardQueryRes = await admin
      .firestore()
      .collection(`games/${gameId}/users`)
      .orderBy('score', 'desc')
      .orderBy('username', 'asc')
      .limit(100)
      .get()

    // Calculate places
    const places = calculatePlaces(leaderboardQueryRes.docs)

    // Build new leaderboard
    const newLeaderboard = leaderboardQueryRes.docs.map((doc, index) => ({
      place: places[index],
      userId: doc.id,
      ...doc.data(),
    }))

    // Calculate hash of new leaderboard
    const newLeaderboardHash = createHash('sha256')
      .update(JSON.stringify(newLeaderboard))
      .digest('hex')

    // Get current game to compare leaderboard hash
    const gameDoc = await admin.firestore().doc(`games/${gameId}`).get()
    const currentLeaderboardHash = gameDoc.data()?.leaderboardHash

    // Only update if leaderboard changed
    if (currentLeaderboardHash !== newLeaderboardHash) {
      console.log('Leaderboard changed, updating...')
      await admin.firestore().doc(`games/${gameId}`).update({
        leaderboard: newLeaderboard,
        leaderboardHash: newLeaderboardHash,
      })
    } else {
      console.log('Leaderboard unchanged, skipping update')
    }
  }
)

// TODO: Save on invocations by scheduling this specifically during game hours on game days
exports.updatePlayerCountForGames = onSchedule('every 1 minutes', async () => {
  console.log('Updating game user counts for open and scheduled games!')

  const [scheduledGames, openGames] = await Promise.all([
    admin
      .firestore()
      .collection('games')
      .where('state', '==', 'scheduled')
      .get(),
    admin.firestore().collection('games').where('state', '==', 'open').get(),
  ])

  const games = scheduledGames.docs.concat(openGames.docs)

  await Promise.all(
    games.map(async (game) => {
      console.log(`Getting count for game ${game.id}`)
      const { count } = (
        await admin
          .firestore()
          .collection(`games/${game.id}/users`)
          .count()
          .get()
      ).data()

      const currentCount = game.data().userCount

      if (currentCount !== count) {
        console.log(
          `Updating count from ${currentCount} to ${count} for game ${game.id}`
        )
        await admin.firestore().doc(`games/${game.id}`).update({
          userCount: count,
        })
      } else {
        console.log(
          `Count unchanged (${count}) for game ${game.id}, skipping update`
        )
      }
    })
  )
})

exports.handleGameEnd = onDocumentUpdated(
  { document: 'games/{gameId}', secrets: [expoAccessToken] },
  async (event) => {
    const { gameId } = event.params
    const game = event.data?.after.data() as Game
    const oldGame = event.data?.before.data() as Game

    if (!game || !oldGame) {
      console.error('No data associated with event', { event })
      return
    }

    if (game.state === 'resolved' && oldGame.state !== 'resolved') {
      console.log(`Game ${gameId} resolved.`)

      const expo = new Expo({ accessToken: expoAccessToken.value() })

      // Calculate and distribute winnings
      const winnerNotifications = await distributeWinnings(gameId, game)

      // Notify winners
      await notifyWinners(winnerNotifications, game, expo)

      // Send end of game notification to all players
      const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing!`
      await sendNotificationsToGameUsers(expo, gameId, message)
    }
  }
)

const distributeWinnings = async (
  gameId: string,
  game: Game
): Promise<{ userId: string; amount: number }[]> => {
  console.log('Calculating winnings for game', gameId)

  if (!game.leaderboard || game.leaderboard.length === 0) {
    console.log('No leaderboard to distribute winnings from')
    return []
  }

  // Get the top score
  const topScore = game.leaderboard[0].score

  // Query ALL users with the top score (these are all first place winners)
  const winnerDocs = await admin
    .firestore()
    .collection(`games/${gameId}/users`)
    .where('score', '==', topScore)
    .get()

  if (winnerDocs.empty) {
    console.log('No winners found')
    return []
  }

  const numWinners = winnerDocs.size
  const prizePerWinner = game.prize / numWinners

  console.log(
    `Distributing $${game.prize} to ${numWinners} first place winner(s) with score ${topScore}: $${prizePerWinner.toFixed(2)} each`
  )

  // Update winnings for each winner (batch write)
  const batch = admin.firestore().batch()
  const winnerNotifications: { userId: string; amount: number }[] = []

  winnerDocs.docs.forEach((winnerDoc) => {
    const userId = winnerDoc.id
    const userRef = admin.firestore().doc(`users/${userId}`)

    // Increment winnings
    batch.update(userRef, {
      winnings: admin.firestore.FieldValue.increment(prizePerWinner),
    })

    winnerNotifications.push({ userId, amount: prizePerWinner })
  })

  await batch.commit()
  console.log('Winnings distributed successfully')

  return winnerNotifications
}

const notifyWinners = async (
  winnerNotifications: { userId: string; amount: number }[],
  game: Game,
  expo: Expo
) => {
  if (winnerNotifications.length === 0) {
    console.log('No winners to notify...')
    return
  }

  console.log(`Notifying ${winnerNotifications.length} winners`)

  await Promise.all(
    winnerNotifications.map(async ({ userId, amount }) => {
      const userData = (
        await admin.firestore().collection('users').doc(userId).get()
      ).data() as { tokens?: { [tokenId: string]: Token } }

      if (!userData?.tokens) {
        console.error(`No tokens found for user ${userId}`)
        return
      }

      const tokens = Object.values(userData.tokens)
      const messages: any[] = []

      tokens.forEach(({ token }) => {
        if (!Expo.isExpoPushToken(token)) {
          console.error(`Invalid push token for user ${userId}`)
          return
        }

        messages.push({
          to: token,
          sound: 'default',
          title: '🎉 You Won!',
          body: `Congratulations! You won $${amount.toFixed(2)} in ${game.homeTeam} vs. ${game.awayTeam}!`,
          data: { gameId: game.id, winnings: amount },
          priority: 'high',
        })
      })

      if (messages.length > 0) {
        const chunks = expo.chunkPushNotifications(messages)
        await Promise.allSettled(
          chunks.map((chunk) => expo.sendPushNotificationsAsync(chunk))
        )
      }
    })
  )
}

const sendNotificationsToGameUsers = async (
  expo: Expo,
  gameId: string,
  message: string
) => {
  const players = await admin
    .firestore()
    .collection(`games/${gameId}/users`)
    .get()
  const playerTokensPromisesRes = await Promise.allSettled(
    players.docs.map(async (player) => {
      try {
        const { tokens } = (
          await admin.firestore().collection('users').doc(player.id).get()
        ).data() as { tokens: { [tokenId: string]: Token } }
        return Promise.resolve(tokens)
      } catch (error) {
        console.debug(
          `Failed to retrieve document for user ${player.id}: `,
          error
        )
        return Promise.reject(error)
      }
    })
  )

  const playerTokens = playerTokensPromisesRes
    .filter(
      (
        playerTokenPromiseRes
      ): playerTokenPromiseRes is PromiseFulfilledResult<{
        [tokenId: string]: Token
      }> => playerTokenPromiseRes.status === 'fulfilled'
    )
    .map((playerTokenPromiseRes) => flattenObject(playerTokenPromiseRes.value))

  const messages: ExpoPushMessage[] = []
  playerTokens.map(({ token }: any) => {
    if (!Expo.isExpoPushToken(token)) {
      console.error(`Push token ${token} is not a valid Expo push token`)
      return
    }

    messages.push({
      to: token,
      sound: 'default',
      body: message,
      data: { gameId },
      priority: 'high',
      /* @ts-expect-error missing in types but needed to trigger background handler */
      _contentAvailable: true,
    })
  })

  const chunks = expo.chunkPushNotifications(messages)
  await Promise.allSettled(
    chunks.map(async (chunk) => {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk)
        return Promise.resolve(ticketChunk)
      } catch (error) {
        console.error('Failed to send push notification', error)
        return Promise.reject(error)
      }
    })
  )
}
