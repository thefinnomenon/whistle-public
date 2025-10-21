import * as Application from 'expo-application'
import * as Device from 'expo-device'
import { getApp } from '@react-native-firebase/app'
import {
  getMessaging,
  subscribeToTopic,
  unsubscribeFromTopic,
} from '@react-native-firebase/messaging'
import { Platform } from 'react-native'
import { getFCMToken, onTokenRefresh } from './notifications'
import { removeFCMToken, saveFCMToken } from './firebase'

/**
 * Get a unique device identifier
 * Uses different methods for iOS vs Android
 */
export async function getDeviceId(): Promise<string> {
  if (Platform.OS === 'ios') {
    // iOS: Use IOS_ID_FOR_VENDOR (changes on reinstall)
    const iosId = await Application.getIosIdForVendorAsync()
    return iosId || 'unknown-ios'
  } else {
    // Android: Use ANDROID_ID (persists across app reinstalls)
    const androidId = Application.getAndroidId()
    return androidId || 'unknown-android'
  }
}

/**
 * Get device information for analytics
 */
export async function getDeviceInfo() {
  return {
    platform: Platform.OS as 'ios' | 'android',
    model: Device.modelName || undefined,
    osVersion: Device.osVersion || undefined,
  }
}

/**
 * Initialize FCM token for the current user
 * Call this when user logs in or when app starts with authenticated user
 */
export async function initializeFCMToken(userId: string): Promise<void> {
  try {
    console.log('[FCM] Initializing FCM token for user', userId)

    // Get FCM token
    const token = await getFCMToken()
    if (!token) {
      console.warn('[FCM] Could not get FCM token')
      return
    }

    // Get device ID and info
    const deviceId = await getDeviceId()
    const deviceInfo = await getDeviceInfo()

    console.log('[FCM] Device ID:', deviceId)
    console.log('[FCM] Token:', token.substring(0, 20) + '...')

    // Save to Firestore
    await saveFCMToken(userId, deviceId, token, deviceInfo)

    // Subscribe to main app topic
    const app = getApp()
    const messaging = getMessaging(app)
    await subscribeToTopic(messaging, 'app_notifications')
    console.log('[FCM] Subscribed to main app topic')

    console.log('[FCM] Token saved successfully')
  } catch (error) {
    console.error('[FCM] Error initializing FCM token:', error)
  }
}

/**
 * Setup FCM token refresh listener
 * Returns an unsubscribe function
 */
export function setupTokenRefreshListener(userId: string): () => void {
  return onTokenRefresh(async (newToken) => {
    try {
      console.log('[FCM] Token refreshed, updating Firestore')
      const deviceId = await getDeviceId()
      const deviceInfo = await getDeviceInfo()
      await saveFCMToken(userId, deviceId, newToken, deviceInfo)
      console.log('[FCM] Updated token in Firestore')
    } catch (error) {
      console.error('[FCM] Error updating refreshed token:', error)
    }
  })
}

/**
 * Remove FCM token for current device
 * Call this when user signs out
 */
export async function clearFCMToken(userId: string): Promise<void> {
  try {
    console.log('[FCM] Clearing FCM token for user', userId)
    const deviceId = await getDeviceId()
    await removeFCMToken(userId, deviceId)
    console.log('[FCM] Token cleared successfully')
  } catch (error) {
    console.error('[FCM] Error clearing FCM token:', error)
  }
}

/**
 * Subscribe to a game topic
 * Call this when user joins a game
 */
export async function subscribeToGameTopic(gameId: string): Promise<void> {
  try {
    const topic = `game_${gameId}`
    console.log(`[FCM] Subscribing to topic: ${topic}`)
    const app = getApp()
    const messaging = getMessaging(app)
    await subscribeToTopic(messaging, topic)
    console.log(`[FCM] ✅ Successfully subscribed to topic: ${topic}`)
  } catch (error) {
    console.error(`[FCM] ❌ Error subscribing to topic:`, error)
  }
}

/**
 * Unsubscribe from a game topic
 * Call this when user leaves a game
 */
export async function unsubscribeFromGameTopic(gameId: string): Promise<void> {
  try {
    const topic = `game_${gameId}`
    console.log(`[FCM] Unsubscribing from topic: ${topic}`)
    const app = getApp()
    const messaging = getMessaging(app)
    await unsubscribeFromTopic(messaging, topic)
    console.log(`[FCM] Successfully unsubscribed from topic: ${topic}`)
  } catch (error) {
    console.error(`[FCM] Error unsubscribing from topic:`, error)
  }
}

/**
 * Unsubscribe from all topics (device-specific)
 * Call this when user signs out
 */
export async function unsubscribeFromAllTopics(userId: string): Promise<void> {
  try {
    console.log('[FCM] Unsubscribing from all topics for current device')

    // Unsubscribe from main app topic
    const app = getApp()
    const messaging = getMessaging(app)
    await unsubscribeFromTopic(messaging, 'app_notifications')
    console.log('[FCM] Unsubscribed from main app topic')

    // Get all user's games and unsubscribe from each
    const { collection, query, getDocs } = await import(
      '@react-native-firebase/firestore'
    )
    const db = (await import('@react-native-firebase/firestore')).default()
    const userGamesQuery = query(collection(db, `users/${userId}/games`))
    const userGamesSnapshot = await getDocs(userGamesQuery)

    for (const gameDoc of userGamesSnapshot.docs) {
      await unsubscribeFromGameTopic(gameDoc.id)
    }

    console.log('[FCM] Successfully unsubscribed from all topics')
  } catch (error) {
    console.error('[FCM] Error unsubscribing from all topics:', error)
  }
}
