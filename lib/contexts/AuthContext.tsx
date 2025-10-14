import { addUser, getUser } from '@/firebase'
import AsyncStorage from '@react-native-async-storage/async-storage'
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth'
import firestore from '@react-native-firebase/firestore'
import React, { createContext, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner-native'
import { analytics } from '../analytics'

const ONBOARDING_KEY = 'hasCompletedOnboarding'

interface AuthContextType {
  user: FirebaseAuthTypes.User | null
  userRecord: User | null
  loading: boolean
  hasCompletedOnboarding: boolean
  signOut: () => Promise<void>
  completeOnboarding: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null)
  const [userRecord, setUserRecord] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false)

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(async (user) => {
      setUser(user)

      if (user) {
        // Fetch user record from Firestore
        const userDoc = await firestore()
          .collection('users')
          .doc(user.uid)
          .get()

        if (userDoc.exists()) {
          const userData = userDoc.data() as User
          setUserRecord(userData)

          // Track login event in Mixpanel
          analytics.identify(user.uid)
          analytics.track('User Signed In', {
            login_method: userData.loginMethod,
            email: userData.email,
            user_id: user.uid,
          })
        } else {
          // Create user record if it doesn't exist
          console.log('User record not found, creating...')

          // Determine login method from provider
          const providers = user.providerData
          let loginMethod: LoginType | undefined
          if (providers.some((p) => p.providerId === 'apple.com')) {
            loginMethod = 'Apple'
          } else if (providers.some((p) => p.providerId === 'google.com')) {
            loginMethod = 'Google'
          }

          const newUserDoc: Omit<User, 'createdAt' | 'updatedAt'> = {
            id: user.uid,
            email: user.email || undefined,
            loginMethod,
            tokens: {},
          }

          try {
            await addUser(newUserDoc)
            const userCreated = await getUser(user.uid)

            if (!userCreated) {
              console.error('User creation failed')
              toast.error('User creation failed')
              throw new Error('User creation failed')
            }

            // Track user creation in Mixpanel
            analytics.identify(user.uid)
            analytics.track('User Created', {
              login_method: loginMethod,
              email: user.email,
            })

            console.log('User record created successfully')
            setUserRecord(userCreated)
          } catch (error) {
            console.error('Failed to create user record:', error)
            setUserRecord(null)
          }
        }

        // Check if user has completed onboarding
        const onboardingStatus = await AsyncStorage.getItem(
          `${ONBOARDING_KEY}_${user.uid}`
        )
        setHasCompletedOnboarding(onboardingStatus === 'true')
      } else {
        setUserRecord(null)
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
        userRecord,
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
