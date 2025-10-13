import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Text } from '@/components/ui/text'
import { useAuth } from '@/lib/contexts/AuthContext'
import messaging from '@react-native-firebase/messaging'
import { router } from 'expo-router'
import { Bell } from 'lucide-react-native'
import { useState } from 'react'
import { ActivityIndicator, Image, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { toast } from 'sonner-native'

export default function OnboardingScreen() {
  const { completeOnboarding } = useAuth()
  const [step, setStep] = useState<'intro' | 'permissions'>('intro')
  const [loading, setLoading] = useState(false)

  const handleNext = () => {
    setStep('permissions')
  }

  const handleRequestPermissions = async () => {
    setLoading(true)
    try {
      const authStatus = await messaging().requestPermission()
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL

      if (enabled) {
        // Get FCM token
        const token = await messaging().getToken()
        console.log('FCM Token:', token)

        // Mark onboarding as complete
        await completeOnboarding()

        toast.success('Push notifications enabled!')
        // Navigate to home
        router.replace('/')
      } else {
        toast.error('Push notifications are required to use this app')
      }
    } catch (error) {
      console.error('Error requesting notifications permission:', error)
      toast.error('Failed to enable push notifications')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'intro') {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <Image
            source={require('@/assets/images/icon.png')}
            style={{
              width: 96,
              height: 96,
              borderRadius: 20,
              marginBottom: 32,
            }}
          />

          <Text className="text-3xl font-bold text-foreground mb-4 text-center">
            Welcome to Whistle
          </Text>

          <Card className="w-full max-w-md mb-8">
            <CardHeader>
              <View className="flex-row items-center gap-3 mb-2">
                <View className="w-12 h-12 bg-primary rounded-full items-center justify-center">
                  <Bell size={24} className="text-primary-foreground" />
                </View>
                <CardTitle>Interactive Push Notifications</CardTitle>
              </View>
              <CardDescription>
                Whistle uses interactive push notifications to keep you engaged
                with live games. You&apos;ll receive real-time updates and can
                interact directly from the notification without opening the app.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <View className="gap-3">
                <View className="flex-row gap-2">
                  <Text className="text-foreground">•</Text>
                  <Text className="flex-1 text-muted-foreground">
                    Get notified when games start
                  </Text>
                </View>
                <View className="flex-row gap-2">
                  <Text className="text-foreground">•</Text>
                  <Text className="flex-1 text-muted-foreground">
                    Respond to plays in real-time
                  </Text>
                </View>
                <View className="flex-row gap-2">
                  <Text className="text-foreground">•</Text>
                  <Text className="flex-1 text-muted-foreground">
                    Never miss a moment of the action
                  </Text>
                </View>
              </View>
            </CardContent>
          </Card>

          <Button onPress={handleNext} className="w-full max-w-md">
            <Text>Next</Text>
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-24 h-24 bg-primary rounded-full items-center justify-center mb-8">
          <Bell size={48} className="text-primary-foreground" />
        </View>

        <Text className="text-3xl font-bold text-foreground mb-4 text-center">
          Enable Push Notifications
        </Text>

        <Text className="text-lg text-muted-foreground text-center mb-8 max-w-md">
          To experience the full power of Whistle, we need permission to send
          you push notifications. Don&apos;t worry - we only send notifications
          for games you&apos;re actively following.
        </Text>

        <Button
          onPress={handleRequestPermissions}
          disabled={loading}
          className="w-full max-w-md"
        >
          {loading ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text>Enable Push Notifications</Text>
          )}
        </Button>
      </View>
    </SafeAreaView>
  )
}
