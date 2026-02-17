import { Router } from 'express'
import { admin } from '../firebase'
import { trackEvent } from '../lib/mixpanel'
import { sendFeedbackToSlack } from '../lib/slack'
import { authMiddleware } from '../middleware/auth'

const router = Router()

type FeedbackBody = {
  text?: string
  gameId?: string
  funRating?: number | string
  questionVolume?: string
  questionTiming?: string
}

type QuestionVolume = 'too_many' | 'just_right' | 'too_few'
type QuestionTiming = 'too_early' | 'too_late' | 'good_timing'

const parseRating = (value: number | string | undefined) => {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

const isValidRating = (value: number | undefined) =>
  value !== undefined && value >= 1 && value <= 5

const isQuestionVolume = (value: string | undefined): value is QuestionVolume =>
  value === 'too_many' || value === 'just_right' || value === 'too_few'

const isQuestionTiming = (value: string | undefined): value is QuestionTiming =>
  value === 'too_early' || value === 'too_late' || value === 'good_timing'

router.post('/', authMiddleware, async (req, res) => {
  const userId = req.user?.uid
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    text,
    gameId: gameIdRaw,
    funRating: funRatingRaw,
    questionVolume: questionVolumeRaw,
    questionTiming: questionTimingRaw,
  } = (req.body || {}) as FeedbackBody

  const feedbackText = typeof text === 'string' ? text.trim() : ''
  const gameId = typeof gameIdRaw === 'string' ? gameIdRaw.trim() : ''
  const funRating = parseRating(funRatingRaw)
  const questionVolume =
    typeof questionVolumeRaw === 'string'
      ? questionVolumeRaw.trim().toLowerCase()
      : undefined
  const questionTiming =
    typeof questionTimingRaw === 'string'
      ? questionTimingRaw.trim().toLowerCase()
      : undefined
  const hasGameFeedbackInputs =
    funRatingRaw !== undefined ||
    questionVolumeRaw !== undefined ||
    questionTimingRaw !== undefined

  if (feedbackText.length > 5000) {
    return res
      .status(400)
      .json({ error: 'Feedback text must be 5000 characters or less' })
  }
  if (!feedbackText && !gameId) {
    return res.status(400).json({ error: 'Feedback text is required' })
  }
  if (!gameId && hasGameFeedbackInputs) {
    return res
      .status(400)
      .json({ error: 'Game ID is required for game feedback fields' })
  }
  if (
    gameId &&
    (!isValidRating(funRating) ||
      !isQuestionVolume(questionVolume) ||
      !isQuestionTiming(questionTiming))
  ) {
    return res.status(400).json({
      error:
        'All game feedback fields are required and invalid values were provided',
    })
  }

  try {
    const feedbackDoc: {
      userId: string
      text?: string
      gameId?: string
      funRating?: number
      questionVolume?: QuestionVolume
      questionTiming?: QuestionTiming
      createdAt: FirebaseFirestore.FieldValue
      updatedAt: FirebaseFirestore.FieldValue
    } = {
      userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    if (feedbackText) feedbackDoc.text = feedbackText
    if (
      gameId &&
      isValidRating(funRating) &&
      isQuestionVolume(questionVolume) &&
      isQuestionTiming(questionTiming)
    ) {
      feedbackDoc.gameId = gameId
      feedbackDoc.funRating = funRating
      feedbackDoc.questionVolume = questionVolume
      feedbackDoc.questionTiming = questionTiming
    }

    const docRef = await admin
      .firestore()
      .collection('feedback')
      .add(feedbackDoc)

    console.log(
      `[feedback/create] feedbackId=${docRef.id} userId=${userId} gameId=${gameId || 'none'} textLength=${feedbackText.length}`
    )

    trackEvent(
      'feedback_submitted',
      {
        feedbackId: docRef.id,
        userId,
        gameId: gameId || null,
        textLength: feedbackText.length,
        funRating: funRating ?? null,
        questionVolume: questionVolume || null,
        questionTiming: questionTiming || null,
        hasText: feedbackText.length > 0,
        source: 'backend',
      },
      userId
    )

    try {
      await sendFeedbackToSlack({
        feedbackId: docRef.id,
        userId,
        gameId: gameId || undefined,
        funRating,
        questionVolume,
        questionTiming,
        text: feedbackText,
      })
      console.log(
        `[feedback/slack] delivered feedbackId=${docRef.id} userId=${userId}`
      )
    } catch (slackError) {
      console.error(
        `[feedback/slack] failed feedbackId=${docRef.id} userId=${userId}`,
        slackError
      )
    }

    return res.status(201).json({ ok: true, feedbackId: docRef.id })
  } catch (error) {
    console.error(`[feedback/create] failed userId=${userId}`, error)
    return res.status(500).json({ error: 'Failed to create feedback' })
  }
})

export default router
