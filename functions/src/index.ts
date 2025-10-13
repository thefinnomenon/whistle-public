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

  if (!obj) return

  Object.keys(obj).forEach((key) => {
    const value = obj[key]

    // updatedAt is a TimeStamp object so we shouldn't flatten it
    if (key === 'updatedAt') return value

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
  const correctPredictions = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .where('prediction', '==', question.answer)
    .get()

  console.log('Found correct users: ', correctPredictions.docs)

  return correctPredictions.docs
    .filter((prediction) => {
      console.log(prediction)
      console.log(
        'Filtered: ',
        question.closedAt && question.closedAt > prediction.createTime
      )
      return question.closedAt && question.closedAt > prediction.createTime
    })
    .map((p) => p.id)
}

const updateScores = async (
  gameId: string,
  questionId: string,
  users: string[],
  value: number
) => {
  return await Promise.allSettled(
    users.map(async (user) => {
      try {
        console.log(
          `${value > 0 ? 'In' : 'De'}crementing score for user ${user}`
        )
        await admin
          .firestore()
          .doc(`games/${gameId}/users/${user}`)
          .update({
            score: admin.firestore.FieldValue.increment(value),
          })
      } catch (error) {
        console.error(`Failed to increment score for user ${user}`, error)
      }
    })
  )
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
      await updateScores(gameId, questionId, correctUsers, 1)
    }

    // Question cancelled after being resolved -> Revert scores
    if (question.state === 'cancelled' && oldQuestion.state === 'resolved') {
      console.log('Question was cancelled! Reverting scores...')
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
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
      const oldCorrectUsers = await getCorrectUsers(
        gameId,
        questionId,
        oldQuestion
      )
      await updateScores(gameId, questionId, oldCorrectUsers, -1)
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
      await updateScores(gameId, questionId, correctUsers, 1)
    }

    // Retrieve top 100 users
    const leaderboardQueryRes = await admin
      .firestore()
      .collection(`games/${gameId}/users`)
      .orderBy('score', 'desc')
      .limit(100)
      .get()

    // Calculate places
    const places = calculatePlaces(leaderboardQueryRes.docs)

    // Updating leaderboard
    await admin
      .firestore()
      .doc(`games/${gameId}`)
      .update({
        leaderboard: leaderboardQueryRes.docs.map((doc, index) => ({
          place: places[index],
          ...doc.data(),
        })),
      })
  }
)

// TODO: Save on invocations by scheduling this specifically during game hours on game days
exports.updatePlayerCountForGames = onSchedule('every 1 minutes', async () => {
  console.log('Updating game user counts for open and scheduled games!')

  const scheduledGames = await admin
    .firestore()
    .collection('games')
    .where('state', '==', 'scheduled')
    .get()

  const openGames = await admin
    .firestore()
    .collection('games')
    .where('state', '==', 'open')
    .get()

  const games = scheduledGames.docs.concat(openGames.docs)
  games.forEach(async (game) => {
    console.log(`Getting count for game ${game.id}`)
    const { count } = (
      await admin.firestore().collection(`games/${game.id}/users`).count().get()
    ).data()
    console.log(`Updating count to ${count} for game ${game.id}`)
    await admin.firestore().doc(`games/${game.id}`).update({
      userCount: count,
    })
  })
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

      // Send out end of game notifications
      const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing!`
      await sendNotificationsToGameUsers(expo, gameId, message)

      // TODO: Handle payouts to 1st place winners
    }
  }
)

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
      (playerTokenPromiseRes) => playerTokenPromiseRes.status === 'fulfilled'
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
