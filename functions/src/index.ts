import { createHash } from 'crypto'
import admin from 'firebase-admin'
import { setGlobalOptions } from 'firebase-functions/v2'
import {
  onDocumentCreated,
  onDocumentUpdated,
} from 'firebase-functions/v2/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

setGlobalOptions({ region: 'us-east1' })

admin.initializeApp()

// HTTP endpoint for native iOS notification actions to post predictions
exports.submitPredictionFromNotification = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed')
    return
  }

  try {
    const authHeader = req.headers.authorization || ''
    const token =
      authHeader.startsWith('Bearer ') && authHeader.slice('Bearer '.length)

    if (!token) {
      res.status(401).json({ error: 'Missing bearer token' })
      return
    }

    const decoded = await admin.auth().verifyIdToken(token)
    const body = req.body || {}
    const questionId = body.questionId as string | undefined
    const gameId = body.gameId as string | undefined
    const userId = (body.userId as string | undefined) || decoded.uid
    let prediction: boolean | null = body.prediction

    if (typeof prediction !== 'boolean') {
      res.status(400).json({ error: 'prediction must be boolean or YES/NO' })
      return
    }

    if (!questionId || !gameId) {
      res.status(400).json({ error: 'gameId and questionId are required' })
      return
    }

    if (userId !== decoded.uid) {
      res.status(403).json({ error: 'userId mismatch' })
      return
    }

    const now = admin.firestore.FieldValue.serverTimestamp()

    const predictionRef = admin
      .firestore()
      .doc(`games/${gameId}/questions/${questionId}/predictions/${userId}`)
    const userPredictionRef = admin
      .firestore()
      .doc(`users/${userId}/games/${gameId}/predictions/${questionId}`)

    const payload = {
      prediction,
      source: 'ios_notification',
      createdAt: now,
    }

    await Promise.all([
      predictionRef.set(payload, { merge: true }),
      userPredictionRef.set(payload, { merge: true }),
    ])

    res.json({ ok: true })
  } catch (error) {
    console.error('[submitPredictionFromNotification] Error:', error)
    res.status(500).json({ error: 'Internal Server Error' })
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
          body: `${game.homeTeam} vs ${game.awayTeam} is now live. Join now and get ready to play!`,
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
    const fallbackId = `question-${questionId}`

    try {
      // Capture sentAt BEFORE sending to get accurate timing
      const sentAt = Date.now()

      const baseData = {
        type: 'question',
        gameId,
        questionId,
        question: question.question,
        sentAt: sentAt.toString(),
        engineTag: question.engineTag || '',
        fallbackId,
      }

      const alertMessage = {
        topic,
        notification: {
          title: '🏈 New Question!',
          body: question.question,
        },
        data: baseData,
        android: {
          priority: 'high' as const,
          collapseKey: fallbackId,
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
                title: '🏈 New Question!',
                body: question.question,
              },
              category: 'question',
              sound: 'whistle.wav',
            },
          },
          headers: {
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-collapse-id': fallbackId,
          },
        },
      }

      const response = await admin.messaging().send(alertMessage)
      console.log(
        `[PushNewQuestion] Sent notification to topic ${topic}:`,
        response
      )
    } catch (error) {
      console.error(
        `[PushNewQuestion] Failed to send notification to topic ${topic}:`,
        error
      )
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

const calculateQuestionStatistics = async (
  gameId: string,
  questionId: string,
  question: Question
) => {
  console.log(`Calculating statistics for question ${questionId}`)

  if (!question.createdAt) {
    console.error('Question missing createdAt timestamp')
    return
  }

  // Get total player count for response rate calculation
  const gamePlayersSnapshot = await admin
    .firestore()
    .collection(`games/${gameId}/users`)
    .count()
    .get()
  const totalPlayers = gamePlayersSnapshot.data().count

  // Get all predictions for this question
  const predictionsSnapshot = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .get()

  console.log(`Found ${predictionsSnapshot.docs.length} total predictions`)

  // Filter predictions that were made before question closed (if it has a closedAt)
  const validPredictions = question.closedAt
    ? predictionsSnapshot.docs.filter((doc) => {
        const createTime = doc.createTime?.toDate()
        const closedAt = question.closedAt?.toDate()
        return createTime && closedAt && createTime < closedAt
      })
    : predictionsSnapshot.docs

  // Count late predictions (submitted after question closed)
  const latePredictions = question.closedAt
    ? predictionsSnapshot.docs.filter((doc) => {
        const createTime = doc.createTime?.toDate()
        const closedAt = question.closedAt?.toDate()
        return createTime && closedAt && createTime >= closedAt
      })
    : []

  console.log(`Found ${validPredictions.length} valid predictions`)
  console.log(`Found ${latePredictions.length} late predictions`)

  const totalResponses = validPredictions.length
  const latePredictionCount = latePredictions.length
  const responseRate =
    totalPlayers > 0 ? (totalResponses / totalPlayers) * 100 : 0
  const lateResponseRate =
    totalPlayers > 0 ? (latePredictionCount / totalPlayers) * 100 : 0

  // Calculate response times and delivery times
  const responseTimes: number[] = []
  const deliveryTimes: number[] = []

  const createdAtMillis = question.createdAt.toMillis()

  validPredictions.forEach((doc) => {
    const predictionTime = doc.createTime?.toMillis()
    const predictionData = doc.data()

    if (predictionTime && predictionData?.receivedAt) {
      // Response time: from when notification was received to when user answered
      // This is the most meaningful metric - how quickly users respond after seeing the notification
      const responseTime = predictionTime - predictionData.receivedAt
      if (responseTime >= 0) {
        responseTimes.push(responseTime)
      }
    }

    // Delivery time: from when notification was sent to when it was received on device
    // Use sentAt and receivedAt if available (stored in prediction document)
    if (predictionData?.sentAt && predictionData?.receivedAt) {
      const deliveryTime = predictionData.receivedAt - predictionData.sentAt
      if (deliveryTime >= 0) {
        deliveryTimes.push(deliveryTime)
      }
    }
  })

  // Sort times for percentile calculations
  responseTimes.sort((a, b) => a - b)
  deliveryTimes.sort((a, b) => a - b)

  // Helper function to calculate percentile
  const getPercentile = (sortedArray: number[], percentile: number): number => {
    if (sortedArray.length === 0) return 0
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
    return sortedArray[Math.max(0, index)]
  }

  // Calculate timing statistics
  const avgResponseTime =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0
  const medianResponseTime = getPercentile(responseTimes, 50)
  const p95ResponseTime = getPercentile(responseTimes, 95)
  const minResponseTime = responseTimes.length > 0 ? responseTimes[0] : 0
  const maxResponseTime =
    responseTimes.length > 0 ? responseTimes[responseTimes.length - 1] : 0

  const avgDeliveryTime =
    deliveryTimes.length > 0
      ? deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length
      : 0
  const medianDeliveryTime = getPercentile(deliveryTimes, 50)
  const p95DeliveryTime = getPercentile(deliveryTimes, 95)
  const minDeliveryTime = deliveryTimes.length > 0 ? deliveryTimes[0] : 0
  const maxDeliveryTime =
    deliveryTimes.length > 0 ? deliveryTimes[deliveryTimes.length - 1] : 0

  // Count by prediction value (true/false)
  const yesCount = validPredictions.filter(
    (doc) => doc.data().prediction === true
  ).length
  const noCount = validPredictions.filter(
    (doc) => doc.data().prediction === false
  ).length

  // Calculate question open time (time from creation to when it was closed)
  // Questions must be closed before being resolved, so closedAt should always exist
  const questionOpenTimeMs = question.closedAt
    ? question.closedAt.toMillis() - createdAtMillis
    : 0

  // Calculate resolution time (time from when question was closed to when it was resolved)
  // This measures how long it took to determine the answer after closing
  let questionResolutionTimeMs = 0
  if (
    question.state === 'resolved' &&
    question.closedAt &&
    question.resolvedAt
  ) {
    questionResolutionTimeMs =
      question.resolvedAt.toMillis() - question.closedAt.toMillis()
  }

  // Build statistics object
  const statistics: {
    totalResponses: number
    totalPlayers: number
    responseRate: number
    latePredictionCount: number
    lateResponseRate: number
    yesCount: number
    noCount: number
    questionOpenTimeMs: number
    questionResolutionTimeMs: number
    avgResponseTimeMs: number
    medianResponseTimeMs: number
    p95ResponseTimeMs: number
    minResponseTimeMs: number
    maxResponseTimeMs: number
    avgDeliveryTimeMs: number
    medianDeliveryTimeMs: number
    p95DeliveryTimeMs: number
    minDeliveryTimeMs: number
    maxDeliveryTimeMs: number
    correctCount?: number
    incorrectCount?: number
  } = {
    totalResponses,
    totalPlayers,
    responseRate: Math.round(responseRate * 100) / 100, // Round to 2 decimal places
    latePredictionCount,
    lateResponseRate: Math.round(lateResponseRate * 100) / 100,
    yesCount,
    noCount,
    questionOpenTimeMs: Math.round(questionOpenTimeMs),
    questionResolutionTimeMs: Math.round(questionResolutionTimeMs),
    avgResponseTimeMs: Math.round(avgResponseTime),
    medianResponseTimeMs: Math.round(medianResponseTime),
    p95ResponseTimeMs: Math.round(p95ResponseTime),
    minResponseTimeMs: Math.round(minResponseTime),
    maxResponseTimeMs: Math.round(maxResponseTime),
    avgDeliveryTimeMs: Math.round(avgDeliveryTime),
    medianDeliveryTimeMs: Math.round(medianDeliveryTime),
    p95DeliveryTimeMs: Math.round(p95DeliveryTime),
    minDeliveryTimeMs: Math.round(minDeliveryTime),
    maxDeliveryTimeMs: Math.round(maxDeliveryTime),
  }

  // If question has an answer, calculate correct/incorrect counts
  if (question.answer !== undefined) {
    const correctCount = validPredictions.filter(
      (doc) => doc.data().prediction === question.answer
    ).length
    const incorrectCount = validPredictions.length - correctCount

    statistics.correctCount = correctCount
    statistics.incorrectCount = incorrectCount
  }

  console.log('Question statistics:', statistics)

  // Update the question with statistics
  await admin
    .firestore()
    .doc(`games/${gameId}/questions/${questionId}`)
    .update(statistics)

  console.log('Successfully saved question statistics')
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

    // Ignore if question was closed (not resolved)
    if (question.state === 'closed') {
      console.log('Question in closed state, skipping updates...')
      return
    }

    // Question was resolved -> Update scores and calculate statistics
    if (question.state === 'resolved' && oldQuestion.state !== 'resolved') {
      console.log(
        'Question was resolved! Updating scores and calculating statistics...'
      )
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
      if (correctUsers.length > 0) {
        await updateScores(gameId, questionId, correctUsers, 1)
      }

      // Calculate all statistics
      await calculateQuestionStatistics(gameId, questionId, question)
    }

    // Question cancelled after being resolved -> Revert scores
    if (question.state === 'cancelled' && oldQuestion.state === 'resolved') {
      console.log('Question was cancelled! Reverting scores...')
      const correctUsers = await getCorrectUsers(gameId, questionId, question)
      if (correctUsers.length > 0) {
        await updateScores(gameId, questionId, correctUsers, -1)
      }
    }

    // Question cancelled -> Calculate statistics
    if (question.state === 'cancelled' && oldQuestion.state !== 'cancelled') {
      console.log('Question was cancelled! Calculating statistics...')
      await calculateQuestionStatistics(gameId, questionId, question)
    }

    // Question answer changes -> Revert and update scores
    if (
      question.answer !== undefined &&
      oldQuestion.answer !== undefined &&
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

const calculateGameStatistics = async (gameId: string) => {
  console.log(`Calculating global statistics for game ${gameId}`)

  // Get all questions for this game
  const questionsSnapshot = await admin
    .firestore()
    .collection(`games/${gameId}/questions`)
    .get()

  console.log(
    `Found ${questionsSnapshot.docs.length} questions for game ${gameId}`
  )

  const questions = questionsSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  // Count questions by state
  const resolvedQuestions = questions.filter((q: any) => q.state === 'resolved')
  const cancelledQuestions = questions.filter(
    (q: any) => q.state === 'cancelled'
  )
  const totalQuestionsAsked = questions.length

  // Filter resolved questions with statistics for aggregation
  const resolvedWithStats = resolvedQuestions.filter(
    (q: any) => q.totalResponses !== undefined
  )

  console.log(
    `Found ${resolvedWithStats.length} resolved questions with statistics, ${cancelledQuestions.length} cancelled`
  )

  if (resolvedWithStats.length === 0) {
    console.log(
      'No resolved questions with statistics, saving basic counts only'
    )
    await admin
      .firestore()
      .doc(`games/${gameId}`)
      .update({
        statistics: {
          totalQuestionsAsked,
          totalResolved: resolvedQuestions.length,
          totalCancelled: cancelledQuestions.length,
        },
      })
    return
  }

  // Aggregate statistics from resolved questions
  let totalResponses = 0
  let totalCorrect = 0
  let totalIncorrect = 0
  let totalResponseTime = 0
  let totalDeliveryTime = 0
  let totalQuestionOpenTime = 0
  let questionsWithResponseTime = 0
  let questionsWithDeliveryTime = 0
  let questionsWithOpenTime = 0
  let allResponseRates: number[] = []
  let allResolutionTimes: number[] = []

  resolvedWithStats.forEach((q: any) => {
    totalResponses += q.totalResponses || 0

    if (q.correctCount !== undefined) {
      totalCorrect += q.correctCount
    }
    if (q.incorrectCount !== undefined) {
      totalIncorrect += q.incorrectCount
    }

    if (q.avgResponseTimeMs !== undefined && q.avgResponseTimeMs > 0) {
      totalResponseTime += q.avgResponseTimeMs
      questionsWithResponseTime++
    }

    if (q.avgDeliveryTimeMs !== undefined && q.avgDeliveryTimeMs > 0) {
      totalDeliveryTime += q.avgDeliveryTimeMs
      questionsWithDeliveryTime++
    }

    if (q.questionOpenTimeMs !== undefined && q.questionOpenTimeMs > 0) {
      totalQuestionOpenTime += q.questionOpenTimeMs
      questionsWithOpenTime++
    }

    if (
      q.questionResolutionTimeMs !== undefined &&
      q.questionResolutionTimeMs > 0
    ) {
      allResolutionTimes.push(q.questionResolutionTimeMs)
    }

    if (q.responseRate !== undefined) {
      allResponseRates.push(q.responseRate)
    }
  })

  // Helper function to calculate percentile
  const getPercentile = (sortedArray: number[], percentile: number): number => {
    if (sortedArray.length === 0) return 0
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
    return sortedArray[Math.max(0, index)]
  }

  // Calculate averages
  const avgResponsesPerQuestion =
    resolvedWithStats.length > 0 ? totalResponses / resolvedWithStats.length : 0
  const avgResponseRate =
    allResponseRates.length > 0
      ? allResponseRates.reduce((a, b) => a + b, 0) / allResponseRates.length
      : 0
  const avgResponseTimeMs =
    questionsWithResponseTime > 0
      ? totalResponseTime / questionsWithResponseTime
      : 0
  const avgDeliveryTimeMs =
    questionsWithDeliveryTime > 0
      ? totalDeliveryTime / questionsWithDeliveryTime
      : 0
  const avgQuestionOpenTimeMs =
    questionsWithOpenTime > 0
      ? totalQuestionOpenTime / questionsWithOpenTime
      : 0

  // Calculate resolution time statistics
  allResolutionTimes.sort((a, b) => a - b)
  const avgResolutionTimeMs =
    allResolutionTimes.length > 0
      ? allResolutionTimes.reduce((a, b) => a + b, 0) /
        allResolutionTimes.length
      : 0
  const medianResolutionTimeMs = getPercentile(allResolutionTimes, 50)
  const p95ResolutionTimeMs = getPercentile(allResolutionTimes, 95)

  const totalPredictions = totalCorrect + totalIncorrect
  const accuracyRate =
    totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0

  const gameStats = {
    totalQuestionsAsked,
    totalResolved: resolvedQuestions.length,
    totalCancelled: cancelledQuestions.length,
    totalResponses,
    avgResponsesPerQuestion: Math.round(avgResponsesPerQuestion * 100) / 100,
    avgResponseRate: Math.round(avgResponseRate * 100) / 100,
    totalCorrect,
    totalIncorrect,
    accuracyRate: Math.round(accuracyRate * 100) / 100,
    avgResponseTimeMs: Math.round(avgResponseTimeMs),
    avgDeliveryTimeMs: Math.round(avgDeliveryTimeMs),
    avgQuestionOpenTimeMs: Math.round(avgQuestionOpenTimeMs),
    avgResolutionTimeMs: Math.round(avgResolutionTimeMs),
    medianResolutionTimeMs: Math.round(medianResolutionTimeMs),
    p95ResolutionTimeMs: Math.round(p95ResolutionTimeMs),
  }

  console.log('Game statistics:', gameStats)

  // Update the game document with statistics
  await admin.firestore().doc(`games/${gameId}`).update({
    statistics: gameStats,
  })

  console.log('Successfully saved game statistics')
}

exports.handleGameEnd = onDocumentUpdated(
  { document: 'games/{gameId}' },
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

      // Calculate global game statistics
      await calculateGameStatistics(gameId)

      // Calculate and distribute winnings
      const winnerNotifications = await distributeWinnings(gameId, game)

      // Notify winners
      await notifyWinners(winnerNotifications, game)

      // Send end of game notification to all players
      const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing!`
      await sendNotificationsToGameUsers(gameId, message)
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
  game: Game
) => {
  if (winnerNotifications.length === 0) {
    console.log('No winners to notify...')
    return
  }

  console.log(`Notifying ${winnerNotifications.length} winners`)

  await Promise.all(
    winnerNotifications.map(async ({ userId, amount }) => {
      console.log(`Processing winner ${userId}, amount: $${amount}`)

      const userDoc = await admin
        .firestore()
        .collection('users')
        .doc(userId)
        .get()
      const userData = userDoc.data() as {
        tokens?: { [tokenId: string]: Token }
      }

      if (!userData?.tokens) {
        console.error(`No tokens found for user ${userId}`)
        return
      }

      const tokens = Object.values(userData.tokens)
      console.log(`Found ${tokens.length} token(s) for user ${userId}`)

      for (const tokenData of tokens) {
        const token = tokenData.token

        if (!token) {
          console.error(`No token string in tokenData for user ${userId}`)
          continue
        }

        console.log(
          `Sending winner notification to user ${userId} with token: ${token.substring(0, 20)}...`
        )

        const dataPayload = {
          gameId: String(game.id),
          winnings: String(amount.toFixed(2)),
        }

        console.log(
          `Data payload types - gameId: ${typeof dataPayload.gameId}, winnings: ${typeof dataPayload.winnings}`
        )

        try {
          const message = {
            token,
            notification: {
              title: '🎉 You Won!',
              body: `Congratulations! You won $${amount.toFixed(2)} in ${game.homeTeam} vs. ${game.awayTeam}!`,
            },
            data: dataPayload,
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
            `Successfully sent winner notification to user ${userId}: ${response}`
          )
        } catch (error) {
          console.error(
            `Failed to send winner notification to user ${userId}:`,
            error
          )
        }
      }
    })
  )
}

const sendNotificationsToGameUsers = async (
  gameId: string,
  message: string
) => {
  const topic = `game_${gameId}`

  try {
    console.log(`Sending game end notification to topic ${topic}`)

    const fcmMessage = {
      topic,
      notification: {
        title: '🏈 Game Ended',
        body: message,
      },
      data: {
        gameId,
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

    const response = await admin.messaging().send(fcmMessage)
    console.log(
      `Successfully sent game end notification to topic ${topic}:`,
      response
    )
  } catch (error) {
    console.error(
      `Failed to send game end notification to topic ${topic}:`,
      error
    )
  }
}
