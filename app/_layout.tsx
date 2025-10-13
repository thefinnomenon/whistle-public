import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native'
import { isRunningInExpoGo } from 'expo'
import {
  Slot,
  useNavigationContainerRef,
  router,
  useSegments,
} from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import './global.css'

import { configureGoogleSignIn } from '@/lib/auth'
import { AuthProvider, useAuth } from '@/lib/contexts/AuthContext'
import { ThemeProvider, useTheme } from '@/lib/contexts/ThemeContext'
import { env } from '@/lib/env'
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

function AuthGate() {
  const { user, loading, hasCompletedOnboarding } = useAuth()
  const segments = useSegments()
  const pathname = segments.join('/')

  useEffect(() => {
    if (loading) return

    const inAuthGroup = pathname.startsWith('sign-in')

    if (!user && !inAuthGroup) {
      // Redirect to sign-in if not authenticated and not already on sign-in page
      router.replace('/sign-in')
    } else if (user && inAuthGroup) {
      // Redirect to home if authenticated and on sign-in page
      router.replace('/')
    }
  }, [user, loading, pathname])

  if (loading) {
    return (
      <View className="flex-1 justify-center items-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return <Slot />
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
