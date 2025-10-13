import auth from '@react-native-firebase/auth'
import { GoogleSignin } from '@react-native-google-signin/google-signin'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'
import { toast } from 'sonner-native'

// Configure Google Sign-In
export const configureGoogleSignIn = () => {
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
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

    const credential = auth.AppleAuthProvider.credential(identityToken, nonce)
    await auth().signInWithCredential(credential)
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

    const credential = auth.GoogleAuthProvider.credential(res.data.idToken)
    await auth().signInWithCredential(credential)
  } catch (error) {
    console.error('Google sign-in error:', error)
    toast.error('Failed to sign in with Google')
  }
}
