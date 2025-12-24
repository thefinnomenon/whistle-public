import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Text } from '@/components/ui/text'
import { useAuth } from '@/lib/contexts/AuthContext'
import { env } from '@/lib/env'
import {
  checkNotificationPermission,
  getFCMToken,
  openAppNotificationSettings,
  requestNotificationPermission,
} from '@/lib/notifications'
import { router } from 'expo-router'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Image, Platform, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { toast } from 'sonner-native'

const videoSource = null

export default function OnboardingScreen() {
  const { user, firebaseUser } = useAuth()
  const [step, setStep] = useState<'intro' | 'practice'>('intro')
  const [loading, setLoading] = useState(false)
  const [videoStarted, setVideoStarted] = useState(false)
  const [userAnswer, setUserAnswer] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [showFinalAnswer, setShowFinalAnswer] = useState(false)
  const [timeoutHandle, setTimeoutHandle] = useState<any | null>(null)
  const answerRef = useRef<string | null>(null)

  useEffect(() => {
    answerRef.current = userAnswer
  }, [userAnswer])
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = false
    player.muted = false
    player.pause()
  })

  // Watch for onboardingPrediction from backend practice push
  useEffect(() => {
    if (!user) return
    const prediction = user.onboardingPrediction
    if (prediction) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        setTimeoutHandle(null)
      }
      setUserAnswer(prediction.prediction)
    }
  }, [timeoutHandle, user])

  const handleNext = () => {
    setStep('practice')
  }

  const sendPracticeNotification = async () => {
    try {
      const targetUserId = user?.id || firebaseUser?.uid
      if (!firebaseUser || !targetUserId)
        throw new Error('User not authenticated')
      const idToken = await firebaseUser.getIdToken()
      const resp = await fetch(
        `${env.DOMAIN}/api/games/onboarding/practice-question`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            userId: targetUserId,
          }),
        }
      )
      const data = await resp.json()
      if (!resp.ok) {
        throw new Error(data?.error || `status ${resp.status}`)
      }
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const handle = setTimeout(() => {
        setShowFinalAnswer(true)
      }, 20000)
      setTimeoutHandle(handle as any)
    } catch (error: any) {
      console.error('Error sending practice push:', error)
      toast.error(`Failed to send practice push: ${error?.message || error}`)
      // reset state so onboarding can retry cleanly
      setUserAnswer(null)

      setShowFinalAnswer(false)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      setTimeoutHandle(null)
    }
  }

  const handleReady = async () => {
    setLoading(true)
    setPermissionDenied(false)

    try {
      // Check current permission status
      const currentStatus = await checkNotificationPermission()

      // If denied, show settings button
      if (currentStatus.status === 'denied') {
        setPermissionDenied(true)
        setLoading(false)
        return
      }

      // Request permission
      const granted = await requestNotificationPermission()

      if (!granted) {
        setPermissionDenied(true)
        setLoading(false)
        return
      }

      // Try to get FCM token (optional for this demo)
      const token = await getFCMToken()
      if (token) {
        console.log('FCM Token:', token)
      }

      // Send practice notification via backend/content extension
      sendPracticeNotification()

      // Start video playback
      setVideoStarted(true)
      player.play()
    } catch (error) {
      console.error('Error requesting notifications permission:', error)
      toast.error('Failed to enable push notifications')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenSettings = async () => {
    await openAppNotificationSettings()
  }

  const handlePlayAgain = async () => {
    // Send practice notification
    sendPracticeNotification()

    // Reset state
    setVideoStarted(true)
    setShowFinalAnswer(false)

    // Reset video to beginning
    player.pause()
    player.currentTime = 0

    // Start video
    player.play()

    // Set final answer timer
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const handle = setTimeout(() => {
      setShowFinalAnswer(true)
    }, 20000)
    setTimeoutHandle(handle as any)
  }

  const handleSkip = async () => {
    setLoading(true)
    try {
      // Request permission without showing practice round
      const granted = await requestNotificationPermission()

      if (granted) {
        router.replace('/username')
      } else {
        // If denied, show the permission denied UI
        setPermissionDenied(true)
      }
    } catch (error) {
      console.error('Error during skip:', error)
      toast.error('Failed to request permissions')
    } finally {
      setLoading(false)
    }
  }

  const handleFinish = async () => {
    router.replace('/username')
  }

  if (step === 'intro') {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-3xl font-bold text-foreground mb-6 text-center">
            How it works?
          </Text>

          <Card className="w-full max-w-md mb-8">
            <CardContent>
              <View className="gap-6">
                <View className="gap-1">
                  <Text className="text-lg font-semibold text-foreground">
                    1. Join a game
                  </Text>
                </View>
                <View className="gap-2">
                  <Text className="text-lg font-semibold text-foreground">
                    2. Answer predictions
                  </Text>
                  <Text className="text-muted-foreground">
                    Throughout the game, you will receive interactive push
                    notifications which you should answer directly and quickly
                    since the next play could literally be seconds away!
                  </Text>
                  {Platform.OS === 'ios' && (
                    <Text className="text-foreground text-sm bold">
                      Long press the notification to see the options
                    </Text>
                  )}
                  {Platform.OS === 'android' && (
                    <Text className="text-foreground text-sm bold">
                      Click the arrow to expand the notification and see the
                      options
                    </Text>
                  )}
                  <Image
                    source={
                      Platform.OS === 'ios'
                        ? require('@/assets/images/onboarding/ios_push_example.jpg')
                        : require('@/assets/images/onboarding/android_push_example.png')
                    }
                    style={{
                      width: '100%',
                      height: 120,
                      borderRadius: 12,
                      marginTop: 8,
                    }}
                    resizeMode="contain"
                  />
                </View>
                <View className="gap-1">
                  <Text className="text-lg font-semibold text-foreground">
                    3. Get the most predictions right and win
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
        <Text className="text-3xl font-bold text-foreground mb-6 text-center">
          Let&apos;s do a practice round
        </Text>

        <View
          className="w-full max-w-md mb-6"
          style={{
            borderRadius: 12,
            overflow: 'hidden',
            backgroundColor: '#000',
          }}
        >
          <VideoView
            player={player}
            style={{
              width: '100%',
              height: 200,
            }}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
        </View>

        <View className="w-full max-w-md gap-3">
          {!videoStarted && !permissionDenied && (
            <Button onPress={handleReady} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text>I&apos;m Ready</Text>
              )}
            </Button>
          )}

          {!videoStarted && permissionDenied && (
            <>
              <Card>
                <CardContent>
                  <Text className="text-center text-muted-foreground">
                    Push notifications are required to use this app. Please
                    enable them in your device settings.
                  </Text>
                </CardContent>
              </Card>
              <Button onPress={handleOpenSettings}>
                <Text>Open Settings</Text>
              </Button>
              <Button variant="outline" onPress={handleReady}>
                <Text>Try Again</Text>
              </Button>
            </>
          )}

          {videoStarted && !showFinalAnswer && (
            <>
              {userAnswer ? (
                <Card>
                  <CardContent>
                    <Text className="text-lg font-semibold text-center text-foreground">
                      You answered: {userAnswer === 'yes' ? 'Yes' : 'No'}
                    </Text>
                    <Text className="text-center text-muted-foreground mt-2">
                      Watch to see if you got it right!
                    </Text>
                  </CardContent>
                </Card>
              ) : (
                <Text className="text-muted-foreground text-center">
                  {Platform.OS === 'ios' && (
                    <Text className="text-foreground text-sm bold">
                      Long press the notification and make your prediction!
                    </Text>
                  )}
                  {Platform.OS === 'android' && (
                    <Text className="text-foreground text-sm bold">
                      Press the arrow to expand the notification and make your
                      prediction!
                    </Text>
                  )}
                </Text>
              )}
            </>
          )}

          {showFinalAnswer && (
            <>
              <Card>
                <CardContent>
                  {userAnswer ? (
                    <>
                      <Text className="text-lg font-semibold text-center text-foreground mb-2">
                        You answered: {userAnswer === 'yes' ? 'Yes' : 'No'}
                      </Text>
                      <Text className="text-center text-muted-foreground">
                        {userAnswer === 'yes'
                          ? '✅ Correct! Great prediction!'
                          : "❌ Not quite! You'll get it next time!"}
                      </Text>
                    </>
                  ) : (
                    <Text className="text-lg font-semibold text-center text-foreground">
                      You forgot to answer! Try again!
                    </Text>
                  )}
                </CardContent>
              </Card>
              {!userAnswer && (
                <Button variant="outline" onPress={handlePlayAgain}>
                  <Text>Play Again</Text>
                </Button>
              )}
              <Button onPress={handleFinish}>
                <Text>Next</Text>
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            onPress={handleSkip}
            disabled={loading}
            className="mt-4"
          >
            <Text>Skip →</Text>
          </Button>
        </View>
      </View>
    </SafeAreaView>
  )
}
