import { getApp } from '@react-native-firebase/app'
import {
  getMessaging,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging'
import notifee from '@notifee/react-native'

// Handle silent dismiss messages in background/headless mode
if (!global.__fcmBackgroundHandlerRegistered) {
  global.__fcmBackgroundHandlerRegistered = true
  const app = getApp()
  const messagingInstance = getMessaging(app)

  setBackgroundMessageHandler(messagingInstance, async (remoteMessage) => {
    try {
      if (remoteMessage?.data?.type === 'question_expired') {
        const collapseId =
          remoteMessage.data.collapseId ||
          remoteMessage.data.gameId ||
          `msg-${remoteMessage.messageId || Date.now()}`
        await notifee.cancelDisplayedNotification(collapseId)
        await notifee.cancelNotification(collapseId)
        console.log('[FCM][BG] Cancelled expired notification', collapseId)
      }
    } catch (err) {
      console.warn('[FCM][BG] Failed to handle background message', err)
    }
  })
}
