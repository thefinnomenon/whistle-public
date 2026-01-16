import { createHash, createHmac } from 'crypto'
import { Router } from 'express'
import { admin, db } from '../firebase'
import { trackEvent } from '../lib/mixpanel'
import { sendDismissNotification } from '../lib/notifications'
import { authMiddleware } from '../middleware/auth'
import { isAdminMiddleware } from '../middleware/isAdmin'

// api/games/
const router = Router()

const QUESTION_SIGNATURE_SECRET = process.env.WHISTLE_JWT_SECRET
const QUESTION_PAYLOAD_VERSION = 1

/**
 * Signed question payload sent with notifications.
 * Keep these keys stable to avoid native changes:
 * - gameId/questionId: used for submit URL and storage keys
 * - question: rendered text
 * - choices: array of { id, value }; keep id/value, extra fields allowed
 * - timeoutAt: ms timestamp (number) used for countdown/expiry
 * - questionPayload/questionSignature: raw strings passed through unchanged
 */
type SignedQuestionPayload = {
  version: number
  gameId: string
  questionId: string
  question: string
  choices: { id: string; value: string; [key: string]: any }[]
  timeoutAt: number | null
  engineTag?: string
  [key: string]: any
}

const buildSignedQuestionPayload = (payload: SignedQuestionPayload) => {
  if (!QUESTION_SIGNATURE_SECRET) {
    throw new Error('Missing WHISTLE_JWT_SECRET')
  }
  const payloadString = JSON.stringify(payload)
  const signature = createHmac('sha256', QUESTION_SIGNATURE_SECRET)
    .update(payloadString)
    .digest('hex')
  return { payloadString, signature, payload }
}

const verifyQuestionPayload = (
  payloadString?: string,
  signature?: string
): Record<string, any> | undefined => {
  if (!payloadString || !signature || !QUESTION_SIGNATURE_SECRET) return
  const expected = createHmac('sha256', QUESTION_SIGNATURE_SECRET)
    .update(payloadString)
    .digest('hex')
  if (expected !== signature) return
  try {
    return JSON.parse(payloadString)
  } catch (e) {
    console.error('[verifyQuestionPayload] error', e)
    return
  }
}

// All routes require auth
router.use(authMiddleware)

// Send onboarding practice question to a single user
router.post('/onboarding/practice-question', async (req, res) => {
  try {
    if (!req.user?.uid)
      return res.status(400).json({ error: 'userId required' })

    const userDoc = await db.collection('users').doc(req.user.uid).get()
    if (!userDoc.exists)
      return res.status(404).json({ error: 'User not found' })

    const tokensMap = (userDoc.data() as any)?.tokens || {}
    const tokens: string[] = Object.values(tokensMap)
      .map((t: any) => t?.token)
      .filter((t: any) => typeof t === 'string' && t.length > 0)
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'No device tokens for user' })
    }

    const now = Date.now()
    const questionId = `onboarding`
    const gameId = 'onboarding'
    const collapseId = `onboarding`
    const payloadQuestion = 'Will NE score in this red zone opportunity?'
    const payloadChoices = [
      { id: 'yes', value: 'Yes' },
      { id: 'no', value: 'No' },
    ]
    const timeoutAt = now + 20 * 1000

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId,
      question: payloadQuestion,
      choices: payloadChoices,
      timeoutAt,
      engineTag: 'onboarding',
    }
    const { payloadString, signature } =
      buildSignedQuestionPayload(baseQuestionPayload)

    const randomAnswer =
      payloadChoices[Math.floor(Math.random() * payloadChoices.length)]?.id

    // Auto-resolve the practice question shortly after creation so answers can be correct/incorrect
    setTimeout(async () => {
      try {
        await db
          .collection('users')
          .doc(req.user!.uid)
          .collection('practice')
          .doc('questions')
          .collection('items')
          .doc(questionId)
          .set(
            {
              state: 'resolved',
              answer: randomAnswer,
              resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
      } catch (error) {
        console.error(
          '[practice/question] failed to resolve practice question',
          {
            questionId,
            error,
          }
        )
      }
    }, 10_000)

    const message: admin.messaging.MulticastMessage = {
      tokens,
      // data-only for Android so our service handles display; iOS alert set in apns payload
      data: {
        type: 'question',
        gameId,
        questionId,
        question: payloadQuestion,
        sentAt: String(now),
        engineTag: 'onboarding',
        collapseId,
        choices: JSON.stringify(payloadChoices),
        timeoutAt: String(timeoutAt),
        questionPayload: payloadString,
        questionSignature: signature,
      },
      android: {
        priority: 'high',
        ttl: 10,
        collapseKey: collapseId,
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: 'Long press to answer!',
              body: payloadQuestion,
            },
            category: 'question',
            sound: 'whistle.wav',
            'mutable-content': 1,
          },
        },
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': collapseId,
          'apns-expiration': Math.floor(timeoutAt / 1000).toString(),
        },
      },
    }

    await admin.messaging().sendEachForMulticast(message)

    trackEvent(
      'onboarding_practice_question_sent',
      { userId: req.user?.uid, questionId, timeoutAt },
      req.user?.uid
    )

    return res.json({ ok: true, questionId })
  } catch (error) {
    console.error('[onboarding/practice-question] error', error)
    trackEvent(
      'onboarding_practice_question_error',
      { error: String(error) },
      req.user?.uid
    )
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

// Send a practice question to a single user (content extension driven)
router.post('/practice/question', async (req, res) => {
  try {
    if (!req.user?.uid)
      return res.status(400).json({ error: 'userId required' })

    const userId = req.user.uid
    const userDoc = await db.collection('users').doc(userId).get()
    if (!userDoc.exists)
      return res.status(404).json({ error: 'User not found' })

    const tokensMap = (userDoc.data() as any)?.tokens || {}
    const tokens: string[] = Object.values(tokensMap)
      .map((t: any) => t?.token)
      .filter((t: any) => typeof t === 'string' && t.length > 0)
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'No device tokens for user' })
    }

    const now = Date.now()
    const gameId = `practice-${userId}`
    const questionId = `practice-${now}`
    const collapseId = `practice-${userId}`
    const questions = [
      {
        question: 'Will the offense score on this drive?',
        choices: [
          { id: 'yes', value: 'Yes' },
          { id: 'no', value: 'No' },
        ],
      },
      {
        question: 'Will the next play be a pass?',
        choices: [
          { id: 'pass', value: 'Pass' },
          { id: 'run', value: 'Run' },
        ],
      },
      {
        question: 'Field goal attempt result?',
        choices: [
          { id: 'good', value: 'Good' },
          { id: 'miss', value: 'Miss' },
        ],
      },
      {
        question: 'Will the defense force a turnover?',
        choices: [
          { id: 'yes', value: 'Yes' },
          { id: 'no', value: 'No' },
        ],
      },
      {
        question: 'Will the next play gain 5+ yards?',
        choices: [
          { id: 'yes', value: 'Yes' },
          { id: 'no', value: 'No' },
        ],
      },
      {
        question: 'Will the QB be sacked on this drive?',
        choices: [
          { id: 'yes', value: 'Yes' },
          { id: 'no', value: 'No' },
        ],
      },
    ]

    const randomIndex = Math.floor(Math.random() * questions.length)
    const { question: payloadQuestion, choices: payloadChoices } =
      questions[randomIndex]
    const randomAnswer =
      payloadChoices[Math.floor(Math.random() * payloadChoices.length)]?.id
    const timeoutAt = now + 30_000

    // Persist the practice question for in-app listing
    await db
      .collection('users')
      .doc(userId)
      .collection('practice')
      .doc('meta')
      .set(
        { updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      )

    await db
      .collection('users')
      .doc(userId)
      .collection('practice')
      .doc('questions')
      .collection('items')
      .doc(questionId)
      .set({
        id: questionId,
        gameId,
        practice: true,
        question: payloadQuestion,
        choices: payloadChoices,
        state: 'open',
        type: 'YESNO',
        timeoutAt,
        randomAnswer,
        triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId,
      question: payloadQuestion,
      choices: payloadChoices,
      timeoutAt,
      engineTag: 'practice',
    }
    const { payloadString, signature } =
      buildSignedQuestionPayload(baseQuestionPayload)

    const message: admin.messaging.MulticastMessage = {
      tokens,
      data: {
        type: 'question',
        gameId,
        questionId,
        question: payloadQuestion,
        sentAt: String(now),
        engineTag: 'practice',
        collapseId,
        practice: 'true',
        choices: JSON.stringify(payloadChoices),
        timeoutAt: String(timeoutAt),
        questionPayload: payloadString,
        questionSignature: signature,
      },
      android: {
        priority: 'high',
        ttl: 10,
        collapseKey: collapseId,
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: 'Practice question',
              body: payloadQuestion,
            },
            category: 'question',
            sound: 'whistle.wav',
            'mutable-content': 1,
          },
        },
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': collapseId,
          'apns-expiration': Math.floor(timeoutAt / 1000).toString(),
        },
      },
    }

    // Auto-resolve practice question at timeout if user never answers
    setTimeout(
      async () => {
        try {
          await db
            .collection('users')
            .doc(userId)
            .collection('practice')
            .doc('questions')
            .collection('items')
            .doc(questionId)
            .set(
              {
                state: 'resolved',
                answer: randomAnswer,
                resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
        } catch (error) {
          console.error('[practice/question] failed to auto-resolve', {
            questionId,
            error,
          })
        }
      },
      Math.max(0, timeoutAt - Date.now())
    )

    await admin.messaging().sendEachForMulticast(message)

    trackEvent(
      'practice_question_sent',
      { userId, questionId, timeoutAt },
      userId
    )

    return res.json({ ok: true, questionId, gameId })
  } catch (error) {
    console.error('[practice/question] error', error)
    trackEvent(
      'practice_question_error',
      { error: String(error) },
      req.user?.uid
    )
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

// All remaining routes require admin

// GAME ROUTES
router.get('/:gameId/events', isAdminMiddleware, async (req, res) => {
  try {
    const { gameId } = req.params
    const rawLimit = req.query.limit
    const rawSince = req.query.sinceActionNumber
    const limit = Math.min(Number(rawLimit) || 200, 500)

    if (rawSince !== undefined && Number.isNaN(Number(rawSince))) {
      return res
        .status(400)
        .json({ error: 'sinceActionNumber must be a number' })
    }

    let query = db
      .collection(`games/${gameId}/events`)
      .orderBy('actionNumber', 'asc')

    if (rawSince !== undefined) {
      query = query.where('actionNumber', '>', Number(rawSince))
    }

    const snap = await query.limit(limit).get()
    const events = snap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as any),
    }))
    const lastActionNumber =
      events.length > 0
        ? (events[events.length - 1]?.actionNumber ?? null)
        : null

    return res.json({ ok: true, events, lastActionNumber })
  } catch (error) {
    console.error('[games/events] error', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/', isAdminMiddleware, async (req, res) => {
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

    trackEvent(
      'game_created',
      {
        gameId: docRef.id,
        userId: req.user?.uid,
        startTime: startTime || null,
      },
      req.user?.uid
    )

    return res.json({ id: docRef.id, ...payload })
  } catch (err) {
    console.error('[games/create] error', err)
    trackEvent(
      'game_create_error',
      {
        userId: req.user?.uid,
        error: String(err),
      },
      req.user?.uid
    )
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:id/start', isAdminMiddleware, async (req, res) => {
  const { id } = req.params
  console.log('[games/start] game', id)
  try {
    await startGameById(id)
    trackEvent(
      'game_started',
      {
        gameId: id,
        userId: req.user?.uid,
      },
      req.user?.uid
    )
    return res.json({ ok: true })
  } catch (err) {
    console.error('[games/start] error', err)
    trackEvent(
      'game_start_error',
      {
        gameId: id,
        userId: req.user?.uid,
        error: String(err),
      },
      req.user?.uid
    )
    if ((err as any)?.status === 404) {
      return res.status(404).json({ error: 'Game not found' })
    }
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/:id/end', isAdminMiddleware, async (req, res) => {
  const { id } = req.params
  console.log('[games/end] game', id)
  try {
    const result = await endGameById(id, req.user?.uid)
    if (result?.status === 404) {
      return res.status(404).json({ error: 'Game not found' })
    }
    return res.json({ ok: true })
  } catch (err) {
    console.error('[games/end] error', err)
    trackEvent(
      'game_end_error',
      {
        gameId: id,
        userId: req.user?.uid,
        error: String(err),
      },
      req.user?.uid
    )
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post('/test-question', isAdminMiddleware, async (_req, res) => {
  try {
    const targetEmails = ['configure@example.com'] //, 'configure@example.com']

    const tokens: string[] = []

    for (const targetEmail of targetEmails) {
      const userRecord = await admin.auth().getUserByEmail(targetEmail)
      const uid = userRecord.uid

      console.log(`Fetching tokens for user ${targetEmail} (${uid})`)

      const userDoc = await admin.firestore().doc(`users/${uid}`).get()
      const tokensMap = (userDoc.data()?.tokens as any) || {}
      const userTokens = Object.values(tokensMap)
        .map((t: any) => t?.token)
        .filter((t: any) => typeof t === 'string' && t.length > 0)

      tokens.push(...userTokens)
    }

    if (!tokens.length) {
      return res
        .status(400)
        .json({ error: 'No device tokens for target users' })
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

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId,
      question: questionText,
      choices,
      timeoutAt: now + 30_000,
      engineTag: 'manual_test',
    }
    const { payloadString, signature } =
      buildSignedQuestionPayload(baseQuestionPayload)

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
      questionPayload: payloadString,
      questionSignature: signature,
    }

    const message: admin.messaging.MulticastMessage = {
      tokens,
      data: baseData,
      android: {
        priority: 'high',
        ttl: 10,
        collapseKey: collapseId,
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '🏈 Test Question',
              body: questionText,
            },
            category: 'question',
            sound: 'whistle.wav',
            'mutable-content': 1,
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

    await admin.messaging().sendEachForMulticast(message)

    for (const targetEmail of targetEmails) {
      trackEvent('test_question_sent', {
        targetEmail,
        questionId,
      })
    }

    return res.json({ success: true })
  } catch (error) {
    console.error('[sendTestQuestion] Error:', error)
    trackEvent('test_question_error', {
      error: String(error),
    })
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

// QUESTION ROUTES
router.post('/:gameId/questions', isAdminMiddleware, async (req, res) => {
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

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId: qRef.id,
      question,
      choices: choices || [],
      timeoutAt: timeoutAt || null,
      engineTag: engineTag || '',
    }
    const { payloadString, signature } =
      buildSignedQuestionPayload(baseQuestionPayload)

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
      questionPayload: payloadString,
      questionSignature: signature,
    }

    const questionNotification = {
      topic,
      data: baseData,
      android: {
        priority: 'high' as const,
        ttl: 10,
        collapseKey: collapseId,
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '🏈 New Question!',
              body: question,
            },
            category: 'question',
            sound: 'whistle.wav',
            'mutable-content': 1,
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

    trackEvent(
      'question_created',
      {
        gameId,
        questionId: qRef.id,
        type,
        timeoutAt,
        choices,
        engineTag: engineTag || '',
      },
      req.user?.uid
    )

    return res.json({ id: qRef.id })
  } catch (err) {
    console.error('[questions/create] error', err)
    trackEvent(
      'question_create_error',
      {
        gameId,
        userId: req.user?.uid,
        error: String(err),
      },
      req.user?.uid
    )
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.post(
  '/:gameId/questions/:questionId/close',
  isAdminMiddleware,
  async (req, res) => {
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

      trackEvent(
        'question_closed',
        {
          gameId,
          questionId,
          method: 'manual',
        },
        req.user?.uid
      )

      return res.json({ ok: true })
    } catch (err) {
      console.error('[questions/close] error', err)
      trackEvent(
        'question_close_error',
        {
          gameId,
          questionId,
          method: 'manual',
          error: String(err),
        },
        req.user?.uid
      )
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  }
)

router.post(
  '/:gameId/questions/:questionId/cancel',
  isAdminMiddleware,
  async (req, res) => {
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

      trackEvent(
        'question_cancelled',
        {
          gameId,
          questionId,
        },
        req.user?.uid
      )

      return res.json({ ok: true })
    } catch (err) {
      console.error('[questions/cancel] error', err)
      trackEvent(
        'question_cancel_error',
        {
          gameId,
          questionId,
          error: String(err),
        },
        req.user?.uid
      )
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  }
)

router.post(
  '/:gameId/questions/:questionId/resolve',
  isAdminMiddleware,
  async (req, res) => {
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

      trackEvent(
        'question_resolved',
        {
          gameId,
          questionId,
          answer,
        },
        req.user?.uid
      )

      return res.json({ ok: true })
    } catch (err) {
      console.error('[questions/resolve] error', err)
      trackEvent(
        'question_resolve_error',
        {
          gameId,
          questionId,
          error: String(err),
        },
        req.user?.uid
      )
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  }
)

// PREDICTION ROUTES
router.post(
  '/:gameId/questions/:questionId/prediction',
  authMiddleware,
  async (req, res) => {
    const { gameId, questionId } = req.params
    const {
      prediction,
      notificationViewedAt,
      notificationSentAt,
      notificationDisplayedAt,
      source,
      questionTimeoutAt,
      questionPayload,
      questionSignature,
      choiceTappedAt,
      predictionSentAt,
    } = req.body || {}

    console.log(
      '[questions/prediction]',
      gameId,
      questionId,
      'prediction',
      prediction,
      'source',
      source
    )

    if (!req.user?.uid) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!prediction) {
      return res.status(400).json({ error: 'prediction is required' })
    }

    try {
      const userId = req.user.uid
      const now = admin.firestore.FieldValue.serverTimestamp()
      const nowMs = Date.now()
      const normalizedSource = typeof source === 'string' ? source : 'unknown'

      const verifiedQuestionPayload = verifyQuestionPayload(
        typeof questionPayload === 'string' ? questionPayload : undefined,
        typeof questionSignature === 'string' ? questionSignature : undefined
      )

      const parsedNotificationSentAt =
        typeof notificationSentAt === 'string'
          ? Number(notificationSentAt)
          : notificationSentAt
      const parsedNotificationDisplayedAt =
        typeof notificationDisplayedAt === 'string'
          ? Number(notificationDisplayedAt)
          : notificationDisplayedAt
      const parsedNotificationViewedAt =
        typeof notificationViewedAt === 'string'
          ? Number(notificationViewedAt)
          : notificationViewedAt
      const parsedChoiceTappedAt =
        typeof choiceTappedAt === 'string'
          ? Number(choiceTappedAt)
          : choiceTappedAt
      const parsedPredictionSentAt =
        typeof predictionSentAt === 'string'
          ? Number(predictionSentAt)
          : predictionSentAt

      const effectiveQuestionTimeoutAt =
        (typeof questionTimeoutAt === 'string'
          ? Number(questionTimeoutAt)
          : questionTimeoutAt) ??
        (verifiedQuestionPayload?.timeoutAt as number | undefined)

      // Calculate time remaining server-side for accuracy
      let timeRemaining: number | undefined
      if (effectiveQuestionTimeoutAt) {
        timeRemaining = effectiveQuestionTimeoutAt - nowMs
      }

      // Practice/onboarding submissions: store on user record only, skip game stats
      if (gameId === 'onboarding') {
        await db
          .collection('users')
          .doc(userId)
          .set(
            {
              onboardingPrediction: {
                questionId,
                prediction,
                source: normalizedSource,
                questionTimeoutAt,
                createdAt: now,
                createdAtMs: Date.now(),
              },
            },
            { merge: true }
          )

        trackEvent(
          'onboarding_practice_prediction',
          {
            userId,
            questionId,
            prediction,
            source: normalizedSource,
          },
          userId
        )

        return res.json({ ok: true, practice: true })
      }

      const isPractice =
        gameId?.startsWith('practice-') ||
        (verifiedQuestionPayload as any)?.practice === true ||
        (req.body?.practice as any) === true

      if (isPractice) {
        const practicePredictionRef = db
          .collection('users')
          .doc(userId)
          .collection('practice')
          .doc('predictions')
          .collection('items')
          .doc(questionId)

        const practiceQuestionRef = db
          .collection('users')
          .doc(userId)
          .collection('practice')
          .doc('questions')
          .collection('items')
          .doc(questionId)

        const practicePayload: any = {
          prediction,
          source: normalizedSource,
          questionTimeoutAt: effectiveQuestionTimeoutAt,
          createdAt: now,
          createdAtMs: Date.now(),
        }

        if (verifiedQuestionPayload) {
          practicePayload.questionPayload = verifiedQuestionPayload
          practicePayload.questionSignature = questionSignature
        }

        // Fetch stored practice question to grab the predetermined answer
        const practiceQuestionSnap = await practiceQuestionRef.get()
        const practiceQuestionData = practiceQuestionSnap.data() as any
        const resolvedAnswer =
          practiceQuestionData?.answer || practiceQuestionData?.randomAnswer

        await practicePredictionRef.set(practicePayload, { merge: true })

        // Resolve after min(5s after answer, timeout)
        const resolveDelay = (() => {
          if (effectiveQuestionTimeoutAt) {
            const timeUntilTimeout = effectiveQuestionTimeoutAt - nowMs
            return Math.max(0, Math.min(5000, timeUntilTimeout))
          }
          return 5000
        })()

        setTimeout(async () => {
          try {
            await practiceQuestionRef.set(
              {
                state: 'resolved',
                answer: resolvedAnswer ?? null,
                resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
          } catch (err) {
            console.error('[practice/prediction] failed to resolve', err)
          }
        }, resolveDelay)

        trackEvent(
          'practice_prediction',
          {
            userId,
            questionId,
            prediction,
            source: normalizedSource,
          },
          userId
        )

        return res.json({ ok: true, practice: true })
      }

      const predictionRef = db
        .collection('games')
        .doc(gameId)
        .collection('questions')
        .doc(questionId)
        .collection('predictions')
        .doc(userId)

      const userPredictionRef = db
        .collection('users')
        .doc(userId)
        .collection('games')
        .doc(gameId)
        .collection('predictions')
        .doc(questionId)

      // Derive timing metrics (ms) when data is available
      const createdAtMs = Date.now()
      const deliveryMs =
        parsedNotificationSentAt !== undefined &&
        parsedNotificationDisplayedAt !== undefined
          ? parsedNotificationDisplayedAt - parsedNotificationSentAt
          : undefined
      const openMs =
        parsedNotificationDisplayedAt !== undefined &&
        parsedNotificationViewedAt !== undefined
          ? parsedNotificationViewedAt - parsedNotificationDisplayedAt
          : undefined
      const respondMs =
        parsedNotificationDisplayedAt !== undefined
          ? createdAtMs - parsedNotificationDisplayedAt
          : undefined
      const timeRemainingAtReceive =
        parsedNotificationDisplayedAt !== undefined &&
        effectiveQuestionTimeoutAt !== undefined
          ? effectiveQuestionTimeoutAt - parsedNotificationDisplayedAt
          : undefined
      const timeRemainingAtOpen =
        parsedNotificationViewedAt !== undefined &&
        effectiveQuestionTimeoutAt !== undefined
          ? effectiveQuestionTimeoutAt - parsedNotificationViewedAt
          : undefined
      const tapToSendMs =
        parsedChoiceTappedAt !== undefined &&
        parsedPredictionSentAt !== undefined
          ? parsedPredictionSentAt - parsedChoiceTappedAt
          : undefined
      const tapToAckMs =
        parsedChoiceTappedAt !== undefined
          ? createdAtMs - parsedChoiceTappedAt
          : undefined

      const payload: any = {
        prediction,
        source: normalizedSource,
        questionTimeoutAt: effectiveQuestionTimeoutAt,
        timeRemaining,
        createdAt: now,
        createdAtMs,
      }

      if (parsedNotificationViewedAt !== undefined)
        payload.notificationViewedAt = parsedNotificationViewedAt
      if (parsedNotificationSentAt !== undefined)
        payload.notificationSentAt = parsedNotificationSentAt
      if (parsedNotificationDisplayedAt !== undefined)
        payload.notificationDisplayedAt = parsedNotificationDisplayedAt
      if (deliveryMs !== undefined) payload.deliveryMs = deliveryMs
      if (openMs !== undefined) payload.openMs = openMs
      if (respondMs !== undefined) payload.respondMs = respondMs
      if (timeRemainingAtReceive !== undefined)
        payload.timeRemainingAtReceive = timeRemainingAtReceive
      if (timeRemainingAtOpen !== undefined)
        payload.timeRemainingAtOpen = timeRemainingAtOpen
      if (parsedChoiceTappedAt !== undefined)
        payload.choiceTappedAt = parsedChoiceTappedAt
      if (parsedPredictionSentAt !== undefined)
        payload.predictionSentAt = parsedPredictionSentAt
      if (tapToSendMs !== undefined) payload.tapToSendMs = tapToSendMs
      if (tapToAckMs !== undefined) payload.tapToAckMs = tapToAckMs
      if (verifiedQuestionPayload) {
        payload.questionPayload = verifiedQuestionPayload
        payload.questionSignature = questionSignature
      }

      await Promise.all([
        predictionRef.set(payload, { merge: true }),
        userPredictionRef.set(payload, { merge: true }),
      ])

      const eventProps: any = {
        gameId,
        questionId,
        userId,
        prediction,
        source,
      }

      if (parsedNotificationViewedAt !== undefined)
        eventProps.notificationViewedAt = parsedNotificationViewedAt
      if (parsedNotificationSentAt !== undefined)
        eventProps.notificationSentAt = parsedNotificationSentAt
      if (parsedNotificationDisplayedAt !== undefined)
        eventProps.notificationDisplayedAt = parsedNotificationDisplayedAt
      if (deliveryMs !== undefined) eventProps.deliveryMs = deliveryMs
      if (openMs !== undefined) eventProps.openMs = openMs
      if (respondMs !== undefined) eventProps.respondMs = respondMs
      if (timeRemainingAtReceive !== undefined)
        eventProps.timeRemainingAtReceive = timeRemainingAtReceive
      if (timeRemainingAtOpen !== undefined)
        eventProps.timeRemainingAtOpen = timeRemainingAtOpen
      if (timeRemaining !== undefined) eventProps.timeRemaining = timeRemaining
      if (timeRemaining !== undefined)
        eventProps.timeRemainingSeconds = Math.floor(timeRemaining / 1000)
      if (parsedChoiceTappedAt !== undefined)
        eventProps.choiceTappedAt = parsedChoiceTappedAt
      if (parsedPredictionSentAt !== undefined)
        eventProps.predictionSentAt = parsedPredictionSentAt
      if (tapToSendMs !== undefined) eventProps.tapToSendMs = tapToSendMs
      if (tapToAckMs !== undefined) eventProps.tapToAckMs = tapToAckMs
      if (verifiedQuestionPayload)
        eventProps.questionPayloadVersion =
          verifiedQuestionPayload.version ?? QUESTION_PAYLOAD_VERSION

      trackEvent('prediction_submitted', eventProps, userId)

      return res.json({ ok: true })
    } catch (err) {
      console.error('[questions/prediction] error', err)
      trackEvent(
        'prediction_submit_error',
        {
          gameId,
          questionId,
          userId: req.user?.uid,
          error: String(err),
        },
        req.user?.uid
      )
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  }
)

export default router

const getPercentile = (sortedArray: number[], percentile: number): number => {
  if (sortedArray.length === 0) return 0
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
  return sortedArray[Math.max(0, index)]
}

const normalizePredictionValue = (value: any): string => {
  const str = String(value).toLowerCase()
  if (str === 'true' || str === 'yes' || str === '1') return 'true'
  if (str === 'false' || str === 'no' || str === '0') return 'false'
  return str
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

  const totalQuestionsAsked = questions.length
  let totalResponses = 0
  let totalCorrect = 0
  let totalIncorrect = 0

  const deliveryAvgs: number[] = []
  const openAvgs: number[] = []
  const respondAvgs: number[] = []
  const responseRates: number[] = []
  let highestPlayerCount: number | undefined

  resolvedQuestions.forEach((q: any) => {
    const stats = q.statistics || {}
    totalResponses += stats.totalResponses || 0
    if (stats.correctCount !== undefined) totalCorrect += stats.correctCount
    if (stats.incorrectCount !== undefined)
      totalIncorrect += stats.incorrectCount

    if (typeof stats.delivery?.avg === 'number')
      deliveryAvgs.push(stats.delivery.avg)
    if (typeof stats.open?.avg === 'number') openAvgs.push(stats.open.avg)
    if (typeof stats.respond?.avg === 'number')
      respondAvgs.push(stats.respond.avg)
    if (typeof stats.responseRate === 'number')
      responseRates.push(stats.responseRate)
  })

  const peakSnap = await admin
    .firestore()
    .collection(`games/${gameId}/playerCounts`)
    .orderBy('count', 'desc')
    .limit(1)
    .get()
  if (!peakSnap.empty) highestPlayerCount = peakSnap.docs[0].data().count

  const avgResponsesPerQuestion = totalQuestionsAsked
    ? totalResponses / totalQuestionsAsked
    : 0

  const totalPredictions = totalCorrect + totalIncorrect
  const accuracyRate =
    totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0

  const buildMetric = (arr: number[]) =>
    arr.length
      ? {
          avg: arr.reduce((a, b) => a + b, 0) / arr.length,
          p50: getPercentile(
            [...arr].sort((a, b) => a - b),
            50
          ),
          p95: getPercentile(
            [...arr].sort((a, b) => a - b),
            95
          ),
        }
      : undefined

  const gameStats: any = {
    totalQuestionsAsked,
    totalResolved: resolvedQuestions.length,
    totalCancelled: cancelledQuestions.length,
    totalResponses,
    avgResponsesPerQuestion: Math.round(avgResponsesPerQuestion * 100) / 100,
    totalCorrect,
    totalIncorrect,
    accuracyRate: Math.round(accuracyRate * 100) / 100,
    highestPlayerCount,
  }

  const deliveryMetric = buildMetric(deliveryAvgs)
  const openMetric = buildMetric(openAvgs)
  const respondMetric = buildMetric(respondAvgs)
  const responseRateMetric = buildMetric(responseRates)

  if (deliveryMetric) gameStats.delivery = deliveryMetric
  if (openMetric) gameStats.open = openMetric
  if (respondMetric) gameStats.respond = respondMetric
  if (responseRateMetric) gameStats.responseRateMetric = responseRateMetric

  console.log('Game statistics:', gameStats)

  await admin.firestore().doc(`games/${gameId}`).update({
    statistics: gameStats,
  })

  console.log('Successfully saved game statistics')
}

const distributeWinnings = async (
  gameId: string,
  game: any
): Promise<{ userId: string; amount: number; type: 'USD' | 'POINTS' }[]> => {
  console.log('Calculating winnings for game', gameId)

  if (!game.leaderboard || game.leaderboard.length === 0) {
    console.log('No leaderboard to distribute winnings from')
    return []
  }

  const topScore = game.leaderboard[0].score
  const prizeAmount = game.prizeAmount ?? game.prize ?? 0
  const prizeType: 'USD' | 'POINTS' = game.prizeType || 'USD'

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
  const prizePerWinner = prizeAmount / numWinners

  console.log(
    `Distributing ${prizeType} ${prizeAmount} to ${numWinners} first place winner(s) with score ${topScore}: each ${prizePerWinner}`
  )

  const batch = admin.firestore().batch()
  const winnerNotifications: {
    userId: string
    amount: number
    type: 'USD' | 'POINTS'
  }[] = []

  winnerDocs.docs.forEach((winnerDoc) => {
    const userId = winnerDoc.id
    const userRef = admin.firestore().doc(`users/${userId}`)

    if (prizeType === 'USD') {
      batch.update(userRef, {
        winnings: admin.firestore.FieldValue.increment(prizePerWinner),
      })
    } else {
      batch.update(userRef, {
        points: admin.firestore.FieldValue.increment(prizePerWinner),
      })
    }

    winnerNotifications.push({
      userId,
      amount: prizePerWinner,
      type: prizeType,
    })
  })

  await batch.commit()
  console.log('Winnings distributed successfully')

  return winnerNotifications
}

const notifyWinners = async (
  winnerNotifications: {
    userId: string
    amount: number
    type: 'USD' | 'POINTS'
  }[],
  game: any
) => {
  if (winnerNotifications.length === 0) {
    console.log('No winners to notify...')
    return
  }

  console.log(`Notifying ${winnerNotifications.length} winners`)

  await Promise.all(
    winnerNotifications.map(async ({ userId, amount, type: prizeType }) => {
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

      const tokens = Object.values(
        userData.tokens as { token?: string } | Record<string, any>
      ) as { token?: string }[]
      for (const tokenData of tokens) {
        const token = tokenData?.token
        if (!token) continue

        const dataPayload = {
          gameId: String(game.id || ''),
          winnings: String(amount),
          prizeType: prizeType,
        }

        const prizeText =
          prizeType === 'USD' ? `$${amount.toFixed(2)}` : `${amount} Whistles`

        const message = {
          token,
          notification: {
            title: '🎉 You Won!',
            body: `Congratulations! You won ${prizeText} in ${game.homeTeam} vs. ${game.awayTeam}!`,
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
  const delta = opts.revertIfResolved && question.state === 'cancelled' ? -1 : 1

  if (correctUsers.length > 0) {
    await updateScores(gameId, correctUsers, delta)
  }

  await calculateQuestionStatistics(gameId, questionId, question)
  await updateLeaderboard(gameId)
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
    .get()

  const normalizedAnswer = normalizePredictionValue(question.answer)

  return predictionsSnap.docs
    .filter(
      (d) =>
        normalizePredictionValue((d.data() as any).prediction) ===
        normalizedAnswer
    )
    .map((d) => d.id)
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
    const state = doc.data().state
    const totalCountSnap = await admin
      .firestore()
      .collection(`games/${gameId}/users`)
      .count()
      .get()
    const playerCount = totalCountSnap.data().count
    const [iosCountSnap, androidCountSnap] = await Promise.all([
      admin
        .firestore()
        .collection(`games/${gameId}/users`)
        .where('platform', '==', 'ios')
        .count()
        .get(),
      admin
        .firestore()
        .collection(`games/${gameId}/users`)
        .where('platform', '==', 'android')
        .count()
        .get(),
    ])
    const playerCountByPlatform = {
      ios: iosCountSnap.data().count,
      android: androidCountSnap.data().count,
      unknown: Math.max(
        0,
        playerCount - iosCountSnap.data().count - androidCountSnap.data().count
      ),
    }

    const isSameCount = doc.data().playerCount === playerCount

    // Always record history for open games
    if (state === 'open') {
      const now = Date.now().toString()
      await admin.firestore().doc(`games/${gameId}/playerCounts/${now}`).set({
        count: playerCount,
        ios: playerCountByPlatform.ios,
        android: playerCountByPlatform.android,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }

    // Skip updating main doc if count hasn't changed
    if (isSameCount) continue

    await admin.firestore().doc(`games/${gameId}`).set(
      {
        playerCount,
        playerCountByPlatform,
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

  const topic = `game_${gameId}` //'app_notifications'
  const collapseId = `game_${gameId}`
  const message = {
    topic,
    notification: {
      title: 'Game Started!',
      body: `${game.homeTeam} vs ${game.awayTeam} is now live. Get ready to play!`,
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
        channelId: 'questions',
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
      trackEvent('question_closed', {
        gameId,
        questionId,
        method: 'timeout',
      })
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
  const normalizedAnswer = normalizePredictionValue(question.answer)
  const correctCount = predsSnap.docs.filter((d) => {
    const pred = (d.data() as any).prediction
    return normalizePredictionValue(pred) === normalizedAnswer
  }).length
  const incorrectCount = totalResponses - correctCount
  const deliveries = predsSnap.docs
    .map((d) => (d.data() as any).deliveryMs as number | undefined)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const opens = predsSnap.docs
    .map((d) => (d.data() as any).openMs as number | undefined)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const responds = predsSnap.docs
    .map((d) => (d.data() as any).respondMs as number | undefined)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const remainingReceive = predsSnap.docs
    .map((d) => (d.data() as any).timeRemainingAtReceive as number | undefined)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const remainingOpen = predsSnap.docs
    .map((d) => (d.data() as any).timeRemainingAtOpen as number | undefined)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v))
  const nseMissingCount = predsSnap.docs.filter(
    (d) => (d.data() as any).notificationReceivedAt === undefined
  ).length
  const responseSourceCounts: Record<string, number> = {}
  const platformBuckets: Record<
    string,
    {
      totalResponses: number
      correctCount: number
      incorrectCount: number
      deliveries: number[]
      opens: number[]
      responds: number[]
      remainingReceive: number[]
      remainingOpen: number[]
    }
  > = {}
  const platformFromSource = (src?: string) => {
    if (!src || typeof src !== 'string') return 'unknown'
    const lower = src.toLowerCase()
    if (lower.includes('ios')) return 'ios'
    if (lower.includes('android')) return 'android'
    return 'unknown'
  }
  predsSnap.docs.forEach((d) => {
    const data = d.data() as any
    const src = typeof data.source === 'string' ? data.source : 'unknown'
    responseSourceCounts[src] = (responseSourceCounts[src] || 0) + 1

    const platform = platformFromSource(src)
    if (!platformBuckets[platform]) {
      platformBuckets[platform] = {
        totalResponses: 0,
        correctCount: 0,
        incorrectCount: 0,
        deliveries: [],
        opens: [],
        responds: [],
        remainingReceive: [],
        remainingOpen: [],
      }
    }
    const bucket = platformBuckets[platform]
    bucket.totalResponses += 1
    const predVal = (data as any).prediction
    const isCorrect = normalizePredictionValue(predVal) === normalizedAnswer
    if (isCorrect) bucket.correctCount += 1
    else bucket.incorrectCount += 1
    if (typeof (data as any).deliveryMs === 'number')
      bucket.deliveries.push((data as any).deliveryMs)
    if (typeof (data as any).openMs === 'number')
      bucket.opens.push((data as any).openMs)
    if (typeof (data as any).respondMs === 'number')
      bucket.responds.push((data as any).respondMs)
    if (typeof (data as any).timeRemainingAtReceive === 'number')
      bucket.remainingReceive.push((data as any).timeRemainingAtReceive)
    if (typeof (data as any).timeRemainingAtOpen === 'number')
      bucket.remainingOpen.push((data as any).timeRemainingAtOpen)
  })

  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined
  const metric = (arr: number[]) =>
    arr.length
      ? {
          avg: avg(arr)!,
          p50: getPercentile(
            [...arr].sort((a, b) => a - b),
            50
          ),
          p95: getPercentile(
            [...arr].sort((a, b) => a - b),
            95
          ),
        }
      : undefined

  const statistics: any = {
    totalResponses,
    correctCount,
    incorrectCount,
    nseMissingCount,
    responseSourceCounts,
    responseByPlatform: Object.fromEntries(
      Object.entries(platformBuckets).map(([platform, bucket]) => {
        const obj: any = {
          totalResponses: bucket.totalResponses,
          correctCount: bucket.correctCount,
          incorrectCount: bucket.incorrectCount,
        }
        if (bucket.deliveries.length) obj.delivery = metric(bucket.deliveries)
        if (bucket.opens.length) obj.open = metric(bucket.opens)
        if (bucket.responds.length) obj.respond = metric(bucket.responds)
        if (bucket.remainingReceive.length)
          obj.timeRemainingAtReceive = metric(bucket.remainingReceive)
        if (bucket.remainingOpen.length)
          obj.timeRemainingAtOpen = metric(bucket.remainingOpen)
        return [platform, obj]
      })
    ),
  }

  const gameSnap = await admin.firestore().doc(`games/${gameId}`).get()
  const playerCount = (gameSnap.data() as any)?.playerCount as
    | number
    | undefined
  if (playerCount !== undefined) {
    statistics.playerCount = playerCount
    statistics.responseRate =
      playerCount > 0 ? totalResponses / playerCount : undefined
    statistics.unanswered = playerCount - totalResponses
  }

  if (deliveries.length) statistics.delivery = metric(deliveries)
  if (opens.length) statistics.open = metric(opens)
  if (responds.length) statistics.respond = metric(responds)
  if (remainingReceive.length)
    statistics.timeRemainingAtReceive = metric(remainingReceive)
  if (remainingOpen.length)
    statistics.timeRemainingAtOpen = metric(remainingOpen)

  // Choice distribution
  const choiceCounts: Record<string, number> = {}
  predsSnap.docs.forEach((d) => {
    const pred = (d.data() as any).prediction
    if (typeof pred === 'string') {
      choiceCounts[pred] = (choiceCounts[pred] || 0) + 1
    }
  })
  statistics.choiceCounts = choiceCounts

  await admin.firestore().doc(`games/${gameId}/questions/${questionId}`).set(
    {
      statistics,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
}

const updateLeaderboard = async (gameId: string) => {
  const calculatePlaces = (
    leaderboardDocs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]
  ) => {
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

  // Retrieve top 100 users (sorted by score desc, then username asc)
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

export const endGameById = async (gameId: string, userId?: string) => {
  const gameRef = db.collection('games').doc(gameId)
  const gameSnap = await gameRef.get()
  if (!gameSnap.exists) {
    return { status: 404 }
  }
  const game = gameSnap.data() as any
  if (game?.state === 'resolved') {
    return { status: 200, alreadyResolved: true }
  }

  await gameRef.set(
    {
      state: 'resolved',
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  await calculateGameStatistics(gameId)
  const winnerNotifications = await distributeWinnings(gameId, game)
  await notifyWinners(winnerNotifications, game)
  const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing!`
  await sendNotificationsToGameUsers(gameId, message)

  trackEvent(
    'game_ended',
    {
      gameId,
      userId,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      source: userId ? 'manual' : 'worker',
    },
    userId
  )

  return { status: 200 }
}
