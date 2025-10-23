import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Text } from '@/components/ui/text'
import { useAuth } from '@/lib/contexts/AuthContext'
import {
  cancelNotification,
  checkNotificationPermission,
  createNotificationChannel,
  displayNotification,
  getFCMToken,
  openAppNotificationSettings,
  requestNotificationPermission,
} from '@/lib/notifications'
import notifee, { AndroidImportance, EventType } from '@notifee/react-native'
import { router } from 'expo-router'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useColorScheme } from 'nativewind'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { toast } from 'sonner-native'

const videoSource = null

export default function OnboardingScreen() {
  const { completeOnboarding } = useAuth()
  const { colorScheme } = useColorScheme()
  const [step, setStep] = useState<'intro' | 'practice'>('intro')
  const [loading, setLoading] = useState(false)
  const [videoStarted, setVideoStarted] = useState(false)
  const [notificationId, setNotificationId] = useState<string | null>(null)
  const [userAnswer, setUserAnswer] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [windowClosed, setWindowClosed] = useState(false)
  const [windowClosedTimer, setWindowClosedTimer] = useState<number | null>(
    null
  )
  const [showResultTimer, setShowResultTimer] = useState<number | null>(null)
  const [showMissedResponse, setShowMissedResponse] = useState(false)
  const [showFinalAnswer, setShowFinalAnswer] = useState(false)
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = false
    player.muted = false
    player.pause()
  })

  useEffect(() => {
    if (windowClosed && !userAnswer) {
      setShowMissedResponse(true)
      console.log('No answer so pausing video and canceling notification')
      player.pause()
      if (notificationId) cancelNotification(notificationId).then(() => {})
      if (showResultTimer) clearTimeout(showResultTimer)
      return
    }

    if (showResult && userAnswer) {
      setShowFinalAnswer(true)
    }
  }, [
    windowClosed,
    userAnswer,
    showResult,
    player,
    notificationId,
    showResultTimer,
  ])

  useEffect(() => {
    // Listen for notification actions
    const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.ACTION_PRESS && detail.pressAction?.id) {
        console.log('User pressed action:', detail.pressAction.id)
        if (!windowClosed) {
          console.log('Setting user answer', detail.pressAction.id)
          setUserAnswer(detail.pressAction.id)
          if (windowClosedTimer) clearTimeout(windowClosedTimer)
          player.play()
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [windowClosed, windowClosedTimer])

  const handleNext = () => {
    setStep('practice')
  }

  const sendPracticeNotification = async () => {
    try {
      const channelId = await createNotificationChannel(
        'practice',
        'Practice Notifications',
        AndroidImportance.HIGH
      )

      setNotificationId(
        await displayNotification(
          '[PAT vs ATL] Will this play result in a touchdown?',
          'Tap Yes or No to make your prediction!',
          {
            channelId,
            categoryId: 'practice',
            actions: [
              { title: '✅ Yes', id: 'yes' },
              { title: '❌ No', id: 'no' },
            ],
          }
        )
      )

      // Close prediction window
      setWindowClosedTimer(
        setTimeout(async () => {
          setWindowClosed(true)
        }, 12000)
      )

      // Timer to show result
      setShowResultTimer(
        setTimeout(() => {
          setShowResult(true)
        }, 17000)
      )
    } catch (error) {
      console.error('Error displaying notification:', error)
      toast.error(`Failed to show notification: ${error}`)
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

      // Start video playback
      setVideoStarted(true)
      player.play()

      // Send practice notification
      setTimeout(() => {
        sendPracticeNotification()
      }, 3000)
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
    // Reset state
    setUserAnswer(null)
    setShowResult(false)
    setWindowClosed(false)
    setVideoStarted(true)
    setShowMissedResponse(false)
    setShowFinalAnswer(false)
    if (showResultTimer) clearTimeout(showResultTimer)
    if (windowClosedTimer) clearTimeout(windowClosedTimer)

    // Reset video to beginning
    player.pause()
    player.currentTime = 0

    // Start video
    player.play()

    // Send practice notification
    setTimeout(() => {
      sendPracticeNotification()
    }, 3000)
  }

  const handleSkip = async () => {
    setLoading(true)
    try {
      // Request permission without showing practice round
      const granted = await requestNotificationPermission()

      if (granted) {
        await completeOnboarding()
        router.replace('/')
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
    await completeOnboarding()
    router.replace('/username')
  }

  if (step === 'intro') {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <Image
            source={
              colorScheme === 'dark'
                ? require('@/assets/images/adaptive-icon-dark.png')
                : require('@/assets/images/adaptive-icon.png')
            }
            style={{
              width: 96,
              height: 96,
              borderRadius: 20,
              marginBottom: 32,
            }}
          />

          <Text className="text-3xl font-bold text-foreground mb-4 text-center">
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
                <View className="gap-1">
                  <Text className="text-lg font-semibold text-foreground">
                    2. Answer predictions
                  </Text>
                  <Text className="text-muted-foreground">
                    Throughout the game, you will receive interactive push
                    notifications which you should answer directly and quickly
                    since the next play could literally be seconds away!
                  </Text>
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
                  <Text className="text-center text-muted-foreground mb-4">
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

          {videoStarted && !showResult && (
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
                !windowClosed && (
                  <Text className="text-muted-foreground text-center">
                    Check your notification and make your prediction!
                  </Text>
                )
              )}
            </>
          )}

          {showMissedResponse && (
            <>
              <Card className="mb-4">
                <CardContent>
                  <Text className="text-lg font-semibold text-center text-foreground mb-2">
                    You missed the response window!
                  </Text>
                  <Text className="text-center text-muted-foreground">
                    In a real game, you need to respond quickly before the next
                    play starts. Try again!
                  </Text>
                </CardContent>
              </Card>
              <Button onPress={handlePlayAgain}>
                <Text>Try Again</Text>
              </Button>
            </>
          )}

          {showFinalAnswer && (
            <>
              <Card>
                <CardContent>
                  <Text className="text-lg font-semibold text-center text-foreground mb-2">
                    You answered: {userAnswer === 'yes' ? 'Yes' : 'No'}
                  </Text>
                  <Text className="text-center text-muted-foreground">
                    {userAnswer === 'yes'
                      ? '✅ Correct! Great prediction!'
                      : "❌ Not quite! You'll get it next time!"}
                  </Text>
                </CardContent>
              </Card>
              <Button variant="outline" onPress={handlePlayAgain}>
                <Text>Play Again</Text>
              </Button>
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
