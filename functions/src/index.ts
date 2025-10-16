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

exports.pushNewQuestion = onDocumentCreated(
  {
    document: 'games/{gameId}/questions/{questionId}',
    secrets: [expoAccessToken],
  },
  async (event) => {
    const { gameId, questionId } = event.params
    console.log(`Pushing new question ${questionId} for game ${gameId}`)

    const question = event.data?.data() as Question
    if (!question) {
      console.error('No data associated with the event', { event })
      return
    }

    const expo = new Expo({ accessToken: expoAccessToken.value() })

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
          if (!tokens) {
            console.error(`Failed to find any tokens for Player ${player.id}`)
            return Promise.reject(
              new Error(`Failed to find any tokens for Player ${player.id}`)
            )
          }
          console.log(`Found tokens for ${player.id}: `, tokens)
          return Promise.resolve(tokens)
        } catch (error) {
          console.error(
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
      .map((playerTokenPromiseRes) =>
        flattenObject(playerTokenPromiseRes.value)
      )

    const messages: ExpoPushMessage[] = []
    playerTokens.map(({ token }: any) => {
      if (!Expo.isExpoPushToken(token)) {
        console.error(`Push token ${token} is not a valid Expo push token`)
        return
      }

      messages.push({
        to: token,
        channelId: 'default',
        body: question.question,
        data: { gameId, questionId },
        priority: 'high',
        categoryId: 'YESNO',
      })
    })

    const chunks = expo.chunkPushNotifications(messages)
    let numSent = 0,
      numFailed = 0
    await Promise.allSettled(
      chunks.map(async (chunk) => {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk)
          numSent += chunk.length
          return Promise.resolve(ticketChunk)
        } catch (error) {
          console.error('Failed to send push notification', error)
          numFailed += chunk.length
          return Promise.reject(error)
        }
      })
    )

    console.log(
      `Successfully sent ${numSent} push notifications for question ${questionId} in game ${gameId}! Failed to send ${numFailed} push notifications.`
    )
  }
)

const getCorrectUsers = async (
  gameId: string,
  questionId: string,
  question: Question
) => {
  if (!question.closedAt) {
    console.error(
      'Trying to get get correct users but question has no closedAt timestamp'
    )
    return []
  }

  const correctPredictions = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .where('prediction', '==', question.answer)
    .where('createdAt', '<', question.closedAt)
    .get()

  console.log('Found correct users: ', correctPredictions.docs.length)

  return correctPredictions.docs.map((p) => p.id)
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
