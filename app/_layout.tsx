import notifee, { EventType } from '@notifee/react-native'
import { getApp } from '@react-native-firebase/app'
import { getAuth } from '@react-native-firebase/auth'
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from '@react-native-firebase/firestore'
import { getMessaging, onMessage } from '@react-native-firebase/messaging'
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native'
import { isRunningInExpoGo } from 'expo'
import {
  router,
  Stack,
  useNavigationContainerRef,
  useSegments,
} from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import './global.css'

// Import background messaging handler
import '../backgroundMessaging'

import { configureGoogleSignIn } from '@/lib/auth'
import { AuthProvider, useAuth } from '@/lib/contexts/AuthContext'
import { ThemeProvider, useTheme } from '@/lib/contexts/ThemeContext'
import { env } from '@/lib/env'
import { displayNotification, setupIOSCategories } from '@/lib/notifications'
import { MixpanelProvider } from '@/lib/providers/MixpanelProvider'
import { PortalHost } from '@rn-primitives/portal'
import * as Sentry from '@sentry/react-native'
import { useColorScheme as useNativeWindColorScheme } from 'nativewind'
import React, { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Toaster } from 'sonner-native'

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: !isRunningInExpoGo(),
})

Sentry.init({
  enabled: env.APP_ENV === 'production',
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0.5,
  integrations: [navigationIntegration],
  enableNativeFramesTracking: !isRunningInExpoGo(),
  enableAppStartTracking: true,
})

// Configure Google Sign-In on app start
configureGoogleSignIn()

// Setup iOS notification categories on app start
setupIOSCategories()

// Track processed notifications to prevent duplicates (global to persist across hot reloads)
const processedNotifications =
  (global as any).__processedNotifications || new Set<string>()
;(global as any).__processedNotifications = processedNotifications

// Setup foreground notification handler (only once, even across hot reloads)
if (!(global as any).__messageHandlerSetup) {
  ;(global as any).__messageHandlerSetup = true
  try {
    const app = getApp()
    const messaging = getMessaging(app)
    console.log('[FCM] Setting up foreground message handler')

    onMessage(messaging, async (remoteMessage) => {
      const messageId = remoteMessage.messageId
      if (!messageId || processedNotifications.has(messageId)) {
        console.log('[FCM] Skipping duplicate notification:', messageId)
        return
      }

      processedNotifications.add(messageId)

      // Clean up old entries (keep last 100)
      if (processedNotifications.size > 100) {
        const arr = Array.from(processedNotifications)
        processedNotifications.clear()
        arr.slice(-100).forEach((id) => processedNotifications.add(id))
      }

      console.log('[FCM] 🔔 Foreground notification received!')
      console.log('[FCM] Message:', JSON.stringify(remoteMessage, null, 2))

      // Check if this is a question notification (has questionId in data)
      const isQuestion = remoteMessage.data?.questionId

      // Display the notification using notifee
      if (isQuestion || remoteMessage.notification) {
        console.log('[FCM] Displaying notification via notifee')

        const notificationId = await displayNotification(
          remoteMessage.data?.title?.toString() ||
            remoteMessage.notification?.title ||
            'Notification',
          remoteMessage.data?.body?.toString() ||
            remoteMessage.notification?.body ||
            '',
          {
            data: remoteMessage.data,
            actions: isQuestion
              ? [
                  { title: '✅ Yes', id: 'yes' },
                  { title: '❌ No', id: 'no' },
                ]
              : undefined,
          }
        )
        console.log('[FCM] Notification displayed')

        // Auto-dismiss question notifications after 30 seconds
        if (isQuestion) {
          setTimeout(async () => {
            try {
              await notifee.cancelNotification(notificationId)
              console.log('[FCM] Auto-dismissed notification after 30s')
            } catch (error) {
              console.log('[FCM] Failed to auto-dismiss:', error)
            }
          }, 30000)
        }
      } else {
        console.log('[FCM] No notification payload in message')
      }
    })

    console.log('[FCM] Foreground message handler registered')
  } catch (error) {
    console.error('[FCM] Error setting up foreground handler:', error)
  }
}

// Track processed actions to prevent duplicates (global to persist across hot reloads)
const processedActions = (global as any).__processedActions || new Set<string>()
;(global as any).__processedActions = processedActions

// Setup notification action handler (for Yes/No buttons, only once)
if (!(global as any).__actionHandlerSetup) {
  ;(global as any).__actionHandlerSetup = true

  // Handle background notification actions
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type === EventType.ACTION_PRESS) {
      const actionId = detail.pressAction?.id
      const data = detail.notification?.data

      if (actionId === 'yes' || actionId === 'no') {
        const { gameId, questionId } = data || {}
        if (gameId && questionId) {
          try {
            const prediction = actionId === 'yes'
            const app = getApp()
            const auth = getAuth(app)
            const firestore = getFirestore(app)
            const userId = auth.currentUser?.uid

            if (userId) {
              // Write to question predictions collection (for scoring)
              const predictionRef = doc(
                firestore,
                `games/${gameId}/questions/${questionId}/predictions/${userId}`
              )

              await setDoc(predictionRef, {
                prediction,
              })

              // Write to user predictions subcollection (for UI display)
              const userPredictionRef = doc(
                firestore,
                `users/${userId}/games/${gameId}/predictions/${questionId}`
              )

              await setDoc(userPredictionRef, {
                prediction,
                createdAt: serverTimestamp(),
              })

              console.log(
                `[Notification Background] Submitted answer: ${prediction}`
              )
            }
          } catch (error) {
            console.error(
              '[Notification Background] Error submitting answer:',
              error
            )
          }
        }
      }
    }
  })

  notifee.onForegroundEvent(async ({ type, detail }) => {
    if (type === EventType.ACTION_PRESS) {
      const actionKey = `${detail.notification?.id}-${detail.pressAction?.id}`
      if (processedActions.has(actionKey)) {
        console.log('[Notification] Skipping duplicate action')
        return
      }
      processedActions.add(actionKey)

      // Clean up old entries (keep last 50)
      if (processedActions.size > 50) {
        const arr = Array.from(processedActions)
        processedActions.clear()
        arr.slice(-50).forEach((key) => processedActions.add(key))
      }

      console.log('[Notification] Action pressed:', detail.pressAction?.id)
      console.log('[Notification] Data:', detail.notification?.data)

      const actionId = detail.pressAction?.id
      const data = detail.notification?.data

      if (actionId === 'yes' || actionId === 'no') {
        const { gameId, questionId } = data || {}
        if (gameId && questionId) {
          try {
            // Submit answer to Firestore
            const prediction = actionId === 'yes'
            const app = getApp()
            const auth = getAuth(app)
            const firestore = getFirestore(app)
            const userId = auth.currentUser?.uid

            if (userId) {
              // Write to question predictions collection (for scoring)
              const predictionRef = doc(
                firestore,
                `games/${gameId}/questions/${questionId}/predictions/${userId}`
              )

              await setDoc(predictionRef, {
                prediction,
              })

              // Write to user predictions subcollection (for UI display)
              const userPredictionRef = doc(
                firestore,
                `users/${userId}/games/${gameId}/predictions/${questionId}`
              )

              await setDoc(userPredictionRef, {
                prediction,
                createdAt: serverTimestamp(),
              })

              console.log(`[Notification] Submitted answer: ${prediction}`)
            }
          } catch (error) {
            console.error('[Notification] Error submitting answer:', error)
          }
        }
      }

      // Dismiss the notification
      if (detail.notification?.id) {
        await notifee.cancelNotification(detail.notification.id)
      }
    }
  })
}

function AuthGate() {
  const { user, loading, hasCompletedOnboarding, hasUsername } = useAuth()
  const segments = useSegments()
  const pathname = segments.join('/')

  useEffect(() => {
    if (loading) return

    const inAuthGroup = pathname.startsWith('sign-in')
    const inOnboarding = pathname.startsWith('onboarding')
    const inUsername = pathname.startsWith('username')
    const inSignout = pathname.startsWith('signout')

    if (!user && !inAuthGroup && !inSignout) {
      // Redirect to sign-in if not authenticated and not already on sign-in page or signout
      router.replace('/sign-in')
    } else if (user && !hasCompletedOnboarding && !inOnboarding) {
      // Redirect to onboarding if authenticated but hasn't completed onboarding
      router.replace('/onboarding')
    } else if (user && hasCompletedOnboarding && !hasUsername && !inUsername) {
      // Redirect to username if authenticated, completed onboarding, but no username
      router.replace('/username')
    } else if (
      user &&
      hasCompletedOnboarding &&
      hasUsername &&
      (inAuthGroup || inOnboarding || inUsername || pathname === '')
    ) {
      // Redirect to game lobby after completing onboarding or from root index
      router.replace('/game/lobby')
    }
  }, [user, loading, hasCompletedOnboarding, hasUsername, pathname])

  if (loading) {
    return (
      <View className="flex-1 justify-center items-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="signout" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen name="username" options={{ headerShown: false }} />
      <Stack.Screen name="game" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
    </Stack>
  )
}

function ThemedApp() {
  const { theme, colorScheme } = useTheme()
  const { setColorScheme: setNativeWindColorScheme } =
    useNativeWindColorScheme()

  useEffect(() => {
    // Force NativeWind to update by setting to undefined first if switching to system
    if (theme === 'system') {
      setNativeWindColorScheme(colorScheme)
    } else {
      setNativeWindColorScheme(colorScheme)
    }
  }, [colorScheme, setNativeWindColorScheme, theme])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationThemeProvider
        value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}
      >
        <AuthGate />
        <PortalHost />
        <Toaster theme={colorScheme === 'dark' ? 'dark' : 'light'} />
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      </NavigationThemeProvider>
    </GestureHandlerRootView>
  )
}

export default Sentry.wrap(function RootLayout() {
  const ref = useNavigationContainerRef()
  React.useEffect(() => {
    if (ref) {
      navigationIntegration.registerNavigationContainer(ref)
    }
  }, [ref])

  return (
    <MixpanelProvider>
      <ThemeProvider>
        <AuthProvider>
          <ThemedApp />
        </AuthProvider>
      </ThemeProvider>
    </MixpanelProvider>
  )
})
