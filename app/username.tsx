import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import { setUsername } from '@/lib/firebase'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Image, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function UsernameScreen() {
  const { firebaseUser, completeOnboarding } = useAuth()
  const [username, setUsernameInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleUsernameChange = (value: string) => {
    setUsernameInput(value)
    setError('')
  }

  const handleSubmit = async () => {
    if (!firebaseUser) return

    setLoading(true)
    try {
      await setUsername(firebaseUser.uid, username)

      // Track username creation
      analytics.track('Username Created', {
        user_id: firebaseUser.uid,
        username,
      })

      await completeOnboarding()
      router.replace('/')
    } catch (error: any) {
      console.error('Error setting username:', error)
      setError(error.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 px-6 pt-8">
        <Image
          source={require('@/assets/images/icon.png')}
          style={{
            width: 96,
            height: 96,
            borderRadius: 20,
            marginBottom: 32,
            alignSelf: 'center',
          }}
        />

        <Text className="text-3xl font-bold text-foreground mb-2 text-center">
          Choose a username
        </Text>

        <Text className="text-muted-foreground text-center mb-8">
          This is how other players will see you
        </Text>

        <View className="w-full max-w-md gap-3">
          <Input
            placeholder="username"
            value={username}
            onChangeText={handleUsernameChange}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={15}
            editable={!loading}
          />

          {error ? <Text className="text-red-500 text-sm">{error}</Text> : null}

          <Button
            onPress={handleSubmit}
            disabled={loading || !username || !!error}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text>Continue</Text>
            )}
          </Button>
        </View>
      </View>
    </SafeAreaView>
  )
}
