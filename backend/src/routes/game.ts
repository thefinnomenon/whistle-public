import { createHash, createHmac } from 'crypto'
import { Router } from 'express'
import { admin, db } from '../firebase'
import { scheduleGameStartQuestions } from '../lib/engine'
import {
  buildPayoutPlan,
  CASH_ELIGIBILITY_MIN_ANSWERS,
  CashEligibilityResult,
  evaluateCashEligibility,
} from '../lib/gamePayout'
import { simulateStoredGame } from '../lib/gameSimulation'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../lib/eventReplayStorage'
import {
  identifyUser,
  incrementUserProperty,
  trackEvent,
} from '../lib/mixpanel'
import { sendDismissNotification } from '../lib/notifications'
import {
  calculateQuestionScoreUpdate,
  calculateQuestionPoints,
  getStoredQuestionPoints,
} from '../lib/questionPoints'
import {
  buildQuestionCreatedProps,
  buildQuestionResolvedProps,
  buildQuestionSentProps,
  deriveQuestionDimensions,
  QUESTION_ANALYTICS_SCHEMA_VERSION,
  toLatencyBucket,
} from '../lib/questionAnalytics'
import { authMiddleware } from '../middleware/auth'
import { isAdminMiddleware } from '../middleware/isAdmin'
import type { EngineGameState } from '../types/engine'

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
type SignedPayloadValue =
  | string
  | number
  | boolean
  | null
  | SignedPayloadValue[]
  | { [key: string]: SignedPayloadValue }

type SignedQuestionPayload = {
  version: number
  gameId: string
  questionId: string
  question: string
  choices: {
    id: string
    value: string
    [key: string]: SignedPayloadValue
  }[]
  timeoutAt: number | null
  engineTag?: string
  [key: string]: SignedPayloadValue | undefined
}

type TimestampLikeValue =
  | admin.firestore.Timestamp
  | Date
  | number
  | string
  | null
  | undefined

type QuestionDocData = {
  state?: string
  question?: string
  answer?: string
  timeoutAt?: number | string | null
  engineTag?: string
  engineVersion?: string
  templateId?: string
  trigger?: string
  windowType?: string
  cancelReason?: string
  createdAt?: TimestampLikeValue
  triggeredAt?: TimestampLikeValue
  closedAt?: TimestampLikeValue
  resolvedAt?: TimestampLikeValue
  cancelledAt?: TimestampLikeValue
  choices?: { id?: string; value?: string }[]
}

type PredictionRequestBody = {
  prediction?: string | number | boolean
  notificationViewedAt?: string | number
  notificationSentAt?: string | number
  notificationDisplayedAt?: string | number
  source?: string
  questionTimeoutAt?: string | number
  questionPayload?: string
  questionSignature?: string
  choiceTappedAt?: string | number
  predictionSentAt?: string | number
  practice?: boolean
}

type PredictionWrite = {
  prediction: string
  source: string
  questionTimeoutAt?: number
  timeRemaining?: number
  createdAt: admin.firestore.FieldValue
  createdAtMs: number
  notificationViewedAt?: number
  notificationSentAt?: number
  notificationDisplayedAt?: number
  deliveryMs?: number
  openMs?: number
  respondMs?: number
  timeRemainingAtReceive?: number
  timeRemainingAtOpen?: number
  choiceTappedAt?: number
  predictionSentAt?: number
  tapToSendMs?: number
  tapToAckMs?: number
  questionPayload?: SignedQuestionPayload
  questionSignature?: string
}

type PredictionTransactionResult = {
  question: QuestionDocData
  timeRemaining?: number
}

type FirestoreError = Error & { code?: string | number }

const isFirestoreErrorCode = (
  error: Error,
  stringCode: string,
  numericCode: number
): boolean => {
  const code = (error as FirestoreError).code
  return code === stringCode || code === numericCode
}

const PREDICTION_SUBMISSION_GRACE_MS = 2_000

const parseOptionalNumber = (value: string | number | undefined) => {
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(parsed) ? parsed : undefined
}

const normalizeSubmittedPrediction = (
  value: string | number | boolean | undefined
): string | null => {
  if (value === undefined) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

const toMs = (value: TimestampLikeValue): number | null => {
  if (!value) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'object' && 'toMillis' in value) {
    const timestamp = value as admin.firestore.Timestamp
    const ms = timestamp.toMillis()
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

const normalizeOriginalQuestion = (
  doc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
) => {
  const data = doc.data() as QuestionDocData
  return {
    id: doc.id,
    state: typeof data.state === 'string' ? data.state : 'unknown',
    question: typeof data.question === 'string' ? data.question : '',
    answer: typeof data.answer === 'string' ? data.answer : null,
    timeoutAtMs: toMs(data.timeoutAt),
    engineTag: typeof data.engineTag === 'string' ? data.engineTag : null,
    engineVersion:
      typeof data.engineVersion === 'string' ? data.engineVersion : null,
    templateId: typeof data.templateId === 'string' ? data.templateId : null,
    trigger: typeof data.trigger === 'string' ? data.trigger : null,
    windowType: typeof data.windowType === 'string' ? data.windowType : null,
    cancelReason:
      typeof data.cancelReason === 'string' ? data.cancelReason : null,
    createdAtMs: toMs(data.createdAt),
    triggeredAtMs: toMs(data.triggeredAt),
    closedAtMs: toMs(data.closedAt),
    resolvedAtMs: toMs(data.resolvedAt),
    cancelledAtMs: toMs(data.cancelledAt),
  }
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
): SignedQuestionPayload | undefined => {
  if (!payloadString || !signature || !QUESTION_SIGNATURE_SECRET) return
  const expected = createHmac('sha256', QUESTION_SIGNATURE_SECRET)
    .update(payloadString)
    .digest('hex')
  if (expected !== signature) return
  try {
    const payload = JSON.parse(payloadString) as SignedQuestionPayload
    if (
      typeof payload.version !== 'number' ||
      typeof payload.gameId !== 'string' ||
      typeof payload.questionId !== 'string' ||
      typeof payload.question !== 'string' ||
      !Array.isArray(payload.choices)
    ) {
      return
    }
    return payload
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
    const points = calculateQuestionPoints(payloadChoices.length)

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId,
      question: payloadQuestion,
      choices: payloadChoices,
      points,
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
        points: String(points),
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
    const points = calculateQuestionPoints(payloadChoices.length)

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
        points,
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
      points,
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
        points: String(points),
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
      .orderBy('eventId', 'asc')

    if (rawSince !== undefined) {
      query = query.where('eventId', '>', Number(rawSince))
    }

    const snap = await query.limit(limit).get()
    const events = snap.docs.map((doc) => ({
      id: doc.id,
      ...hydrateStoredEngineEvent(doc.data() as StoredEngineEvent),
    }))
    const lastActionNumber =
      events.length > 0 ? (events[events.length - 1]?.eventId ?? null) : null

    return res.json({ ok: true, events, lastActionNumber })
  } catch (error) {
    console.error('[games/events] error', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

router.get('/:gameId/simulate', isAdminMiddleware, async (req, res) => {
  try {
    const { gameId } = req.params
    const [simulation, originalQuestionsSnap] = await Promise.all([
      simulateStoredGame(gameId),
      db
        .collection('games')
        .doc(gameId)
        .collection('questions')
        .orderBy('createdAt', 'asc')
        .get(),
    ])

    const originalQuestions = originalQuestionsSnap.docs.map(
      normalizeOriginalQuestion
    )

    return res.json({
      ok: true,
      gameId,
      simulation,
      originalQuestions,
      originalCounts: {
        total: originalQuestions.length,
        resolved: originalQuestions.filter((q) => q.state === 'resolved')
          .length,
        cancelled: originalQuestions.filter((q) => q.state === 'cancelled')
          .length,
        openOrClosed: originalQuestions.filter(
          (q) => q.state === 'open' || q.state === 'closed'
        ).length,
      },
      simulatedAtMs: Date.now(),
    })
  } catch (error) {
    console.error('[games/simulate] error', error)
    if (error instanceof Error) {
      if (error.message.startsWith('Game not found:')) {
        return res.status(404).json({ error: error.message })
      }
      if (error.message.startsWith('No events found for game')) {
        return res.status(400).json({ error: error.message })
      }
    }
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
    const points = calculateQuestionPoints(choices.length)

    const baseQuestionPayload = {
      version: QUESTION_PAYLOAD_VERSION,
      gameId,
      questionId,
      question: questionText,
      choices,
      points,
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
      points: String(points),
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
      windowType,
      type = 'YESNO',
    } = req.body || {}
    if (!req.user?.uid) return res.status(401).json({ error: 'Unauthorized' })
    if (!gameId || !question) {
      return res.status(400).json({ error: 'gameId and question are required' })
    }

    const gameSnap = await db.collection('games').doc(gameId).get()
    const game = gameSnap.exists ? (gameSnap.data() as any) : null
    const homeTeam = game?.homeTeam ?? null
    const awayTeam = game?.awayTeam ?? null
    const title =
      homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : 'New Question'
    const submittedChoices = Array.isArray(choices) ? choices : []
    const points = calculateQuestionPoints(submittedChoices.length)

    const questionPayload = {
      question,
      choices: submittedChoices,
      points,
      type,
      state: 'open',
      timeoutAt: timeoutAt ? timeoutAt : null,
      engineTag: engineTag || '',
      ...(windowType ? { windowType } : {}),
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
      choices: submittedChoices,
      points,
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
      title,
      sentAt: now.toString(),
      engineTag: engineTag || '',
      collapseId,
      choices: JSON.stringify(submittedChoices),
      points: String(points),
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
              title,
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

    const normalizedChoices = Array.isArray(choices)
      ? (choices as { id?: string; value?: string }[]).map((choice) => ({
          id: String(choice?.id ?? ''),
          value: String(choice?.value ?? ''),
        }))
      : []
    const dimensions = deriveQuestionDimensions({
      templateId: typeof engineTag === 'string' ? engineTag : type,
      trigger: 'manual',
      windowType: typeof windowType === 'string' ? windowType : null,
      questionText: typeof question === 'string' ? question : null,
      choices: normalizedChoices,
    })
    const createdCanonical = buildQuestionCreatedProps({
      gameId,
      league: typeof game?.league === 'string' ? game.league : 'NBA',
      questionId: qRef.id,
      expectedResolutionTimeMs: Number(timeoutAt),
      dimensions,
    })

    trackEvent(
      'question_created',
      {
        ...createdCanonical,
        gameId,
        questionId: qRef.id,
        type,
        timeoutAt,
        choices,
        engineTag: engineTag || '',
      },
      req.user?.uid
    )

    try {
      const usersSnap = await db
        .collection('games')
        .doc(gameId)
        .collection('users')
        .get()
      const sentAtMs = now
      for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id
        trackEvent(
          'question_sent',
          buildQuestionSentProps({
            questionId: qRef.id,
            userId,
            gameId,
            sendTimestampMs: sentAtMs,
            dimensions,
          }),
          userId
        )
      }
    } catch (error) {
      console.error(
        `[questions/create] analytics question_sent failed game=${gameId} question=${qRef.id}`,
        error
      )
    }

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
            cancelReason: 'MANUAL',
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
      trackEvent(
        'question_resolved',
        {
          ...buildQuestionResolvedProps({
            questionId,
            gameId,
            resolvedTimestampMs: Date.now(),
            outcome: null,
            resolutionType: 'void',
            voidReason: 'manual_cancel',
          }),
          schema_version: QUESTION_ANALYTICS_SCHEMA_VERSION,
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
          ...buildQuestionResolvedProps({
            questionId,
            gameId,
            resolvedTimestampMs: Date.now(),
            outcome:
              String(answer).trim().toLowerCase() === 'tie'
                ? null
                : String(answer),
            resolutionType:
              String(answer).trim().toLowerCase() === 'tie' ? 'void' : 'normal',
            voidReason:
              String(answer).trim().toLowerCase() === 'tie' ? 'tie' : null,
          }),
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
    const body = (req.body || {}) as PredictionRequestBody
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
    } = body
    const normalizedPrediction = normalizeSubmittedPrediction(prediction)

    console.log(
      '[questions/prediction]',
      gameId,
      questionId,
      'prediction',
      normalizedPrediction,
      'source',
      source
    )

    if (!req.user?.uid) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (normalizedPrediction === null) {
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

      const parsedNotificationSentAt = parseOptionalNumber(notificationSentAt)
      const parsedNotificationDisplayedAt = parseOptionalNumber(
        notificationDisplayedAt
      )
      const parsedNotificationViewedAt =
        parseOptionalNumber(notificationViewedAt)
      const parsedChoiceTappedAt = parseOptionalNumber(choiceTappedAt)
      const parsedPredictionSentAt = parseOptionalNumber(predictionSentAt)

      const effectiveQuestionTimeoutAt =
        parseOptionalNumber(questionTimeoutAt) ??
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
                prediction: normalizedPrediction,
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
            prediction: normalizedPrediction,
            source: normalizedSource,
          },
          userId
        )

        return res.json({ ok: true, practice: true })
      }

      const isPractice =
        gameId?.startsWith('practice-') ||
        (verifiedQuestionPayload as any)?.practice === true ||
        body.practice === true

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
          prediction: normalizedPrediction,
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
            prediction: normalizedPrediction,
            source: normalizedSource,
          },
          userId
        )

        return res.json({ ok: true, practice: true })
      }

      const questionRef = db
        .collection('games')
        .doc(gameId)
        .collection('questions')
        .doc(questionId)
      const predictionRef = questionRef.collection('predictions').doc(userId)
      const memberRef = db.doc(`games/${gameId}/users/${userId}`)

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

      let submission: PredictionTransactionResult
      try {
        submission = await db.runTransaction<PredictionTransactionResult>(
          async (transaction) => {
            const questionSnap = await transaction.get(questionRef)
            if (!questionSnap.exists) throw new Error('QUESTION_NOT_FOUND')

            const questionData = questionSnap.data() as QuestionDocData
            if (questionData.state !== 'open') {
              throw new Error('QUESTION_CLOSED')
            }
            const authoritativeTimeoutAt = toMs(questionData.timeoutAt)
            if (
              authoritativeTimeoutAt !== null &&
              nowMs > authoritativeTimeoutAt + PREDICTION_SUBMISSION_GRACE_MS
            ) {
              throw new Error('QUESTION_EXPIRED')
            }
            const normalizedChoice = normalizedPrediction.toLowerCase()
            const validChoices = Array.isArray(questionData.choices)
              ? questionData.choices
              : []
            if (
              validChoices.length > 0 &&
              !validChoices.some(
                (choice) =>
                  String(choice.id ?? '')
                    .trim()
                    .toLowerCase() === normalizedChoice ||
                  String(choice.value ?? '')
                    .trim()
                    .toLowerCase() === normalizedChoice
              )
            ) {
              throw new Error('INVALID_CHOICE')
            }

            const serverTimeoutAt =
              authoritativeTimeoutAt ?? effectiveQuestionTimeoutAt
            const authoritativeTimeRemaining =
              serverTimeoutAt === undefined
                ? undefined
                : serverTimeoutAt - nowMs
            const authoritativeTimeRemainingAtReceive =
              parsedNotificationDisplayedAt !== undefined &&
              serverTimeoutAt !== undefined
                ? serverTimeoutAt - parsedNotificationDisplayedAt
                : undefined
            const authoritativeTimeRemainingAtOpen =
              parsedNotificationViewedAt !== undefined &&
              serverTimeoutAt !== undefined
                ? serverTimeoutAt - parsedNotificationViewedAt
                : undefined
            const payload: PredictionWrite = {
              prediction: normalizedPrediction,
              source: normalizedSource,
              ...(serverTimeoutAt !== undefined
                ? { questionTimeoutAt: serverTimeoutAt }
                : {}),
              ...(authoritativeTimeRemaining !== undefined
                ? { timeRemaining: authoritativeTimeRemaining }
                : {}),
              createdAt: now,
              createdAtMs,
              ...(parsedNotificationViewedAt !== undefined
                ? { notificationViewedAt: parsedNotificationViewedAt }
                : {}),
              ...(parsedNotificationSentAt !== undefined
                ? { notificationSentAt: parsedNotificationSentAt }
                : {}),
              ...(parsedNotificationDisplayedAt !== undefined
                ? { notificationDisplayedAt: parsedNotificationDisplayedAt }
                : {}),
              ...(deliveryMs !== undefined ? { deliveryMs } : {}),
              ...(openMs !== undefined ? { openMs } : {}),
              ...(respondMs !== undefined ? { respondMs } : {}),
              ...(authoritativeTimeRemainingAtReceive !== undefined
                ? {
                    timeRemainingAtReceive: authoritativeTimeRemainingAtReceive,
                  }
                : {}),
              ...(authoritativeTimeRemainingAtOpen !== undefined
                ? { timeRemainingAtOpen: authoritativeTimeRemainingAtOpen }
                : {}),
              ...(parsedChoiceTappedAt !== undefined
                ? { choiceTappedAt: parsedChoiceTappedAt }
                : {}),
              ...(parsedPredictionSentAt !== undefined
                ? { predictionSentAt: parsedPredictionSentAt }
                : {}),
              ...(tapToSendMs !== undefined ? { tapToSendMs } : {}),
              ...(tapToAckMs !== undefined ? { tapToAckMs } : {}),
              ...(verifiedQuestionPayload
                ? {
                    questionPayload: verifiedQuestionPayload,
                    ...(questionSignature ? { questionSignature } : {}),
                  }
                : {}),
            }

            transaction.create(predictionRef, payload)
            transaction.update(
              memberRef,
              new admin.firestore.FieldPath(
                'predictionsByQuestionId',
                questionId
              ),
              normalizedPrediction,
              'answersSubmitted',
              admin.firestore.FieldValue.increment(1),
              'updatedAt',
              now
            )
            return {
              question: questionData,
              timeRemaining: authoritativeTimeRemaining,
            }
          }
        )
      } catch (error) {
        const transactionError =
          error instanceof Error ? error : new Error(String(error))
        if (isFirestoreErrorCode(transactionError, 'already-exists', 6)) {
          return res.json({ ok: true, duplicate: true, accepted: false })
        }
        if (isFirestoreErrorCode(transactionError, 'not-found', 5)) {
          throw new Error('NOT_IN_GAME')
        }
        throw transactionError
      }

      const questionData = submission.question
      timeRemaining = submission.timeRemaining
      const questionChoices = Array.isArray(questionData.choices)
        ? questionData.choices.map((choice) => ({
            id: String(choice.id ?? ''),
            value: String(choice.value ?? ''),
          }))
        : []
      const dimensions = deriveQuestionDimensions({
        templateId:
          questionData.engineTag ||
          questionData.templateId ||
          verifiedQuestionPayload?.engineTag ||
          null,
        trigger: questionData.trigger || null,
        windowType: questionData.windowType || null,
        questionText: questionData.question || null,
        choices: questionChoices,
      })

      const eventProps: Record<string, string | number | boolean | undefined> =
        {
          gameId,
          questionId,
          userId,
          prediction: normalizedPrediction,
          source: normalizedSource,
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

      const answeredTimestamp = new Date(createdAtMs).toISOString()
      const wasPushOpen =
        parsedNotificationViewedAt !== undefined ||
        normalizedSource.includes('notification')
      const timeToAnswerMs =
        parsedNotificationDisplayedAt !== undefined
          ? createdAtMs - parsedNotificationDisplayedAt
          : parsedNotificationViewedAt !== undefined
            ? createdAtMs - parsedNotificationViewedAt
            : null
      const latencyAtAnswerMs =
        deliveryMs !== undefined && Number.isFinite(deliveryMs)
          ? deliveryMs
          : null
      const latencyBucket = toLatencyBucket(latencyAtAnswerMs)

      trackEvent(
        'question_answered',
        {
          question_id: questionId,
          user_id: userId,
          game_id: gameId,
          answered_timestamp: answeredTimestamp,
          answer: normalizedPrediction,
          time_to_answer_ms: timeToAnswerMs,
          was_push_open: wasPushOpen,
          latency_at_answer_ms: latencyAtAnswerMs,
          latency_bucket: latencyBucket,
          question_type: dimensions.question_type,
          trigger_type: dimensions.trigger_type,
          time_horizon: dimensions.time_horizon,
          question_structure: dimensions.question_structure,
          predictability_bucket: dimensions.predictability_bucket,
          schema_version: QUESTION_ANALYTICS_SCHEMA_VERSION,
        },
        userId
      )

      trackEvent('prediction_submitted', eventProps, userId)
      incrementUserProperty(userId, 'predictions_submitted_count', 1)
      identifyUser(userId, {
        last_prediction_at: new Date().toISOString(),
        last_prediction_game_id: gameId,
      })

      return res.json({ ok: true, accepted: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[questions/prediction] error', err)
      trackEvent(
        'prediction_submit_error',
        {
          gameId,
          questionId,
          userId: req.user?.uid,
          error: message,
        },
        req.user?.uid
      )
      if (message === 'QUESTION_NOT_FOUND') {
        return res.status(404).json({ error: 'Question not found' })
      }
      if (message === 'NOT_IN_GAME') {
        return res.status(403).json({ error: 'Join the game before answering' })
      }
      if (message === 'QUESTION_CLOSED' || message === 'QUESTION_EXPIRED') {
        return res.status(409).json({ error: 'This answer window has closed' })
      }
      if (message === 'INVALID_CHOICE') {
        return res.status(400).json({ error: 'Invalid answer choice' })
      }
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

const normalizePredictionValue = (
  value: string | number | boolean | null | undefined
): string => {
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

type PayoutGameDocument = {
  state?: string
  isFeatured?: boolean
  prizeAmount?: number
  prizeAmountCents?: number
  prize?: number
  prizeType?: 'USD' | 'POINTS'
  payoutStatus?: 'processing' | 'completed'
}

type PayoutMemberDocument = {
  score?: number
  predictionsByQuestionId?: Record<string, string>
}

type PayoutUserDocument = {
  winnings?: number
  winningsCents?: number
  points?: number
}

type WinnerNotification = {
  userId: string
  amount: number
  type: 'USD' | 'POINTS'
}

const finiteNumber = (value: number | undefined, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const commitEligibilityResults = async (
  gameId: string,
  eligibility: CashEligibilityResult[]
): Promise<void> => {
  const chunkSize = 400
  for (let offset = 0; offset < eligibility.length; offset += chunkSize) {
    const batch = db.batch()
    for (const result of eligibility.slice(offset, offset + chunkSize)) {
      batch.set(
        db.doc(`games/${gameId}/users/${result.userId}`),
        {
          cashEligibility: {
            qualified: result.qualified,
            answered: result.answered,
            requiredAnswers: result.requiredAnswers,
            reason: result.reason,
          },
          cashEligibilityCalculatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    await batch.commit()
  }
}

const runInBatches = async <T>(
  items: T[],
  size: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(task))
  }
}

export const distributeWinnings = async (
  gameId: string
): Promise<WinnerNotification[]> => {
  console.log(`[payout] game=${gameId} stage=calculate`)
  const gameRef = db.collection('games').doc(gameId)
  const [gameSnap, memberSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('users').get(),
  ])
  if (!gameSnap.exists) return []
  const game = gameSnap.data() as PayoutGameDocument
  if (game.payoutStatus === 'completed') {
    console.log(`[payout] game=${gameId} skipped=already_completed`)
    return []
  }

  const prizeType = game.prizeType ?? 'USD'
  const members = memberSnap.docs.map((memberDoc) => {
    const data = memberDoc.data() as PayoutMemberDocument
    return {
      userId: memberDoc.id,
      score: finiteNumber(data.score),
      predictionsByQuestionId: data.predictionsByQuestionId ?? {},
    }
  })
  const eligibility =
    prizeType === 'USD' && game.isFeatured
      ? evaluateCashEligibility(members)
      : members.map<CashEligibilityResult>((member) => ({
          userId: member.userId,
          score: member.score,
          answered: Object.keys(member.predictionsByQuestionId).length,
          requiredAnswers: 0,
          qualified: true,
          reason: 'qualified',
        }))

  if (prizeType === 'USD' && game.isFeatured) {
    await commitEligibilityResults(gameId, eligibility)
  }

  const prizeAmount = finiteNumber(game.prizeAmount ?? game.prize)
  const totalUnits =
    prizeType === 'USD'
      ? Math.max(0, Math.round(game.prizeAmountCents ?? prizeAmount * 100))
      : Math.max(0, Math.floor(prizeAmount))
  const plan = buildPayoutPlan(
    totalUnits,
    eligibility.map((entrant) => ({
      userId: entrant.userId,
      score: entrant.score,
      eligible: entrant.qualified,
    }))
  )
  const now = admin.firestore.FieldValue.serverTimestamp()
  await gameRef.set(
    {
      payoutStatus: 'processing',
      payoutPrizeType: prizeType,
      payoutTotalUnits: plan.totalUnits,
      payoutWinnerCount: plan.winners.length,
      cashWinnerUserIds:
        prizeType === 'USD'
          ? plan.winners.map((winner) => winner.userId)
          : admin.firestore.FieldValue.delete(),
      payoutEligiblePlayerCount: eligibility.filter(
        (entrant) => entrant.qualified
      ).length,
      payoutTopScore: plan.topScore,
      cashEligibilityMinAnswers:
        prizeType === 'USD' && game.isFeatured
          ? CASH_ELIGIBILITY_MIN_ANSWERS
          : null,
      cashEligibilityMinRate: admin.firestore.FieldValue.delete(),
      payoutStartedAt: now,
      updatedAt: now,
    },
    { merge: true }
  )

  const newlyCreditedUserIds = new Set<string>()
  await runInBatches(plan.winners, 10, async (winner) => {
    const payoutRef = gameRef.collection('payouts').doc(winner.userId)
    const userRef = db.collection('users').doc(winner.userId)
    const credited = await db.runTransaction<boolean>(async (transaction) => {
      const [payoutSnap, userSnap] = await Promise.all([
        transaction.get(payoutRef),
        transaction.get(userRef),
      ])
      if (payoutSnap.exists) return false
      if (!userSnap.exists)
        throw new Error(`PAYOUT_USER_MISSING:${winner.userId}`)
      const user = userSnap.data() as PayoutUserDocument

      if (prizeType === 'USD') {
        const existingCents = Number.isFinite(user.winningsCents)
          ? Math.round(user.winningsCents ?? 0)
          : Math.round(finiteNumber(user.winnings) * 100)
        const nextCents = existingCents + winner.amountUnits
        transaction.update(userRef, {
          winningsCents: nextCents,
          winnings: nextCents / 100,
          updatedAt: now,
        })
      } else {
        transaction.update(userRef, {
          points: finiteNumber(user.points) + winner.amountUnits,
          updatedAt: now,
        })
      }
      transaction.create(payoutRef, {
        userId: winner.userId,
        amountUnits: winner.amountUnits,
        prizeType,
        status: 'credited',
        createdAt: now,
      })
      return true
    })
    if (credited) newlyCreditedUserIds.add(winner.userId)
  })

  await gameRef.set(
    {
      payoutStatus: 'completed',
      payoutCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
  console.log(
    `[payout] game=${gameId} stage=completed type=${prizeType} units=${plan.totalUnits} winners=${plan.winners.length}`
  )

  return plan.winners
    .filter((winner) => newlyCreditedUserIds.has(winner.userId))
    .map((winner) => ({
      userId: winner.userId,
      amount:
        prizeType === 'USD' ? winner.amountUnits / 100 : winner.amountUnits,
      type: prizeType,
    }))
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

export const calculateScores = async (
  gameId: string,
  questionId: string,
  opts: { revertIfResolved?: boolean } = {}
) => {
  type ScoreQuestionData = {
    state?: string
    answer?: string | number | boolean | null
    points?: number
    scoredAnswer?: string | null
  }
  type ScorePredictionData = {
    prediction?: string | number | boolean | null
  }
  type ScorePlayerData = {
    score?: number
    scoreByQuestionId?: Record<string, number>
  }

  const firestore = admin.firestore()
  const questionRef = firestore.doc(`games/${gameId}/questions/${questionId}`)
  const questionSnap = await questionRef.get()
  if (!questionSnap.exists) return
  const question = questionSnap.data() as ScoreQuestionData

  if (opts.revertIfResolved && question.state !== 'cancelled') return

  const isCancellation =
    opts.revertIfResolved === true && question.state === 'cancelled'
  const points = getStoredQuestionPoints(question)
  const desiredAnswer = isCancellation
    ? null
    : question.answer === undefined || question.answer === null
      ? null
      : normalizePredictionValue(question.answer)
  const previousAnswer = question.scoredAnswer
    ? normalizePredictionValue(question.scoredAnswer)
    : null
  const predictionsSnap = await firestore
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .get()
  const predictionsByUserId = new Map(
    predictionsSnap.docs.map((predictionDoc) => [
      predictionDoc.id,
      (predictionDoc.data() as ScorePredictionData).prediction,
    ])
  )
  const affectedUserIds = [...predictionsByUserId.entries()]
    .filter(([, prediction]) => {
      const normalizedPrediction = normalizePredictionValue(prediction)
      return (
        normalizedPrediction === desiredAnswer ||
        normalizedPrediction === previousAnswer
      )
    })
    .map(([userId]) => userId)

  const applyUserScore = async (userId: string): Promise<boolean> => {
    const userRef = firestore.doc(`games/${gameId}/users/${userId}`)
    return firestore.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef)
      const player = userSnap.exists ? (userSnap.data() as ScorePlayerData) : {}
      const storedAwards = player.scoreByQuestionId ?? {}
      const previousAward = Number.isFinite(storedAwards[questionId])
        ? storedAwards[questionId]
        : 0
      const prediction = predictionsByUserId.get(userId) ?? null
      const desiredAward =
        desiredAnswer !== null &&
        normalizePredictionValue(prediction) === desiredAnswer
          ? points
          : 0
      const currentScore =
        typeof player.score === 'number' && Number.isFinite(player.score)
          ? player.score
          : 0
      const scoreUpdate = calculateQuestionScoreUpdate(
        currentScore,
        previousAward,
        desiredAward
      )
      if (!scoreUpdate.changed) return false

      const nextAwards = { ...storedAwards }
      if (desiredAward > 0) nextAwards[questionId] = desiredAward
      else delete nextAwards[questionId]
      transaction.set(
        userRef,
        {
          score: scoreUpdate.score,
          scoreByQuestionId: nextAwards,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      return true
    })
  }
  const transactionConcurrency = 25
  for (
    let offset = 0;
    offset < affectedUserIds.length;
    offset += transactionConcurrency
  ) {
    await Promise.all(
      affectedUserIds
        .slice(offset, offset + transactionConcurrency)
        .map(applyUserScore)
    )
  }

  if (desiredAnswer !== null || isCancellation) {
    await questionRef.set(
      {
        scoredAnswer: desiredAnswer ?? previousAnswer,
        scoredPoints: points,
        scoreState: isCancellation ? 'cancelled' : 'resolved',
        scoreUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
  }

  await calculateQuestionStatistics(
    gameId,
    questionId,
    question,
    predictionsSnap
  )
  await updateLeaderboard(gameId)
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

  const shouldScheduleBasketballStartQuestions =
    game?.sport === 'BASKETBALL' ||
    game?.league === 'NBA' ||
    (!game?.sport && !game?.league)

  if (
    shouldScheduleBasketballStartQuestions &&
    !game?.gameStartQuestionsScheduledAt
  ) {
    const homeTeam = game?.homeTeam ?? null
    const awayTeam = game?.awayTeam ?? null
    const gameStartState: EngineGameState = {
      period: 1,
      clockMs: 12 * 60 * 1000,
      scoreHome: 0,
      scoreAway: 0,
      possession: null,
      boxScore: {
        gameId: game?.nbaGameId ?? null,
        gameStatus: game?.nbaGameStatus ?? null,
        gameStatusText: game?.nbaGameStatusText ?? '',
        period: 1,
        gameClock: null,
        homeTeam: homeTeam ? { teamTricode: homeTeam } : null,
        awayTeam: awayTeam ? { teamTricode: awayTeam } : null,
      },
    }
    scheduleGameStartQuestions(
      gameId,
      gameStartState,
      gameStartState.boxScore,
      {
        persistQuestions: true,
        winnerDelayMs: { min: 10_000, max: 30_000 },
        jumpBallDelayMs: { min: 60_000, max: 90_000 },
      }
    )
    await gameRef.set(
      {
        gameStartQuestionsScheduledAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
  }

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
  const cutoffMs = now.toMillis() - 5 * 60 * 1000
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
  let cancelled = 0
  for (const doc of gamesSnap.docs) {
    try {
      const startTime = doc.data()?.startTime as
        | admin.firestore.Timestamp
        | null
        | undefined
      if (startTime && startTime.toMillis() < cutoffMs) {
        await doc.ref.set(
          {
            state: 'cancelled',
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelReason: 'missed_open_window',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        cancelled++
        continue
      }
      await startGameById(doc.id)
      started++
    } catch (err) {
      console.error(`[games/startScheduledGames] failed for ${doc.id}`, err)
    }
  }

  if (started > 0)
    console.log(`[games/startScheduledGames] started ${started} games`)
  if (cancelled > 0)
    console.log(`[games/startScheduledGames] cancelled ${cancelled} games`)

  return started
}

export const closeExpiredQuestions = async (): Promise<number> => {
  const nowMs = Date.now()
  // Query open questions whose timeoutAt <= now
  const questionsSnap = await admin
    .firestore()
    .collectionGroup('questions')
    .where('state', '==', 'open')
    .where('timeoutAt', '<=', nowMs)
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
  question: { answer?: string | number | boolean | null },
  existingPredictions?: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>
) => {
  if (!question) return
  const predsSnap =
    existingPredictions ??
    (await admin
      .firestore()
      .collection(`games/${gameId}/questions/${questionId}/predictions`)
      .get())

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
    if (playerCount > 0) {
      statistics.responseRate = totalResponses / playerCount
    }
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
    .select('score', 'username')
    .limit(100)
    .get()

  // Calculate places
  const places = calculatePlaces(leaderboardQueryRes.docs)

  // Build new leaderboard
  const newLeaderboard = leaderboardQueryRes.docs.map((doc, index) => {
    const player = doc.data() as { score?: number; username?: string }
    return {
      place: places[index],
      userId: doc.id,
      score: finiteNumber(player.score),
      username: player.username ?? 'Player',
    }
  })

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
        type: 'game_end',
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
    trackEvent('game_end_notification_sent', {
      game_id: gameId,
      topic,
      source: 'backend',
    })
  } catch (error) {
    console.error(
      `Failed to send game end notification to topic ${topic}:`,
      error
    )
    trackEvent('game_end_notification_failed', {
      game_id: gameId,
      topic,
      error_message: String(error),
      source: 'backend',
    })
  }
}

export const endGameById = async (gameId: string, userId?: string) => {
  const gameRef = db.collection('games').doc(gameId)
  const resolution = await db.runTransaction(async (transaction) => {
    const gameSnap = await transaction.get(gameRef)
    if (!gameSnap.exists) return null
    const game = gameSnap.data() as PayoutGameDocument & {
      homeTeam?: string
      awayTeam?: string
    }
    const alreadyResolved = game.state === 'resolved'
    if (!alreadyResolved) {
      transaction.set(
        gameRef,
        {
          state: 'resolved',
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    return { game, alreadyResolved }
  })
  if (!resolution) return { status: 404 }
  const { game, alreadyResolved } = resolution
  if (alreadyResolved && game.payoutStatus === 'completed') {
    return { status: 200, alreadyResolved: true }
  }

  const openQuestionsSnap = await gameRef
    .collection('questions')
    .where('state', 'in', ['open', 'closed'])
    .get()
  if (!openQuestionsSnap.empty) {
    for (const doc of openQuestionsSnap.docs) {
      await doc.ref.set(
        {
          state: 'cancelled',
          cancelReason: 'VOID',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      await sendDismissNotification(gameId, doc.id, `game_${gameId}`)
      trackEvent(
        'question_resolved',
        buildQuestionResolvedProps({
          questionId: doc.id,
          gameId,
          resolvedTimestampMs: Date.now(),
          outcome: null,
          resolutionType: 'void',
          voidReason: 'game_end',
        })
      )
      console.log(
        `[game] cancel open question game=${gameId} question=${doc.id} reason=game_end`
      )
    }
  }

  await calculateGameStatistics(gameId)
  const winnerNotifications = await distributeWinnings(gameId)
  await notifyWinners(winnerNotifications, game)
  if (!alreadyResolved) {
    const message = `${game.homeTeam} vs. ${game.awayTeam} has ended. Thanks for playing! Please click to submit feedback about the game.`
    await sendNotificationsToGameUsers(gameId, message)
  }

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

  return { status: 200, alreadyResolved }
}
