type FeedbackSlackMessage = {
  feedbackId: string
  userId: string
  gameId?: string
  funRating?: number
  questionVolume?: string
  questionTiming?: string
  text: string
}

type SlackPostMessagePayload = {
  channel: string
  text: string
}

type SlackPostMessageResponse = {
  ok: boolean
  error?: string
}

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'
const FEEDBACK_SLACK_CHANNEL = '#whistle-feedback'
const MAX_FEEDBACK_PREVIEW = 1500

const normalizeForSlack = (value: string) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()

const buildFeedbackSlackMessage = ({
  feedbackId,
  userId,
  gameId,
  funRating,
  questionVolume,
  questionTiming,
  text,
}: FeedbackSlackMessage) => {
  const normalized = normalizeForSlack(text)
  const preview =
    normalized.length > MAX_FEEDBACK_PREVIEW
      ? `${normalized.slice(0, MAX_FEEDBACK_PREVIEW)}...`
      : normalized

  return [
    ':memo: New Whistle feedback submitted',
    `feedbackId=${feedbackId}`,
    `userId=${userId}`,
    `gameId=${gameId || 'none'}`,
    `funRating=${funRating ?? 'n/a'}`,
    `questionVolume=${questionVolume ?? 'n/a'}`,
    `questionTiming=${questionTiming ?? 'n/a'}`,
    `textLength=${normalized.length}`,
    '',
    preview || '[no free-text provided]',
  ].join('\n')
}

export const sendSlackMessage = async (channel: string, text: string) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[slack/send] dev_log', { channel, text })
    return
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN

  if (!slackBotToken) {
    console.warn(`[slack/send] skipped reason=missing_token channel=${channel}`)
    return
  }

  const payload: SlackPostMessagePayload = {
    channel,
    text,
  }

  const response = await fetch(SLACK_POST_MESSAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(
      `[slack/send] transport_error status=${response.status} body=${bodyText}`
    )
  }

  let parsed: SlackPostMessageResponse
  try {
    parsed = JSON.parse(bodyText) as SlackPostMessageResponse
  } catch {
    throw new Error(`[slack/send] invalid_json body=${bodyText}`)
  }

  if (!parsed.ok) {
    throw new Error(`[slack/send] api_error error=${parsed.error || 'unknown'}`)
  }
}

export const sendFeedbackToSlack = async (message: FeedbackSlackMessage) => {
  await sendSlackMessage(
    FEEDBACK_SLACK_CHANNEL,
    buildFeedbackSlackMessage({
      feedbackId: message.feedbackId,
      userId: message.userId,
      gameId: message.gameId,
      funRating: message.funRating,
      questionVolume: message.questionVolume,
      questionTiming: message.questionTiming,
      text: message.text,
    })
  )
}
