import notifee, { AndroidImportance } from '@notifee/react-native'
import messaging from '@react-native-firebase/messaging'

// Background message handler for React Native Firebase
// This handles notifications when the app is in background or killed
messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('[FCM Background] Message received:', remoteMessage)

  const isQuestion = remoteMessage.data?.type === 'question'

  if (isQuestion) {
    const receivedAt = Date.now()

    // Create notification channel for Android
    const channelId = await notifee.createChannel({
      id: 'default',
      name: 'Default Notifications',
      importance: AndroidImportance.HIGH,
      sound: 'whistle',
    })

    // Display notification with action buttons
    await notifee.displayNotification({
      title: remoteMessage.notification?.title || '🏈 New Question!',
      body:
        remoteMessage.notification?.body || remoteMessage.data?.question || '',
      data: {
        ...remoteMessage.data,
        receivedAt: receivedAt.toString(),
      },
      android: {
        channelId,
        importance: AndroidImportance.HIGH,
        smallIcon: 'ic_small_icon',
        color: '#000000',
        sound: 'whistle',
        pressAction: { id: 'default' },
        actions: [
          { title: '✅ Yes', pressAction: { id: 'yes' } },
          { title: '❌ No', pressAction: { id: 'no' } },
        ],
        timeoutAfter: 30000,
      },
      ios: {
        categoryId: 'YESNO',
        sound: 'whistle.wav',
      },
    })

    console.log('[FCM Background] Notification displayed with actions')
  } else {
    // For non-question notifications, display them normally
    console.log('[FCM Background] Non-question notification')
  }
})
