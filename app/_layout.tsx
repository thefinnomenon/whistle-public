import notifee, { EventType } from '@notifee/react-native'
import { getApp } from '@react-native-firebase/app'
import { getMessaging, onMessage } from '@react-native-firebase/messaging'
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native'
import { isRunningInExpoGo } from 'expo'
import * as Notifications from 'expo-notifications'
import {
  router,
  Stack,
  useNavigationContainerRef,
  useSegments,
} from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import './global.css'

// Import background messaging handler for Android
import '../backgroundMessaging'

import { analytics } from '@/lib/analytics'
import { configureGoogleSignIn } from '@/lib/auth'
import { AuthProvider, useAuth } from '@/lib/contexts/AuthContext'
import { ThemeProvider, useTheme } from '@/lib/contexts/ThemeContext'
import { env } from '@/lib/env'
import {
  displayNotification,
  handleNotificationEvent,
  setupIOSCategories,
} from '@/lib/notifications'
import { MixpanelProvider } from '@/lib/providers/MixpanelProvider'
import { PortalHost } from '@rn-primitives/portal'
import * as Sentry from '@sentry/react-native'
import { useColorScheme as useNativeWindColorScheme } from 'nativewind'
import React, { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Toaster } from 'sonner-native'

// Keep splash screen visible while app loads
SplashScreen.preventAutoHideAsync()

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
      const receivedAt = Date.now()

      // Log latency if timing data available
      if (isQuestion && remoteMessage.data?.sentAt) {
        const deliveryLatency =
          receivedAt - parseInt(remoteMessage.data.sentAt as string)
        console.log(
          `[Timing] Notification delivery latency: ${deliveryLatency}ms`
        )
      }

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
            data: {
              ...remoteMessage.data,
              receivedAt: receivedAt.toString(),
            },
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

// Track answered notifications to prevent logging dismissed events for already-answered questions
const answeredNotifications =
  (global as any).__answeredNotifications || new Set<string>()
;(global as any).__answeredNotifications = answeredNotifications

// Setup notification action handler (for Yes/No buttons, only once)
if (!(global as any).__actionHandlerSetup) {
  ;(global as any).__actionHandlerSetup = true

  // Handle background notification actions
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    await handleNotificationEvent(type, detail, analytics, 'Background')
  })

  notifee.onForegroundEvent(async ({ type, detail }) => {
    console.log(`[Notification Foreground] Event type: ${type}`)
    console.log(
      `[Notification Foreground] EventType.ACTION_PRESS = ${EventType.ACTION_PRESS}`
    )
    console.log(
      `[Notification Foreground] EventType.DISMISSED = ${EventType.DISMISSED}`
    )

    if (type === EventType.ACTION_PRESS) {
      console.log('[Notification Foreground] Entering ACTION_PRESS handler')

      // Check for duplicates (foreground-only logic)
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

      // Mark this notification as answered to prevent tracking it as missed
      if (detail.notification?.id) {
        answeredNotifications.add(detail.notification.id)
        console.log(
          '[Notification] Marked as answered:',
          detail.notification.id
        )
      }

      // Handle the action
      await handleNotificationEvent(type, detail, analytics, 'Foreground')

      // Dismiss the notification (foreground-only logic)
      if (detail.notification?.id) {
        await notifee.cancelNotification(detail.notification.id)
      }
    } else if (type === EventType.DISMISSED) {
      console.log('[Notification Foreground] Entering DISMISSED handler')

      // Don't track dismissed events for notifications that were already answered
      const notificationId = detail.notification?.id
      if (notificationId && answeredNotifications.has(notificationId)) {
        console.log(
          '[Notification] Skipping dismissed event for answered notification'
        )
        answeredNotifications.delete(notificationId) // Clean up
        return
      }

      console.log('[Notification] Processing dismissed event (not answered)')
      await handleNotificationEvent(type, detail, analytics, 'Foreground')
    }
  })

  // Handle iOS notification action responses (for native category actions)
  Notifications.addNotificationResponseReceivedListener((response) => {
    console.log('[iOS Notification] Response received:', response)
    const actionIdentifier = response.actionIdentifier

    // iOS sends action identifiers for category actions
    if (actionIdentifier === 'yes' || actionIdentifier === 'no') {
      console.log('[iOS Notification] Action button pressed:', actionIdentifier)

      // Convert to notifee-compatible format and handle
      const notifeeDetail = {
        notification: {
          id: response.notification.request.identifier,
          data: response.notification.request.content.data,
        },
        pressAction: {
          id: actionIdentifier,
        },
      }

      handleNotificationEvent(
        EventType.ACTION_PRESS,
        notifeeDetail as any,
        analytics
      )
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

    // Hide splash screen once auth is loaded and routing is complete
    SplashScreen.hideAsync()
  }, [user, loading, hasCompletedOnboarding, hasUsername, pathname])

  // Don't render anything while loading - splash screen will stay visible
  if (loading) {
    return null
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
