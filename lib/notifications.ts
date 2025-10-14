import notifee, {
  AndroidImportance,
  AuthorizationStatus,
  IOSNotificationCategory,
} from '@notifee/react-native'
import messaging from '@react-native-firebase/messaging'
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
 * Setup iOS notification categories for action buttons
 */
async function setupIOSCategories(): Promise<void> {
  if (Platform.OS !== 'ios') return

  const categories: IOSNotificationCategory[] = [
    {
      id: 'practice',
      actions: [
        {
          id: 'yes',
          title: '✅ Yes',
          foreground: true,
        },
        {
          id: 'no',
          title: '❌ No',
          foreground: true,
        },
      ],
    },
  ]

  await notifee.setNotificationCategories(categories)
}

/**
 * Request notification permission
 * Returns true if granted, false otherwise
 */
export async function requestNotificationPermission(): Promise<boolean> {
  // Setup iOS categories before requesting permission
  await setupIOSCategories()

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
    await messaging().requestPermission()
  }

  return granted
}

/**
 * Get FCM token for push notifications
 * Returns null if APNS is not configured (development)
 */
export async function getFCMToken(): Promise<string | null> {
  try {
    const token = await messaging().getToken()
    return token
  } catch (error) {
    console.warn('Could not get FCM token (APNS not configured):', error)
    return null
  }
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
    sound: 'default',
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

  return await notifee.displayNotification({
    title,
    body,
    data: options?.data,
    android: {
      channelId: channelId!,
      importance: AndroidImportance.HIGH,
      pressAction: {
        id: 'default',
      },
      actions: options?.actions?.map((action) => ({
        title: action.title,
        pressAction: { id: action.id },
      })),
    },
    ios: {
      categoryId: options?.categoryId || 'practice',
      foregroundPresentationOptions: {
        alert: true,
        badge: true,
        sound: true,
      },
    },
  })
}

/**
 * Cancel a notification by ID
 */
export async function cancelNotification(
  notificationId: string
): Promise<void> {
  await notifee.cancelNotification(notificationId)
}
