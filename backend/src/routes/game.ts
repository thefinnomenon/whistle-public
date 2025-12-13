import { Router } from 'express'
import { admin, db } from '../firebase'
import { sendDismissNotification } from '../lib/notifications'
import { authMiddleware } from '../middleware/auth'
import { isAdminMiddleware } from '../middleware/isAdmin'

// api/games/
const router = Router()

// All routes require auth + admin
router.use(authMiddleware, isAdminMiddleware)

// GAME ROUTES
router.post('/', async (req, res) => {
  console.log('[games/create] game', req.body)
  try {
    if (!req.user?.uid) {
      console.error('[games/create] Unauthorized')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { gameId, startTime, ...rest } = req.body || {}

    const payload = {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      startTime: startTime
        ? admin.firestore.Timestamp.fromDate(new Date(startTime))
        : admin.firestore.FieldValue.serverTimestamp(),
      ...rest,
    }

    let docRef
    if (gameId) {
      docRef = db.collection('games').doc(gameId)
      await docRef.set(payload, { merge: true })
    } else {
      docRef = await db.collection('games').add(payload)
    }

    return res.json({ id: docRef.id, ...payload })
  } catch (err) {
    console.error('[games/create] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:id/start', async (req, res) => {
  const { id } = req.params
  console.log('[games/start] game', id)
  try {
    await startGameById(id)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[games/start] error', err)
    if ((err as any)?.status === 404) {
      return res.status(404).json({ error: 'Game not found' })
    }
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:id/end', async (req, res) => {
  const { id } = req.params
  console.log('[games/end] game', id)
  try {
    const gameRef = db.collection('games').doc(id)
    const gameSnap = await gameRef.get()
    if (!gameSnap.exists) {
      return res.status(404).json({ error: 'Game not found' })
    }
    const game = gameSnap.data() as any

    // Mark game resolved
    await gameRef.set(
      {
        state: 'resolved',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    // Calculate stats, winnings, notifications
    await calculateGameStatistics(id)
    const winnerNotifications = await distributeWinnings(id, game)
    await notifyWinners(winnerNotifications, game)
    const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing!`
    await sendNotificationsToGameUsers(id, message)

    return res.json({ ok: true })
  } catch (err) {
    console.error('[games/end] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/test-question', async (_req, res) => {
  try {
    const targetEmail = 'configure@example.com'
    const userRecord = await admin.auth().getUserByEmail(targetEmail)
    const uid = userRecord.uid

    const userDoc = await admin.firestore().doc(`users/${uid}`).get()
    const tokensMap = (userDoc.data()?.tokens as any) || {}
    const tokens: string[] = Object.values(tokensMap)
      .map((t: any) => t?.token)
      .filter((t: any) => typeof t === 'string' && t.length > 0)

    if (!tokens.length) {
      return res.status(400).json({ error: 'No device tokens for target user' })
    }

    const now = Date.now()
    const questionId = `test-${now}`
    const gameId = 'test'
    const collapseId = `test_${now}`
    const questionText = 'Is this a test question?'
    const choices = [
      { id: 'yes', value: 'Yes' },
      { id: 'no', value: 'No' },
    ]

    const baseData = {
      type: 'question',
      gameId,
      questionId,
      question: questionText,
      sentAt: now.toString(),
      engineTag: 'manual_test',
      collapseId,
      choices: JSON.stringify(choices),
      timeoutAt: (now + 30_000).toString(),
    }

    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title: '🏈 Test Question',
        body: questionText,
      },
      data: baseData,
      android: {
        priority: 'high',
        ttl: 10,
        collapseKey: collapseId,
        notification: {
          channelId: 'default',
          tag: collapseId,
          priority: 'high',
          sound: 'whistle',
        },
      },
      apns: {
        payload: {
          aps: {
            category: 'question',
            sound: 'whistle.wav',
          },
        },
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': collapseId,
          'apns-expiration': Math.floor((now + 30_000) / 1000).toString(),
        },
      },
    }

    const response = await admin.messaging().sendEachForMulticast(message)
    return res.json({
      sent: response.successCount,
      failed: response.failureCount,
      results: response.responses.map((r) => ({
        success: r.success,
        error: r.error?.message,
      })),
    })
  } catch (error) {
    console.error('[sendTestQuestion] Error:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

// QUESTION ROUTES
router.post('/:gameId/questions', async (req, res) => {
  const { gameId } = req.params
  console.log('[questions/create] body', req.body)
  try {
    const {
      question,
      choices,
      timeoutAt,
      engineTag,
      type = 'YESNO',
    } = req.body || {}
    if (!req.user?.uid) return res.status(401).json({ error: 'Unauthorized' })
    if (!gameId || !question) {
      return res.status(400).json({ error: 'gameId and question are required' })
    }

    const questionPayload = {
      question,
      choices,
      type,
      state: 'open',
      timeoutAt: timeoutAt ? timeoutAt : null,
      engineTag: engineTag || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    const qRef = await db
      .collection('games')
      .doc(gameId)
      .collection('questions')
      .add(questionPayload)

    // Send notification to game topic (same as pushNewQuestion)
    const topic = `game_${gameId}`
    const collapseId = topic
    const now = Date.now()

    const baseData = {
      type: 'question',
      gameId,
      questionId: qRef.id,
      question,
      sentAt: now.toString(),
      engineTag: engineTag || '',
      collapseId,
      choices: JSON.stringify(choices || []),
      timeoutAt: timeoutAt ? String(timeoutAt) : '',
    }

    const questionNotification = {
      topic,
      notification: {
        title: '🏈 New Question!',
        body: question,
      },
      data: baseData,
      android: {
        priority: 'high' as const,
        ttl: 10,
        collapseKey: collapseId,
        notification: {
          channelId: 'default',
          tag: collapseId,
          priority: 'high' as const,
          sound: 'whistle',
        },
      },
      apns: {
        payload: {
          aps: {
            category: 'question',
            sound: 'whistle.wav',
          },
        },
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': collapseId,
          'apns-expiration': Math.floor((now + 10000) / 1000).toString(),
        },
      },
    }

    await admin.messaging().send(questionNotification as any)

    return res.json({ id: qRef.id })
  } catch (err) {
    console.error('[questions/create] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:gameId/questions/:questionId/close', async (req, res) => {
  const { gameId, questionId } = req.params
  console.log('[questions/close]', gameId, questionId)
  try {
    await db
      .collection('games')
      .doc(gameId)
      .collection('questions')
      .doc(questionId)
      .set(
        {
          state: 'closed',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    await sendDismissNotification(gameId, questionId, `game_${gameId}`)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[questions/close] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:gameId/questions/:questionId/cancel', async (req, res) => {
  const { gameId, questionId } = req.params
  console.log('[questions/cancel]', gameId, questionId)
  try {
    await db
      .collection('games')
      .doc(gameId)
      .collection('questions')
      .doc(questionId)
      .set(
        {
          state: 'cancelled',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    await calculateScores(gameId, questionId, { revertIfResolved: true })
    await sendDismissNotification(gameId, questionId, `game_${gameId}`)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[questions/cancel] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:gameId/questions/:questionId/resolve', async (req, res) => {
  const { gameId, questionId } = req.params
  const { answer } = req.body || {}
  console.log('[questions/resolve]', gameId, questionId, 'answer', answer)
  if (answer === undefined) {
    return res.status(400).json({ error: 'answer is required' })
  }
  try {
    await db
      .collection('games')
      .doc(gameId)
      .collection('questions')
      .doc(questionId)
      .set(
        {
          state: 'resolved',
          answer,
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    await calculateScores(gameId, questionId)
    await sendDismissNotification(gameId, questionId, `game_${gameId}`)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[questions/resolve] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

export default router

const getPercentile = (sortedArray: number[], percentile: number): number => {
  if (sortedArray.length === 0) return 0
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
  return sortedArray[Math.max(0, index)]
}

const calculateGameStatistics = async (gameId: string) => {
  console.log('[games/end] calculating statistics', gameId)
  const questionsSnapshot = await admin
    .firestore()
    .collection(`games/${gameId}/questions`)
    .get()

  const questions = questionsSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  if (questions.length === 0) {
    console.log('No questions found for game', gameId)
    return
  }

  const resolvedQuestions = questions.filter((q: any) => q.state === 'resolved')
  const cancelledQuestions = questions.filter(
    (q: any) => q.state === 'cancelled'
  )

  if (resolvedQuestions.length === 0) {
    console.log('No resolved questions to calculate statistics for.')
    return
  }

  let totalQuestionsAsked = questions.length
  let totalResponses = 0
  let totalCorrect = 0
  let totalIncorrect = 0
  let totalResponseTimeMs = 0
  let totalDeliveryTimeMs = 0
  let totalQuestionOpenTimeMs = 0
  let questionsWithResponseTime = 0
  let questionsWithDeliveryTime = 0
  let questionsWithOpenTime = 0
  const allResponseRates: number[] = []
  const allResolutionTimes: number[] = []

  resolvedQuestions.forEach((q: any) => {
    totalResponses += q.totalResponses || 0

    if (q.correctCount !== undefined) totalCorrect += q.correctCount
    if (q.incorrectCount !== undefined) totalIncorrect += q.incorrectCount

    if (q.avgResponseTimeMs !== undefined && q.avgResponseTimeMs > 0) {
      totalResponseTimeMs += q.avgResponseTimeMs
      questionsWithResponseTime++
    }

    if (q.avgDeliveryTimeMs !== undefined && q.avgDeliveryTimeMs > 0) {
      totalDeliveryTimeMs += q.avgDeliveryTimeMs
      questionsWithDeliveryTime++
    }

    if (q.questionOpenTimeMs !== undefined && q.questionOpenTimeMs > 0) {
      totalQuestionOpenTimeMs += q.questionOpenTimeMs
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

  const avgResponsesPerQuestion = totalQuestionsAsked
    ? totalResponses / totalQuestionsAsked
    : 0
  const avgResponseRate = allResponseRates.length
    ? allResponseRates.reduce((a, b) => a + b, 0) / allResponseRates.length
    : 0
  const avgResponseTimeMs = questionsWithResponseTime
    ? totalResponseTimeMs / questionsWithResponseTime
    : 0
  const avgDeliveryTimeMs = questionsWithDeliveryTime
    ? totalDeliveryTimeMs / questionsWithDeliveryTime
    : 0
  const avgQuestionOpenTimeMs = questionsWithOpenTime
    ? totalQuestionOpenTimeMs / questionsWithOpenTime
    : 0
  const avgResolutionTimeMs = allResolutionTimes.length
    ? allResolutionTimes.reduce((a, b) => a + b, 0) / allResolutionTimes.length
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

  await admin.firestore().doc(`games/${gameId}`).update({
    statistics: gameStats,
  })

  console.log('Successfully saved game statistics')
}

const distributeWinnings = async (
  gameId: string,
  game: any
): Promise<{ userId: string; amount: number }[]> => {
  console.log('Calculating winnings for game', gameId)

  if (!game.leaderboard || game.leaderboard.length === 0) {
    console.log('No leaderboard to distribute winnings from')
    return []
  }

  const topScore = game.leaderboard[0].score

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

  const batch = admin.firestore().batch()
  const winnerNotifications: { userId: string; amount: number }[] = []

  winnerDocs.docs.forEach((winnerDoc) => {
    const userId = winnerDoc.id
    const userRef = admin.firestore().doc(`users/${userId}`)

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
  game: any
) => {
  if (winnerNotifications.length === 0) {
    console.log('No winners to notify...')
    return
  }

  console.log(`Notifying ${winnerNotifications.length} winners`)

  await Promise.all(
    winnerNotifications.map(async ({ userId, amount }) => {
      const userDoc = await admin
        .firestore()
        .collection('users')
        .doc(userId)
        .get()
      const userData = userDoc.data() as { tokens?: { [tokenId: string]: any } }

      if (!userData?.tokens) {
        console.error(`No tokens found for user ${userId}`)
        return
      }

      const tokens = Object.values(userData.tokens)
      for (const tokenData of tokens) {
        const token = tokenData.token
        if (!token) continue

        const dataPayload = {
          gameId: String(game.id || ''),
          winnings: String(amount.toFixed(2)),
        }

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
                sound: 'whistle.wav',
              },
            },
            headers: {
              'apns-push-type': 'alert',
              'apns-priority': '10',
            },
          },
        }

        try {
          await admin.messaging().send(message as any)
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

const calculateScores = async (
  gameId: string,
  questionId: string,
  opts: { revertIfResolved?: boolean } = {}
) => {
  const questionSnap = await admin
    .firestore()
    .doc(`games/${gameId}/questions/${questionId}`)
    .get()
  if (!questionSnap.exists) return
  const question = questionSnap.data() as any

  // Only revert if previously resolved and now cancelled
  if (opts.revertIfResolved && question.state !== 'cancelled') return

  const correctUsers = await getCorrectUsers(gameId, questionId, question)
  if (correctUsers.length === 0) return

  const delta = opts.revertIfResolved && question.state === 'cancelled' ? -1 : 1

  await updateScores(gameId, correctUsers, delta)
  await calculateQuestionStatistics(gameId, questionId, question)
}

const getCorrectUsers = async (
  gameId: string,
  questionId: string,
  question: any
): Promise<string[]> => {
  if (question.answer === undefined) return []

  const predictionsSnap = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .where('prediction', '==', String(question.answer))
    .get()

  return predictionsSnap.docs.map((d) => d.id)
}

const updateScores = async (
  gameId: string,
  userIds: string[],
  delta: number
) => {
  const batch = admin.firestore().batch()

  userIds.forEach((userId) => {
    const userRef = admin.firestore().doc(`games/${gameId}/users/${userId}`)
    batch.set(
      userRef,
      {
        score: admin.firestore.FieldValue.increment(delta),
      },
      { merge: true }
    )
  })

  await batch.commit()
}

export const updatePlayerCountsForActiveGames = async (): Promise<number> => {
  const gamesSnap = await admin
    .firestore()
    .collection('games')
    .where('state', 'in', ['scheduled', 'open'])
    .get()

  let updated = 0

  for (const doc of gamesSnap.docs) {
    const gameId = doc.id
    const usersCountSnap = await admin
      .firestore()
      .collection(`games/${gameId}/users`)
      .count()
      .get()
    const playerCount = usersCountSnap.data().count

    // Skip write if no change
    if (doc.data().playerCount === playerCount) {
      continue
    }

    await admin.firestore().doc(`games/${gameId}`).set(
      {
        playerCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    console.log(
      `[games/update-player-counts] game=${gameId} playerCount=${playerCount}`
    )
    updated++
  }

  if (updated > 0)
    console.log(
      `[games/update-player-counts] completed. games processed: ${updated}`
    )
  return updated
}

export const startGameById = async (gameId: string) => {
  const gameRef = db.collection('games').doc(gameId)
  const gameSnap = await gameRef.get()
  if (!gameSnap.exists) {
    const err: any = new Error('Game not found')
    err.status = 404
    throw err
  }
  const game = gameSnap.data() as any

  console.log('[games] Starting game', gameId, game)

  await gameRef.set(
    {
      state: 'open',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  const topic = 'app_notifications'
  const collapseId = `game_${gameId}`
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
      collapseKey: collapseId,
      notification: {
        channelId: 'default',
        tag: collapseId,
        priority: 'high' as const,
        sound: 'whistle',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'whistle.wav',
        },
      },
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': collapseId,
      },
    },
  }

  await admin.messaging().send(message as any)
}

export const startScheduledGames = async () => {
  const now = admin.firestore.Timestamp.now()
  const gamesSnap = await admin
    .firestore()
    .collection('games')
    .where('state', '==', 'scheduled')
    .where('startTime', '<=', now)
    .get()

  if (gamesSnap.empty) {
    return 0
  }

  let started = 0
  for (const doc of gamesSnap.docs) {
    try {
      await startGameById(doc.id)
      started++
    } catch (err) {
      console.error(`[games/startScheduledGames] failed for ${doc.id}`, err)
    }
  }

  console.log(`[games/startScheduledGames] started ${started} games`)
  return started
}

export const closeExpiredQuestions = async (): Promise<number> => {
  const nowMs = Date.now()
  // Query open questions whose timeoutAt <= now
  const questionsSnap = await admin
    .firestore()
    .collectionGroup('questions')
    .where('state', '==', 'open')
    .where('timeoutAt', '<=', nowMs.toString())
    .limit(200)
    .get()

  if (questionsSnap.empty) {
    return 0
  }

  let closed = 0
  for (const doc of questionsSnap.docs) {
    const questionPath = doc.ref.path // games/{gameId}/questions/{questionId}
    const parts = questionPath.split('/')
    const gameId = parts[1]
    const questionId = parts[3]

    try {
      await doc.ref.set(
        {
          state: 'closed',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await sendDismissNotification(gameId, questionId, `game_${gameId}`)
      closed++
    } catch (err) {
      console.error(
        `[closeExpiredQuestions] failed to close ${questionPath}`,
        err
      )
    }
  }

  if (closed > 0) {
    console.log(`[closeExpiredQuestions] closed ${closed} questions`)
  }
  return closed
}

const calculateQuestionStatistics = async (
  gameId: string,
  questionId: string,
  question: any
) => {
  if (!question) return
  const predsSnap = await admin
    .firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .get()

  const totalResponses = predsSnap.size
  const correctCount = predsSnap.docs.filter(
    (d) => d.data().prediction === String(question.answer)
  ).length
  const incorrectCount = totalResponses - correctCount

  const statistics = {
    totalResponses,
    correctCount,
    incorrectCount,
  }

  await admin.firestore().doc(`games/${gameId}/questions/${questionId}`).set(
    {
      statistics,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
}

const sendNotificationsToGameUsers = async (
  gameId: string,
  message: string
) => {
  const topic = `game_${gameId}`
  const collapseId = topic

  try {
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
        collapseKey: collapseId,
        notification: {
          channelId: 'default',
          priority: 'high' as const,
          sound: 'whistle',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'whistle.wav',
          },
          headers: {
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-collapse-id': collapseId,
          },
        },
      },
    }

    await admin.messaging().send(fcmMessage as any)
  } catch (error) {
    console.error(
      `Failed to send game end notification to topic ${topic}:`,
      error
    )
  }
}
