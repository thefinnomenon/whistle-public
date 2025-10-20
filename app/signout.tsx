import { useAuth } from '@/lib/contexts/AuthContext'
import { deleteUser } from '@/lib/firebase'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

const ONBOARDING_KEY = 'hasCompletedOnboarding'

export default function SignOutScreen() {
  const { user, signOut } = useAuth()
  const { deleteAccount } = useLocalSearchParams<{ deleteAccount?: string }>()
  const [error, setError] = useState<string | null>(null)
  const hasStarted = useRef(false)

  const shouldDeleteAccount = deleteAccount === 'true'

  useEffect(() => {
    // Prevent double execution in development mode
    if (hasStarted.current) return
    hasStarted.current = true

    const handleSignOut = async () => {
      try {
        console.log('[SignOut] Starting sign out process', {
          shouldDeleteAccount,
        })

        // Clear onboarding flag for this user
        if (user) {
          console.log('[SignOut] Clearing onboarding flag for user', user.id)
          await AsyncStorage.removeItem(`${ONBOARDING_KEY}_${user.id}`)
        }

        if (shouldDeleteAccount && user) {
          // Delete user data and Firebase Auth account
          // Note: Deleting the Firebase Auth account will automatically trigger signOut
          console.log('[SignOut] Deleting user account and data')
          await deleteUser(user.id, user.username)
          console.log('[SignOut] User deleted, waiting for auth state change')

          // Wait for the auth state change to propagate
          await new Promise((resolve) => setTimeout(resolve, 800))
        } else {
          // Just sign out
          console.log('[SignOut] Signing out user')
          await signOut()
          console.log('[SignOut] Sign out complete, waiting for cleanup')

          // Wait a bit to ensure all subscriptions are cleaned up
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        console.log('[SignOut] Navigating to sign-in page')
        // Navigate to sign-in page
        router.replace('/sign-in')
      } catch (err: any) {
        console.error('[SignOut] Sign out error:', err)
        setError(
          shouldDeleteAccount
            ? 'Failed to delete account. Please try again.'
            : 'Failed to sign out. Please try again.'
        )

        // On error, navigate back after a delay
        setTimeout(() => {
          router.replace('/game')
        }, 3000)
      }
    }

    handleSignOut()
  }, [shouldDeleteAccount, signOut, user])

  return (
    <View className="flex-1 bg-white dark:bg-black items-center justify-center">
      {error ? (
        <View className="items-center px-6">
          <Text className="text-xl text-red-600 dark:text-red-400 text-center mb-2">
            {error}
          </Text>
          <Text className="text-sm text-muted-foreground text-center">
            Returning to app...
          </Text>
        </View>
      ) : (
        <View className="items-center">
          <ActivityIndicator size="large" color="slategray" />
          <Text className="text-lg text-muted-foreground mt-4">
            {shouldDeleteAccount ? 'Deleting account...' : 'Signing out...'}
          </Text>
        </View>
      )}
    </View>
  )
}
