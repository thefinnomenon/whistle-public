import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  EventType,
} from '@notifee/react-native'
import { getApp } from '@react-native-firebase/app'
import { getAuth } from '@react-native-firebase/auth'
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  Timestamp,
} from '@react-native-firebase/firestore'
import {
  getMessaging,
  getToken,
  onTokenRefresh as onTokenRefreshModular,
  requestPermission,
} from '@react-native-firebase/messaging'
import { Linking, Platform } from 'react-native'

export interface NotificationPermissionResult {
  granted: boolean
  status: 'authorized' | 'denied' | 'not_determined'
  canRequest: boolean
}

/**
 * Check current notification permission status
 */
export async function checkNotificationPermission(): Promise<NotificationPermissionResult> {
  const settings = await notifee.getNotificationSettings()

  if (
    settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
  ) {
    return { granted: true, status: 'authorized', canRequest: false }
  }

  if (settings.authorizationStatus === AuthorizationStatus.DENIED) {
    return { granted: false, status: 'denied', canRequest: false }
  }

  return { granted: false, status: 'not_determined', canRequest: true }
}

/**
 * Request notification permission
 * Returns true if granted, false otherwise
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const currentStatus = await checkNotificationPermission()

  // Already granted
  if (currentStatus.granted) {
    return true
  }

  // Already denied - can't request again
  if (currentStatus.status === 'denied') {
    return false
  }

  // Request permission
  const result = await notifee.requestPermission({
    provisional: false, // Set to true for iOS quiet notifications
  })

  const granted =
    result.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
    result.authorizationStatus === AuthorizationStatus.PROVISIONAL

  // If granted, also request Firebase Messaging permission on iOS
  if (granted && Platform.OS === 'ios') {
    const app = getApp()
    const messaging = getMessaging(app)
    await requestPermission(messaging)
  }

  return granted
}

/**
 * Get FCM token for push notifications
 * Returns null if APNS is not configured (development)
 */
export async function getFCMToken(): Promise<string | null> {
  try {
    const app = getApp()
    const messaging = getMessaging(app)
    const token = await getToken(messaging)
    return token
  } catch (error) {
    console.warn('Could not get FCM token (APNS not configured):', error)
    return null
  }
}

/**
 * Setup FCM token refresh listener
 * Returns an unsubscribe function
 */
export function onTokenRefresh(callback: (token: string) => void): () => void {
  const app = getApp()
  const messaging = getMessaging(app)
  return onTokenRefreshModular(messaging, (token) => {
    console.log('[FCM] Token refreshed:', token)
    callback(token)
  })
}

/**
 * Open app notification settings
 */
export async function openAppNotificationSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    await Linking.openSettings()
  } else {
    await notifee.openNotificationSettings()
  }
}

/**
 * Create a notification channel (Android only)
 */
export async function createNotificationChannel(
  channelId: string,
  name: string,
  importance: AndroidImportance = AndroidImportance.HIGH
): Promise<string> {
  return await notifee.createChannel({
    id: channelId,
    name,
    importance,
    sound: 'whistle',
  })
}

/**
 * Display a local notification
 */
export async function displayNotification(
  title: string,
  body: string,
  options?: {
    channelId?: string
    categoryId?: string
    actions?: { title: string; id: string }[]
    data?: Record<string, any>
  }
): Promise<string> {
  // Create channel if needed (Android)
  let channelId = options?.channelId
  if (Platform.OS === 'android' && !channelId) {
    channelId = await createNotificationChannel(
      'default',
      'Default Notifications'
    )
  }

  if (Platform.OS === 'android') {
    return await notifee.displayNotification({
      title,
      body,
      data: options?.data,
      android: {
        channelId: channelId!,
        importance: AndroidImportance.HIGH,
        smallIcon: 'ic_small_icon',
        color: '#000000',
        sound: 'whistle',
        pressAction: {
          id: 'default',
        },
        actions: options?.actions?.map((action) => ({
          title: action.title,
          pressAction: { id: action.id },
        })),
      },
    })
  }

  // iOS: let the OS handle display (no-op here)
  return 'ios-os-display'
}

/**
 * Cancel a notification by ID
 */
export async function cancelNotification(
  notificationId: string
): Promise<void> {
  await notifee.cancelNotification(notificationId)
}

/**
 * Handle notification action press (Yes/No buttons)
 */
export async function handleNotificationActionPress(
  actionId: string | undefined,
  data: Record<string, any> | undefined,
  analytics: { track: (event: string, data: any) => void },
  logContext: 'Background' | 'Foreground' = 'Foreground'
): Promise<void> {
  // Skip practice/onboarding actions from writing predictions
  if (data?.practice === 'true') {
    console.log(
      `[Notification ${logContext}] Practice notification action, skipping prediction`
    )
    return
  }

  if (actionId !== 'yes' && actionId !== 'no') {
    return
  }

  const {
    gameId,
    questionId,
    triggeredAt,
    createdAt,
    sentAt,
    receivedAt,
    engineTag,
  } = data || {}

  if (!gameId || !questionId) {
    return
  }

  try {
    const answeredAt = Date.now()
    const prediction = actionId === 'yes'
    const app = getApp()
    const auth = getAuth(app)
    const firestore = getFirestore(app)
    const userId = auth.currentUser?.uid

    if (!userId) {
      console.warn(`[Notification ${logContext}] No user ID available`)
      return
    }

    // Write to question predictions collection (for scoring)
    const predictionRef = doc(
      firestore,
      `games/${gameId}/questions/${questionId}/predictions/${userId}`
    )

    // Store timing metadata for delivery time calculations
    const predictionData: any = {
      prediction,
      createdAt: Timestamp.now(),
      source: 'app',
    }

    if (sentAt) {
      predictionData.sentAt = parseInt(sentAt as string)
    }
    if (receivedAt) {
      predictionData.receivedAt = parseInt(receivedAt as string)
    }

    console.log(
      `[Notification ${logContext}] Prediction data:`,
      JSON.stringify(predictionData)
    )
    console.log(
      `[Notification ${logContext}] Data keys:`,
      Object.keys(predictionData)
    )

    await setDoc(predictionRef, predictionData)

    // Write to user predictions subcollection (for UI display)
    const userPredictionRef = doc(
      firestore,
      `users/${userId}/games/${gameId}/predictions/${questionId}`
    )

    await setDoc(userPredictionRef, {
      prediction,
      createdAt: serverTimestamp(),
      source: 'app',
    })

    console.log(`[Notification ${logContext}] Submitted answer: ${prediction}`)

    // Track to Mixpanel with all timing data
    const timingData: any = {
      game_id: gameId,
      question_id: questionId,
      prediction,
      answered_at: answeredAt,
      engine_tag: engineTag || null,
    }

    if (triggeredAt) {
      timingData.triggered_at = parseInt(triggeredAt as string)
      timingData.trigger_to_answered_ms =
        answeredAt - parseInt(triggeredAt as string)
    }
    if (createdAt) {
      timingData.created_at = parseInt(createdAt as string)
      timingData.created_to_answered_ms =
        answeredAt - parseInt(createdAt as string)
    }
    if (sentAt) {
      timingData.sent_at = parseInt(sentAt as string)
      timingData.sent_to_answered_ms = answeredAt - parseInt(sentAt as string)
    }
    if (receivedAt) {
      timingData.received_at = parseInt(receivedAt as string)
      timingData.delivery_latency_ms =
        parseInt(receivedAt as string) - parseInt((sentAt as string) || '0')
      timingData.answer_latency_ms = answeredAt - parseInt(receivedAt as string)
    }

    analytics.track('question_answered', timingData)
    console.log('[Mixpanel] Tracked question_answered with timing data')
  } catch (error) {
    console.error(
      `[Notification ${logContext}] Error submitting answer:`,
      error
    )
  }
}

/**
 * Handle notification dismissal and track missed questions
 */
export async function handleNotificationDismissed(
  data: Record<string, any> | undefined,
  analytics: { track: (event: string, data: any) => void }
): Promise<void> {
  if (data?.practice === 'true') {
    console.log(
      '[Notification] Practice notification dismissed, skipping tracking'
    )
    return
  }

  const {
    gameId,
    questionId,
    triggeredAt,
    createdAt,
    sentAt,
    receivedAt,
    engineTag,
  } = data || {}

  if (gameId && questionId) {
    try {
      const missedAt = Date.now()
      const timingData: any = {
        game_id: gameId,
        question_id: questionId,
        missed_at: missedAt,
        engine_tag: engineTag || null,
      }

      if (triggeredAt) {
        timingData.triggered_at = parseInt(triggeredAt as string)
        timingData.trigger_to_missed_ms =
          missedAt - parseInt(triggeredAt as string)
      }
      if (createdAt) {
        timingData.created_at = parseInt(createdAt as string)
        timingData.created_to_missed_ms =
          missedAt - parseInt(createdAt as string)
      }
      if (sentAt) {
        timingData.sent_at = parseInt(sentAt as string)
        timingData.sent_to_missed_ms = missedAt - parseInt(sentAt as string)
      }
      if (receivedAt && sentAt) {
        timingData.received_at = parseInt(receivedAt as string)
        timingData.delivery_latency_ms =
          parseInt(receivedAt as string) - parseInt(sentAt as string)
        timingData.displayed_duration_ms =
          missedAt - parseInt(receivedAt as string)
      }

      analytics.track('question_missed', timingData)
      console.log('[Mixpanel] Tracked question_missed with timing data')
    } catch (error) {
      console.error('[Notification] Error tracking missed question:', error)
    }
  }
}

/**
 * Unified notification event handler
 * Handles both ACTION_PRESS and DISMISSED events
 */
export async function handleNotificationEvent(
  type: number,
  detail: any,
  analytics: { track: (event: string, data: any) => void },
  context: 'Background' | 'Foreground' = 'Foreground'
): Promise<void> {
  console.log(`[Notification Event] Type: ${type}, Context: ${context}`)
  console.log(`[Notification Event] Action ID: ${detail.pressAction?.id}`)

  if (type === EventType.ACTION_PRESS) {
    console.log('[Notification Event] Handling ACTION_PRESS')
    await handleNotificationActionPress(
      detail.pressAction?.id,
      detail.notification?.data,
      analytics,
      context
    )
  } else if (type === EventType.DISMISSED) {
    console.log('[Notification Event] Handling DISMISSED')
    await handleNotificationDismissed(detail.notification?.data, analytics)
  }
}
