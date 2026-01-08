import notifee, {
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native'
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native'
import { isRunningInExpoGo } from 'expo'
import {
  router,
  Stack,
  useLocalSearchParams,
  useNavigationContainerRef,
  useSegments,
} from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import './global.css'

import { configureGoogleSignIn } from '@/lib/auth'
import { AuthProvider, useAuth } from '@/lib/contexts/AuthContext'
import { ThemeProvider, useTheme } from '@/lib/contexts/ThemeContext'
import { env } from '@/lib/env'
import { MixpanelProvider } from '@/lib/providers/MixpanelProvider'
import { getApp } from '@react-native-firebase/app'
import {
  getMessaging,
  onMessage,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging'
import { PortalHost } from '@rn-primitives/portal'
import * as Sentry from '@sentry/react-native'
import { useColorScheme as useNativeWindColorScheme } from 'nativewind'
import React, { useEffect } from 'react'
import { NativeModules, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Toaster } from 'sonner-native'

// Background FCM handler registration (headless)
import '../backgroundMessaging'

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

function AuthGate() {
  const { user, firebaseUser, loading, hasCompletedOnboarding, hasUsername } =
    useAuth()
  const segments = useSegments()
  const pathname = segments.join('/')
  const { gameId: gameIdParam, questionId: questionIdParam } =
    useLocalSearchParams<{
      gameId?: string | string[]
      questionId?: string | string[]
    }>()
  const incomingGameId = Array.isArray(gameIdParam)
    ? gameIdParam[0]
    : gameIdParam
  const incomingQuestionId = Array.isArray(questionIdParam)
    ? questionIdParam[0]
    : questionIdParam
  const { AuthConfig } = NativeModules as any

  // Ensure the questions notification channel exists with high importance so pushes can surface/wake the device
  useEffect(() => {
    if (Platform.OS !== 'android' || isRunningInExpoGo()) return
    if (!notifee?.createChannel) {
      console.warn(
        '[Notifications] Notifee unavailable, skipping channel setup'
      )
      return
    }
    notifee
      .createChannel({
        id: 'questions',
        name: 'Questions',
        importance: AndroidImportance.HIGH,
        sound: 'whistle',
        vibration: true,
        vibrationPattern: [250, 500, 250, 500],
        visibility: AndroidVisibility.PUBLIC,
      })
      .catch((err) =>
        console.warn('[Notifications] Failed to create default channel', err)
      )
  }, [])

  useEffect(() => {
    if (loading) return

    console.log('[AuthGate] evaluate routing', {
      pathname,
      incomingGameId,
      incomingQuestionId,
      loading,
    })

    const inAuthGroup = pathname.startsWith('sign-in')
    const inOnboarding = pathname.startsWith('onboarding')
    const inUsername = pathname.startsWith('username')
    const inSignout = pathname.startsWith('signout')
    const inGame = pathname.startsWith('game') && pathname !== 'game/lobby'
    const inSettings = pathname.startsWith('settings')

    if (!user && !inAuthGroup && !inSignout) {
      // Redirect to sign-in if not authenticated and not already on sign-in page or signout
      console.log('[AuthGate] Redirect -> sign-in (unauthenticated)')
      router.replace('/sign-in')
      SplashScreen.hideAsync()
    } else if (
      user &&
      !user.onboardingComplete &&
      !inOnboarding &&
      !inUsername
    ) {
      // Redirect to onboarding if authenticated but hasn't completed onboarding
      console.log('[AuthGate] Redirect -> onboarding (onboarding incomplete)')
      router.replace('/onboarding')
      SplashScreen.hideAsync()
    } else if (user && user.onboardingComplete && !hasUsername && !inUsername) {
      // Redirect to username if authenticated, completed onboarding, but no username
      console.log('[AuthGate] Redirect -> username (missing username)')
      router.replace('/username')
      SplashScreen.hideAsync()
    } else if (
      user &&
      user.onboardingComplete &&
      hasUsername &&
      (inAuthGroup || inOnboarding || inUsername || pathname === '') &&
      !inGame &&
      !inSettings &&
      pathname !== ''
    ) {
      console.log('[AuthGate] Redirect -> games list')
      router.replace('/')
      SplashScreen.hideAsync()
    } else {
      // Hide splash screen once auth is loaded and routing is complete
      SplashScreen.hideAsync()
    }
  }, [
    user,
    loading,
    hasCompletedOnboarding,
    hasUsername,
    pathname,
    incomingGameId,
    incomingQuestionId,
  ])

  // Provide auth context to native Android notification renderer
  useEffect(() => {
    if (
      Platform.OS === 'android' &&
      user &&
      firebaseUser &&
      AuthConfig?.setAuthContext
    ) {
      firebaseUser
        .getIdToken()
        .then((token) => {
          try {
            AuthConfig.setAuthContext(env.DOMAIN, token)
          } catch (err) {
            console.warn('Failed to set native auth context', err)
          }
        })
        .catch((err) => console.warn('Failed to fetch idToken', err))
    }
  }, [user, firebaseUser, AuthConfig])

  // Don't render anything while loading- splash screen will stay visible
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
      <Stack.Screen
        name="game"
        options={({ route }: any) => {
          const practice =
            route?.params?.practice === 'true' ||
            (typeof route?.params?.gameId === 'string' &&
              route.params.gameId.startsWith('practice-'))
          return {
            headerShown: false,
            gestureEnabled: !practice,
          }
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
        }}
      />
    </Stack>
  )
}

function ThemedApp() {
  const { theme, colorScheme } = useTheme()
  const { setColorScheme: setNativeWindColorScheme } =
    useNativeWindColorScheme()
  const currentSegments = useSegments()

  useEffect(() => {
    // Force NativeWind to update by setting to undefined first if switching to system
    if (theme === 'system') {
      setNativeWindColorScheme(colorScheme)
    } else {
      setNativeWindColorScheme(colorScheme)
    }
  }, [colorScheme, setNativeWindColorScheme, theme])

  // Foreground FCM -> force a visible notification (iOS + Android)
  useEffect(() => {
    const app = getApp()
    const messagingInstance = getMessaging(app)
    const unsubscribe = onMessage(messagingInstance, async (remoteMessage) => {
      console.log('[FCM] Foreground message', remoteMessage)
      if (
        Platform.OS === 'android' &&
        remoteMessage.data?.type === 'question'
      ) {
        console.log(
          '[FCM] Android question handled natively, skipping Notifee render'
        )
        return
      }
      const collapseId = remoteMessage.data?.collapseId as string

      // Handle dismiss/expired messages
      if (remoteMessage.data?.type === 'question_expired' && collapseId) {
        try {
          await notifee.cancelDisplayedNotification(collapseId)
          await notifee.cancelNotification(collapseId)
          console.log('[FCM] Cancelled notification for', collapseId)
        } catch (err) {
          console.warn('[FCM] Failed to cancel notification', err)
        }
        return
      }

      const title =
        remoteMessage.notification?.title ??
        (remoteMessage.data?.question as string | undefined) ??
        'New Question'
      const body = remoteMessage.notification?.body ?? ''

      // Display via Notifee to ensure banner while app is foreground
      await notifee.displayNotification({
        id: collapseId,
        title,
        body,
        data: remoteMessage.data,
        android: {
          channelId: 'default',
          pressAction: { id: 'default' },
          sound: 'whistle',
        },
        ios: {
          categoryId: 'question',
          foregroundPresentationOptions: {
            alert: true,
            sound: true,
            badge: true,
          },
          sound: 'whistle.wav',
        },
      })
    })

    return unsubscribe
  }, [])

  // Handle notification that opened the app from killed state
  useEffect(() => {
    const checkInitialNotification = async () => {
      const initialNotification = await notifee.getInitialNotification()
      console.log('[Notification] initialNotification', initialNotification)
      if (
        initialNotification?.notification?.data?.gameId &&
        initialNotification?.notification?.data?.questionId
      ) {
        console.log(
          '[Notification] App opened from notification:',
          initialNotification.notification.data
        )
        router.push({
          pathname: '/game',
          params: {
            gameId: initialNotification.notification.data.gameId as string,
          },
        })
      }
    }
    checkInitialNotification()
  }, [])

  // Handle notification taps while app is in background
  useEffect(() => {
    const app = getApp()
    const messagingInstance = getMessaging(app)
    const unsubscribe = onNotificationOpenedApp(
      messagingInstance,
      (remoteMessage) => {
        const gameId = remoteMessage?.data?.gameId as string | undefined
        console.log('[Notification] App opened from background notification', {
          gameId,
        })
        if (gameId) {
          // Avoid redirecting if already on game screen
          const isOnGame =
            Array.isArray(currentSegments) &&
            currentSegments.length > 0 &&
            currentSegments[0] === 'game'
          if (!isOnGame) {
            router.push({ pathname: '/game', params: { gameId } })
          }
        }
      }
    )
    return unsubscribe
  }, [currentSegments])

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
