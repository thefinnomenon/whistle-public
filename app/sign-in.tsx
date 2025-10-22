import { Text } from '@/components/ui/text'
import { signInWithApple, signInWithGoogle } from '@/lib/auth'
import { useColorScheme } from 'nativewind'
import { useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Path } from 'react-native-svg'

export default function SignInScreen() {
  const [loading, setLoading] = useState(false)
  const { colorScheme } = useColorScheme()

  const handleAppleSignIn = async () => {
    setLoading(true)
    await signInWithApple()
    setLoading(false)
  }

  const handleGoogleSignIn = async () => {
    setLoading(true)
    await signInWithGoogle()
    setLoading(false)
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center px-6">
        {/* Top section with icon - 1/3 of screen */}
        <View className="flex-1 justify-center items-center">
          <Image
            source={
              colorScheme === 'dark'
                ? require('@/assets/images/adaptive-icon-dark.png')
                : require('@/assets/images/adaptive-icon.png')
            }
            style={{
              width: 128,
              height: 128,
              borderRadius: 24,
              marginBottom: 24,
            }}
          />
          <Text className="text-4xl font-bold text-foreground mb-2">
            Whistle
          </Text>
          <Text className="text-lg text-muted-foreground text-center">
            Sign in to get started
          </Text>
        </View>

        {/* Bottom section with sign-in options */}
        <View className="w-full max-w-md pb-8 gap-3">
          {Platform.OS === 'ios' && (
            <Pressable
              onPress={handleAppleSignIn}
              disabled={loading}
              className="w-full h-11 bg-black dark:bg-white border border-border rounded-lg flex-row items-center justify-center gap-3"
            >
              {loading ? (
                <ActivityIndicator color="white" />
              ) : (
                <>
                  <Svg width="30" height="30" viewBox="0 0 22 24">
                    <Path
                      d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
                      fill={colorScheme === 'dark' ? 'black' : 'white'}
                    />
                  </Svg>
                  <Text className="text-white dark:text-black text-base font-medium mr-4 ml-[-2]">
                    Sign in with Apple
                  </Text>
                </>
              )}
            </Pressable>
          )}
          <Pressable
            onPress={handleGoogleSignIn}
            disabled={loading}
            className="w-full h-11 bg-white dark:bg-zinc-800 border border-border rounded-lg flex-row items-center justify-center gap-3"
          >
            {loading ? (
              <ActivityIndicator />
            ) : (
              <>
                <Svg width="18" height="18" viewBox="0 0 18 18">
                  <Path
                    fill="#4285F4"
                    d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                  />
                  <Path
                    fill="#34A853"
                    d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
                  />
                  <Path
                    fill="#FBBC05"
                    d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"
                  />
                  <Path
                    fill="#EA4335"
                    d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                  />
                </Svg>
                <Text className="text-zinc-900 dark:text-zinc-100 text-base font-medium">
                  Sign in with Google
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  )
}
