import {
  AppleAuthProvider,
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
} from '@react-native-firebase/auth'
import { GoogleSignin } from '@react-native-google-signin/google-signin'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'
import { Platform } from 'react-native'
import { toast } from 'sonner-native'
import { env } from './env'

const auth = getAuth()

// Configure Google Sign-In
export const configureGoogleSignIn = () => {
  const webClientId = Platform.select({
    android: env.GOOGLE_WEB_CLIENT_ID_ANDROID,
    ios: env.GOOGLE_WEB_CLIENT_ID_IOS,
  })

  GoogleSignin.configure({
    webClientId,
    offlineAccess: true,
  })
}

export const signInWithApple = async () => {
  try {
    // Generate nonce for Apple Sign-In
    const nonce = Math.random().toString(36).substring(2, 10)
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      nonce
    )

    const appleCredential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    })

    const { identityToken } = appleCredential
    if (!identityToken) {
      throw new Error('No identity token returned from Apple')
    }

    const credential = AppleAuthProvider.credential(identityToken, nonce)
    await signInWithCredential(auth, credential)
  } catch (error: any) {
    // User cancelled the sign-in flow
    if (
      error
        .toString()
        .includes('The authorization attempt failed for an unknown reason')
    )
      return

    console.error('Apple sign-in error:', error)
    toast.error('Failed to sign in with Apple')
  }
}

export const signInWithGoogle = async () => {
  try {
    await GoogleSignin.hasPlayServices()

    const res = await GoogleSignin.signIn()

    // User cancelled the sign-in flow
    if (res.type === 'cancelled') return

    if (!res.data.idToken) throw new Error('No ID token returned from Google')

    const credential = GoogleAuthProvider.credential(res.data.idToken)
    await signInWithCredential(auth, credential)
  } catch (error) {
    console.error('Google sign-in error:', error)
    toast.error('Failed to sign in with Google')
  }
}
