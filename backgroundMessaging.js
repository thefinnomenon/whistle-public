import notifee, { AndroidImportance } from '@notifee/react-native'
import messaging from '@react-native-firebase/messaging'

// Background message handler for React Native Firebase
messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('[FCM Background] Message received in background:', remoteMessage)

  // Check if this is a question notification
  const isQuestion = remoteMessage.data?.questionId

  if (isQuestion) {
    console.log(
      '[FCM Background] Displaying question notification with actions'
    )

    // Create notification channel for Android
    const channelId = await notifee.createChannel({
      id: 'default',
      name: 'Default Notifications',
      importance: AndroidImportance.HIGH,
      sound: 'whistle',
    })

    // Display notification with action buttons using notifee
    const notificationId = await notifee.displayNotification({
      title: remoteMessage.data?.title || '🏈 New Question!',
      body: remoteMessage.data?.body || remoteMessage.data?.question || '',
      data: remoteMessage.data,
      android: {
        channelId,
        importance: AndroidImportance.HIGH,
        smallIcon: 'ic_small_icon',
        color: '#000000', // Black background for notification icon
        sound: 'whistle',
        pressAction: {
          id: 'default',
        },
        actions: [
          {
            title: '✅ Yes',
            pressAction: { id: 'yes' },
          },
          {
            title: '❌ No',
            pressAction: { id: 'no' },
          },
        ],
        timeoutAfter: 30000, // Auto-dismiss after 30 seconds
      },
      ios: {
        categoryId: 'YESNO',
        sound: 'whistle.wav',
        foregroundPresentationOptions: {
          alert: true,
          badge: true,
          sound: true,
        },
      },
    })

    // Schedule auto-dismiss for iOS after 30 seconds (Android uses timeoutAfter above)
    setTimeout(async () => {
      try {
        await notifee.cancelNotification(notificationId)
        console.log('[FCM Background] Auto-dismissed notification after 30s')
      } catch (error) {
        console.log('[FCM Background] Failed to auto-dismiss:', error)
      }
    }, 30000)

    console.log('[FCM Background] Notification displayed with actions')
  } else {
    console.log(
      '[FCM Background] Non-question notification, using default handling'
    )
  }
})
