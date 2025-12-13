import { admin } from '../firebase'

export const sendDismissNotification = async (
  gameId: string,
  questionId: string,
  collapseId: string
) => {
  const message = {
    topic: collapseId,
    data: {
      type: 'question_expired',
      gameId,
      questionId,
      collapseId,
    },
    android: {
      collapseKey: collapseId,
      priority: 'high' as const,
      notification: {
        tag: collapseId,
        channelId: 'default',
      },
    },
    apns: {
      headers: {
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-collapse-id': collapseId,
      },
      payload: {
        aps: {
          'content-available': 1,
        },
      },
    },
  }

  await admin.messaging().send(message as any)
}
