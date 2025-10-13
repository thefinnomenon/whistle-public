import AsyncStorage from '@react-native-async-storage/async-storage'
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth'
import React, { createContext, useContext, useEffect, useState } from 'react'

const ONBOARDING_KEY = 'hasCompletedOnboarding'

interface AuthContextType {
  user: FirebaseAuthTypes.User | null
  loading: boolean
  hasCompletedOnboarding: boolean
  signOut: () => Promise<void>
  completeOnboarding: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false)

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(async (user) => {
      setUser(user)

      if (user) {
        // Check if user has completed onboarding
        const onboardingStatus = await AsyncStorage.getItem(
          `${ONBOARDING_KEY}_${user.uid}`
        )
        setHasCompletedOnboarding(onboardingStatus === 'true')
      } else {
        setHasCompletedOnboarding(false)
      }

      setLoading(false)
    })

    return unsubscribe
  }, [])

  const signOut = async () => {
    try {
      await auth().signOut()
    } catch (error) {
      console.error('Sign out error:', error)
      throw error
    }
  }

  const completeOnboarding = async () => {
    if (user) {
      await AsyncStorage.setItem(`${ONBOARDING_KEY}_${user.uid}`, 'true')
      setHasCompletedOnboarding(true)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        hasCompletedOnboarding,
        signOut,
        completeOnboarding,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
