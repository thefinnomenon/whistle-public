import { initializeFCMToken, setupTokenRefreshListener } from '@/lib/fcm'
import { addUser, getUser } from '@/lib/firebase'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { FirebaseAuthTypes } from '@react-native-firebase/auth'
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from '@react-native-firebase/auth'
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
} from '@react-native-firebase/firestore'
import { requireNativeModule } from 'expo-modules-core'
import React, { createContext, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner-native'
import { analytics } from '../analytics'

type FirebaseUser = FirebaseAuthTypes.User

const ONBOARDING_KEY = 'hasCompletedOnboarding'
const auth = getAuth()
const db = getFirestore()
const WhistleSessionModule = requireNativeModule('WhistleSessionModule') as
  | { setSession: (userId: string, authToken: string) => void }
  | undefined

interface AuthContextType {
  firebaseUser: FirebaseUser | null
  user: User | null
  loading: boolean
  hasCompletedOnboarding: boolean
  hasUsername: boolean
  signOut: () => Promise<void>
  completeOnboarding: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false)
  const [hasUsername, setHasUsername] = useState(false)

  const setNativeSession = async (fbUser: FirebaseUser) => {
    if (!WhistleSessionModule?.setSession) {
      console.warn('[WhistleSession] No setSession defined in native module')
      return
    }
    try {
      const idToken = await fbUser.getIdToken()
      console.log(
        '[WhistleSession] Setting native session for user',
        fbUser.uid
      )
      WhistleSessionModule.setSession(fbUser.uid, idToken)
    } catch (error) {
      console.warn('[WhistleSession] Failed to set native session', error)
    }
  }

  useEffect(() => {
    let userUnsubscribe: (() => void) | null = null
    let tokenRefreshUnsubscribe: (() => void) | null = null
    let idTokenUnsubscribe: (() => void) | null = null

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser)

      // Unsubscribe from previous user listener and token refresh
      if (userUnsubscribe) {
        userUnsubscribe()
        userUnsubscribe = null
      }
      if (tokenRefreshUnsubscribe) {
        tokenRefreshUnsubscribe()
        tokenRefreshUnsubscribe = null
      }
      if (idTokenUnsubscribe) {
        idTokenUnsubscribe()
        idTokenUnsubscribe = null
      }

      if (fbUser) {
        // Subscribe to real-time user updates
        userUnsubscribe = onSnapshot(
          doc(db, 'users', fbUser.uid),
          (userDoc) => {
            if (userDoc.exists()) {
              const userData = userDoc.data() as User
              setUser(userData)
              setHasUsername(!!userData.username)
            }
          },
          (error) => {
            console.error('Error listening to user updates:', error)
          }
        )

        // Fetch initial user record for analytics and state
        const userDoc = await getDoc(doc(db, 'users', fbUser.uid))

        if (userDoc.exists()) {
          const userData = userDoc.data() as User

          // Set user state immediately (before real-time listener fires)
          setUser(userData)
          setHasUsername(!!userData.username)

          // Track login event in Mixpanel
          analytics.identify(fbUser.uid)
          analytics.track('User Signed In', {
            login_method: userData.loginMethod,
            email: userData.email,
            user_id: fbUser.uid,
          })

          await setNativeSession(fbUser)

          // Initialize FCM token
          await initializeFCMToken(fbUser.uid)

          // Setup token refresh listener
          tokenRefreshUnsubscribe = setupTokenRefreshListener(fbUser.uid)

          // Check if user has completed onboarding (existing user)
          // Check both AsyncStorage flag and Firestore onboardingComplete field
          const onboardingStatus = await AsyncStorage.getItem(
            `${ONBOARDING_KEY}_${fbUser.uid}`
          )

          // User has completed onboarding if they have AsyncStorage flag OR onboardingComplete in Firestore
          const hasCompletedOnboardingFlag =
            onboardingStatus === 'true' || !!userData.onboardingComplete
          setHasCompletedOnboarding(hasCompletedOnboardingFlag)

          // Update AsyncStorage if user has onboardingComplete but flag is not set
          if (userData.onboardingComplete && !onboardingStatus) {
            await AsyncStorage.setItem(
              `${ONBOARDING_KEY}_${fbUser.uid}`,
              'true'
            )
          }
        } else {
          // Create user record if it doesn't exist
          console.log('User record not found, creating...')

          // Determine login method from provider
          const providers = fbUser.providerData
          let loginMethod: LoginType | undefined
          if (providers.some((p) => p.providerId === 'apple.com')) {
            loginMethod = 'Apple'
          } else if (providers.some((p) => p.providerId === 'google.com')) {
            loginMethod = 'Google'
          }

          const newUserDoc: Omit<User, 'createdAt' | 'updatedAt'> = {
            id: fbUser.uid,
            email: fbUser.email || undefined,
            loginMethod,
            tokens: {},
          }

          try {
            await addUser(newUserDoc)
            const userCreated = await getUser(fbUser.uid)

            if (!userCreated) {
              console.error('User creation failed')
              toast.error('User creation failed')
              throw new Error('User creation failed')
            }

            // Track user creation in Mixpanel
            analytics.identify(fbUser.uid)
            analytics.track('User Created', {
              login_method: loginMethod,
              email: fbUser.email,
            })

            await setNativeSession(fbUser)

            console.log('User record created successfully')
            setUser(userCreated)
            setHasUsername(false)

            // Initialize FCM token for new user
            await initializeFCMToken(fbUser.uid)

            // Setup token refresh listener
            tokenRefreshUnsubscribe = setupTokenRefreshListener(fbUser.uid)

            // New users haven't completed onboarding
            setHasCompletedOnboarding(false)
          } catch (error) {
            console.error('Failed to create user record:', error)
            setUser(null)
            setHasUsername(false)
            setHasCompletedOnboarding(false)
          }
        }
      } else {
        if (WhistleSessionModule?.setSession) {
          console.log('[WhistleSession] Clearing native session (no user)')
          WhistleSessionModule.setSession('', '')
        }
        setUser(null)
        setHasCompletedOnboarding(false)
        setHasUsername(false)
      }

      // Keep native session token fresh
      if (fbUser) {
        idTokenUnsubscribe = auth.onIdTokenChanged(async (user) => {
          if (user) {
            await setNativeSession(user)
          }
        })
      }

      setLoading(false)
    })

    return () => {
      unsubscribe()
      if (userUnsubscribe) {
        userUnsubscribe()
      }
      if (tokenRefreshUnsubscribe) {
        tokenRefreshUnsubscribe()
      }
      if (idTokenUnsubscribe) {
        idTokenUnsubscribe()
      }
    }
  }, [])

  const handleSignOut = async () => {
    try {
      // Track sign out before clearing user data
      if (firebaseUser) {
        analytics.track('User Signed Out', {
          user_id: firebaseUser.uid,
        })
      }

      if (WhistleSessionModule?.setSession) {
        console.log('[WhistleSession] Clearing native session on sign out')
        WhistleSessionModule.setSession('', '')
      }

      await signOut(auth)
      analytics.reset()
    } catch (error) {
      console.error('Sign out error:', error)
      throw error
    }
  }

  const completeOnboarding = async () => {
    if (firebaseUser) {
      // Only mark onboarding as complete in AsyncStorage
      // Don't set onboardingComplete in Firestore yet - wait until username is set
      await AsyncStorage.setItem(
        `${ONBOARDING_KEY}_${firebaseUser.uid}`,
        'true'
      )
      setHasCompletedOnboarding(true)

      // Track onboarding completion
      analytics.track('Onboarding Completed', {
        user_id: firebaseUser.uid,
      })
    }
  }

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        user,
        loading,
        hasCompletedOnboarding,
        hasUsername,
        signOut: handleSignOut,
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
