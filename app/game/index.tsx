import { Feather, FontAwesome5, Ionicons } from '@expo/vector-icons'
import { FlashList } from '@shopify/flash-list'
import {
  router,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Pressable,
  Platform,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'

import { subscribeToGameTopic, unsubscribeFromGameTopic } from '@/lib/fcm'
import {
  checkNotificationPermission,
  requestNotificationPermission,
} from '@/lib/notifications'

import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import { env } from '@/lib/env'
import { useGame } from '@/lib/contexts/GameContext'
import {
  deleteGamePlayer,
  getGamePlayerStream,
  getGameStream,
  getQuestionsStream,
  getUserGameStream,
  getUserPredictionsStream,
} from '@/lib/firebase'
import { NFL } from '../../logos'

export default function GameScreen() {
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { user, firebaseUser } = useAuth()
  const { game, setGame } = useGame()
  const { gameId, questionId } = useLocalSearchParams<{
    gameId: string
    questionId?: string
  }>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [userGame, setUserGame] = useState<UserGame>()
  const [gamePlayer, setGamePlayer] = useState<GamePlayer>()
  const [predictions, setPredictions] = useState<Map<string, string>>(new Map())
  const [autoOpenQuestionId, setAutoOpenQuestionId] = useState<
    string | undefined
  >(Array.isArray(questionId) ? questionId[0] : questionId)
  const isLeavingRef = useRef(false)
  const isMountedRef = useRef(false)
  const unsubscribeGameRef = useRef<(() => void) | undefined>(null)
  const unsubscribeQuestionsRef = useRef<(() => void) | undefined>(null)
  const unsubscribeUserGameRef = useRef<(() => void) | undefined>(null)
  const unsubscribeGamePlayerRef = useRef<(() => void) | undefined>(null)
  const unsubscribePredictionsRef = useRef<(() => void) | undefined>(null)

  // Refs to track current values for AppState listener
  const gameIdRef = useRef(gameId)
  const userIdRef = useRef(user?.id)
  const setGameRef = useRef(setGame)
  const setQuestionsRef = useRef(setQuestions)
  const setUserGameRef = useRef(setUserGame)
  const setGamePlayerRef = useRef(setGamePlayer)
  const setPredictionsRef = useRef(setPredictions)

  // Keep refs updated
  useEffect(() => {
    gameIdRef.current = gameId
    userIdRef.current = user?.id
    setGameRef.current = setGame
    setQuestionsRef.current = setQuestions
    setUserGameRef.current = setUserGame
    setGamePlayerRef.current = setGamePlayer
    setPredictionsRef.current = setPredictions
  }, [
    gameId,
    user?.id,
    setGame,
    setQuestions,
    setUserGame,
    setGamePlayer,
    setPredictions,
  ])

  const normalizedQuestionId = Array.isArray(questionId)
    ? questionId[0]
    : questionId

  // Auto-open routed question when available and answerable
  useEffect(() => {
    if (!normalizedQuestionId) return
    const q = questions.find((item) => item.id === normalizedQuestionId)
    if (!q) return

    const expiresAt = (q.timeoutAt as any)?.toMillis?.() ?? Number(q.timeoutAt)
    const timedOut = Number.isFinite(expiresAt) && expiresAt <= Date.now()
    const alreadyAnswered = predictions.get(q.id) !== undefined

    if (q.state === 'open' && !timedOut && !alreadyAnswered) {
      setAutoOpenQuestionId(q.id)
    } else {
      setAutoOpenQuestionId(undefined)
    }
  }, [normalizedQuestionId, questions, predictions])

  // Clear auto-open if question is not answerable or already answered
  useEffect(() => {
    if (!autoOpenQuestionId) return
    const q = questions.find((item) => item.id === autoOpenQuestionId)
    if (!q) return

    const expiresAt = Number(q.timeoutAt)
    const timedOut = Number.isFinite(expiresAt) && expiresAt <= Date.now()
    const alreadyAnswered = predictions.get(q.id) !== undefined

    if (q.state !== 'open' || timedOut || alreadyAnswered) {
      setAutoOpenQuestionId(undefined)
    }
  }, [autoOpenQuestionId, questions, predictions])

  const handleLeaveGame = useCallback(() => {
    Alert.alert(
      'Leave Game',
      'Are you sure you want to leave the game? You will forfeit your current score and will no longer receive questions.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'OK',
          onPress: async () => {
            if (!user || !game) return
            const id = gameId || game.id
            if (!id) {
              console.error('No game ID available')
              return
            }
            try {
              isLeavingRef.current = true

              // Track game leave
              analytics.track('Game Left', {
                user_id: user.id,
                game_id: id,
                username: user.username,
              })

              // Unsubscribe from game topic
              await unsubscribeFromGameTopic(id)

              // Delete player from game
              await deleteGamePlayer(id, user.id)
              router.replace('/game/lobby')
            } catch (error) {
              console.error('Failed to leave game:', error)
              isLeavingRef.current = false
            }
          },
        },
      ]
    )
  }, [gameId, user, game])

  // Prompt to leave game on hardware back press
  useEffect(() => {
    // Delay setting up the listener to avoid triggering on initial mount/navigation
    const timeout = setTimeout(() => {
      isMountedRef.current = true
    }, 500)

    const listener = navigation.addListener('beforeRemove', (e) => {
      // Don't prevent if intentionally leaving or if just mounted
      if (isLeavingRef.current || !isMountedRef.current) {
        return
      }
      e.preventDefault()
      handleLeaveGame()
    })

    return () => {
      clearTimeout(timeout)
      listener()
    }
  }, [handleLeaveGame, navigation])

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        console.log('[Game] App backgrounded - unsubscribing')
        if (unsubscribeGameRef.current) unsubscribeGameRef.current()
        if (unsubscribeQuestionsRef.current) unsubscribeQuestionsRef.current()
        if (unsubscribeUserGameRef.current) unsubscribeUserGameRef.current()
        if (unsubscribeGamePlayerRef.current) unsubscribeGamePlayerRef.current()
        if (unsubscribePredictionsRef.current)
          unsubscribePredictionsRef.current()
        unsubscribeGameRef.current = undefined
        unsubscribeQuestionsRef.current = undefined
        unsubscribeUserGameRef.current = undefined
        unsubscribeGamePlayerRef.current = undefined
        unsubscribePredictionsRef.current = undefined
      } else if (nextAppState === 'active') {
        // Only resubscribe if we have gameId and userId and no active subscriptions
        const currentGameId = gameIdRef.current
        const currentUserId = userIdRef.current
        if (currentGameId && currentUserId && !unsubscribeGameRef.current) {
          console.log('[Game] App foregrounded - resubscribing')
          Promise.all([
            getGameStream(currentGameId, setGameRef.current),
            getQuestionsStream(currentGameId, setQuestionsRef.current),
            getUserGameStream(
              currentUserId,
              currentGameId,
              setUserGameRef.current
            ),
            getGamePlayerStream(
              currentGameId,
              currentUserId,
              setGamePlayerRef.current
            ),
            getUserPredictionsStream(
              currentGameId,
              currentUserId,
              setPredictionsRef.current
            ),
          ]).then(
            ([
              gameUnsub,
              questionsUnsub,
              userGameUnsub,
              gamePlayerUnsub,
              predictionsUnsub,
            ]) => {
              unsubscribeGameRef.current = gameUnsub
              unsubscribeQuestionsRef.current = questionsUnsub
              unsubscribeUserGameRef.current = userGameUnsub
              unsubscribeGamePlayerRef.current = gamePlayerUnsub
              unsubscribePredictionsRef.current = predictionsUnsub
              console.log(
                `[Game] Successfully resubscribed to game ${currentGameId} (5 subscriptions)`
              )
            }
          )
        }
      }
    })

    return () => {
      subscription.remove()
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (!gameId || !user?.id) {
        console.log('[Game] No gameId or user, skipping subscriptions')
        return
      }

      console.log(`[Game] Screen focused - subscribing to game ${gameId}`)

      const subscribe = async () => {
        const [
          gameUnsub,
          questionsUnsub,
          userGameUnsub,
          gamePlayerUnsub,
          predictionsUnsub,
        ] = await Promise.all([
          getGameStream(gameId, setGame),
          getQuestionsStream(gameId, setQuestions),
          getUserGameStream(user.id, gameId, setUserGame),
          getGamePlayerStream(gameId, user.id, setGamePlayer),
          getUserPredictionsStream(gameId, user.id, setPredictions),
        ])

        unsubscribeGameRef.current = gameUnsub
        unsubscribeQuestionsRef.current = questionsUnsub
        unsubscribeUserGameRef.current = userGameUnsub
        unsubscribeGamePlayerRef.current = gamePlayerUnsub
        unsubscribePredictionsRef.current = predictionsUnsub
        console.log(
          `[Game] Successfully subscribed to game ${gameId} (5 subscriptions)`
        )

        // Check and request notification permissions, then subscribe to FCM topic
        const permissionStatus = await checkNotificationPermission()
        console.log('[Game] Notification permission status:', permissionStatus)

        if (!permissionStatus.granted) {
          console.log('[Game] Requesting notification permission')
          const granted = await requestNotificationPermission()
          if (!granted) {
            console.warn('[Game] Notification permission denied')
            Alert.alert(
              'Notifications Disabled',
              "You won't receive game notifications. You can enable them in Settings.",
              [{ text: 'OK' }]
            )
          }
        }

        // Resubscribe to FCM topic for notifications
        // This handles the case where user signed out and back in
        await subscribeToGameTopic(gameId)
        console.log(`[Game] Resubscribed to FCM topic for game ${gameId}`)
      }

      subscribe()

      return () => {
        console.log(
          `[Game] Screen unfocused - unsubscribing from game ${gameId}`
        )
        if (unsubscribeGameRef.current) unsubscribeGameRef.current()
        if (unsubscribeQuestionsRef.current) unsubscribeQuestionsRef.current()
        if (unsubscribeUserGameRef.current) unsubscribeUserGameRef.current()
        if (unsubscribeGamePlayerRef.current) unsubscribeGamePlayerRef.current()
        if (unsubscribePredictionsRef.current)
          unsubscribePredictionsRef.current()
        unsubscribeGameRef.current = undefined
        unsubscribeQuestionsRef.current = undefined
        unsubscribeUserGameRef.current = undefined
        unsubscribeGamePlayerRef.current = undefined
        unsubscribePredictionsRef.current = undefined
      }
    }, [gameId, setGame, user?.id])
  )

  if (!gameId) return

  const showLeaderboard = () => {
    router.push('/game/leaderboard')
  }

  if (!game || !userGame) return null

  return (
    <View className="flex flex-1">
      <View
        className="flex flex-row items-center justify-center border-b border-gray-300 dark:border-gray-800 relative"
        style={{ paddingTop: insets.top, height: 64 + insets.top }}
      >
        {game.state === 'open' && (
          <TouchableOpacity
            className="absolute left-4 z-50"
            style={{ top: insets.top + 18 }}
            onPress={() => handleLeaveGame()}
          >
            <Feather name="x" size={28} color="slategray" />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          className="absolute right-4 z-50"
          style={{ top: insets.top + 20 }}
          onPress={() => router.push('/settings')}
        >
          <Ionicons name="settings-outline" size={24} color="slategray" />
        </TouchableOpacity>
        <View className="flex flex-row items-center gap-3">
          <Image
            className="h-12 w-12"
            resizeMode="contain"
            source={NFL[game.homeTeam as NFL_Team]}
          />
          <Text className="font-bold text-lg text-gray-900 dark:text-white">
            VS
          </Text>
          <Image
            className="h-12 w-12"
            resizeMode="contain"
            source={NFL[game.awayTeam as NFL_Team]}
          />
        </View>
      </View>
      <View className="flex flex-row items-center justify-between h-12 border-b border-gray-300 dark:border-gray-700 px-4">
        <View className="flex flex-row items-center gap-2">
          <Ionicons name="star" size={22} color="slategray" />
          <Text className="text-gray-900 dark:text-white">
            {gamePlayer?.score || 0}
          </Text>
        </View>
        <View className="flex flex-row items-center gap-2">
          <Ionicons name="people-sharp" size={24} color="slategray" />
          <Text className="text-gray-900 dark:text-white">
            {game.userCount}
          </Text>
        </View>
        <View className="flex flex-row items-center gap-2">
          <FontAwesome5 name="coins" size={24} color="slategray" />
          <Text className="text-gray-900 dark:text-white">
            $
            {game.prize.toLocaleString('en-US', {
              currency: 'USD',
              maximumFractionDigits: 0,
            })}
          </Text>
        </View>
        <TouchableOpacity onPress={() => showLeaderboard()}>
          <Ionicons name="trophy-sharp" size={24} color="slategray" />
        </TouchableOpacity>
      </View>
      <FlashList
        data={questions}
        renderItem={({ item }) => (
          <QuestionListItem
            question={item}
            prediction={predictions.get(item.id)}
            gameId={gameId}
            userId={user?.id}
            autoOpen={item.id === autoOpenQuestionId}
            onModalClose={() => setAutoOpenQuestionId(undefined)}
            getIdToken={firebaseUser?.getIdToken}
          />
        )}
        extraData={[predictions, autoOpenQuestionId]}
      />
    </View>
  )
}

type Props = {
  question: Question
  prediction?: string
  gameId: string
  userId?: string
  autoOpen?: boolean
  onModalClose?: () => void
  getIdToken?: () => Promise<string>
}

const QuestionListItem = ({
  question,
  prediction,
  gameId,
  userId,
  autoOpen,
  onModalClose,
  getIdToken,
}: Props) => {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const [showModal, setShowModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [timeRemainingMs, setTimeRemainingMs] = useState(0)
  const [totalDurationMs, setTotalDurationMs] = useState(0)
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null)

  // Auto-open modal if autoOpen is true and question is still open
  useEffect(() => {
    const expiresAt =
      (question.timeoutAt as any)?.toMillis?.() ?? Number(question.timeoutAt)
    const isTimedOut =
      Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()

    if (
      autoOpen &&
      question.state === 'open' &&
      prediction === undefined &&
      userId &&
      (!Number.isFinite(expiresAt) || expiresAt > Date.now())
    ) {
      setShowModal(true)
    }
  }, [autoOpen, question.state, prediction, userId, question.timeoutAt])

  // Timer for remaining time
  useEffect(() => {
    const timeoutMs =
      (question.timeoutAt as any)?.toMillis?.() ?? Number(question.timeoutAt)
    if (!Number.isFinite(timeoutMs)) return

    const startMs =
      (question.triggeredAt as any)?.toMillis?.() ??
      (question.createdAt as any)?.toMillis?.() ??
      Date.now()
    const total = Math.max(0, timeoutMs - startMs)
    setTotalDurationMs(total)

    const update = () => {
      const remaining = Math.max(0, timeoutMs - Date.now())
      setTimeRemainingMs(remaining)
    }
    update()
    const interval = setInterval(update, 100)
    return () => clearInterval(interval)
  }, [question.createdAt, question.timeoutAt, question.triggeredAt])

  let questionState: UserQuestionState = question.state
  if (question.state === 'resolved' && prediction === undefined)
    questionState = 'incorrect'
  else if (question.state === 'resolved' && prediction !== undefined)
    questionState =
      prediction === (question.answer ?? '') ? 'correct' : 'incorrect'

  let questionStyling = { bg: '', text: '', icon: '', iconColor: '' }
  switch (questionState) {
    case 'open':
      questionStyling = {
        bg: 'bg-white dark:bg-gray-800',
        text: 'text-slate-600 dark:text-slate-300',
        icon: 'clock',
        iconColor: isDark ? '#e5e7eb' : 'black',
      }
      break
    case 'closed':
      questionStyling = {
        bg: 'bg-slate-200 dark:bg-slate-700',
        text: 'text-slate-900 dark:text-slate-100',
        icon: 'help-circle',
        iconColor: 'gray',
      }
      break
    case 'correct':
      questionStyling = {
        bg: 'bg-green-200 dark:bg-green-900',
        text: 'text-green-900 dark:text-green-100',
        icon: 'check-circle',
        iconColor: 'green',
      }
      break
    case 'incorrect':
      questionStyling = {
        bg: 'bg-red-200 dark:bg-red-900',
        text: 'text-red-900 dark:text-red-100',
        icon: 'x-circle',
        iconColor: 'red',
      }
      break
    case 'cancelled':
      questionStyling = {
        bg: 'bg-gray-100 dark:bg-gray-800',
        text: 'text-gray-400 dark:text-gray-500',
        icon: 'slash',
        iconColor: isDark ? '#6b7280' : '#d1d5db',
      }
  }

  const canAnswer =
    question.state === 'open' && prediction === undefined && userId

  const resolveChoiceLabel = (choiceId: string) => {
    const match = question.choices.find((c) =>
      typeof c === 'string'
        ? c === choiceId
        : c.id === choiceId || c.value === choiceId
    )
    if (!match) return choiceId
    return typeof match === 'string' ? match : match.value
  }

  const handleAnswer = async (answer: string) => {
    if (!userId) return

    setSelectedChoiceId(answer)
    setSubmitting(true)
    try {
      const idToken = getIdToken ? await getIdToken() : undefined
      const apiUrl = `${env.DOMAIN}/api/games/${gameId}/questions/${question.id}/prediction`

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          prediction: answer,
          source: `${Platform.OS}-app`,
          questionTimeoutAt: Number(question.timeoutAt),
        }),
      })

      if (!resp.ok) {
        throw new Error(`API response ${resp.status}`)
      }

      // Write to user predictions subcollection (for UI display)
      const { doc, setDoc, serverTimestamp, getFirestore } = await import(
        '@react-native-firebase/firestore'
      )
      const db = getFirestore()
      const userPredictionRef = doc(
        db,
        `users/${userId}/games/${gameId}/predictions/${question.id}`
      )

      await setDoc(userPredictionRef, {
        prediction: answer,
        source: 'app',
        createdAt: serverTimestamp(),
      })

      analytics.track('Prediction Made', {
        user_id: userId,
        game_id: gameId,
        question_id: question.id,
        prediction: answer,
        method: 'app',
      })

      setShowModal(false)
      onModalClose?.()
    } catch (error) {
      console.error('Failed to submit prediction:', error)
      Alert.alert('Error', 'Failed to submit prediction. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const content = (
    <View className={`flex flex-row items-center p-6 ${questionStyling.bg}`}>
      <Feather
        name={questionStyling.icon as any}
        size={24}
        color={questionStyling.iconColor}
      />
      <View className="flex-1 flex-row justify-between bg-transparent">
        <Text className={`ml-4 ${questionStyling.text}`}>
          {question.question}
        </Text>
        {prediction !== undefined && (
          <Text className={`${questionStyling.text} text-md font-bold ml-2`}>
            {resolveChoiceLabel(prediction)}
          </Text>
        )}
      </View>
    </View>
  )

  if (!canAnswer) {
    return content
  }

  return (
    <>
      <TouchableOpacity onPress={() => setShowModal(true)}>
        {content}
      </TouchableOpacity>

      <Modal visible={showModal} transparent animationType="fade">
        <Pressable className="flex-1 bg-black/50 items-center justify-center">
          <Pressable className="bg-white dark:bg-gray-800 rounded-2xl p-6 mx-6 w-5/6 max-w-md">
            <Text className="text-xl font-bold text-gray-900 dark:text-white mb-4 text-center">
              {question.question}
            </Text>

            <View className="gap-3">
              <View className="items-center mb-2">
                <View className="w-20 h-20 items-center justify-center">
                  <Svg width={80} height={80} viewBox="0 0 80 80">
                    <Circle
                      cx={40}
                      cy={40}
                      r={36}
                      stroke="#e5e7eb"
                      strokeWidth={4}
                      fill="none"
                    />
                    {totalDurationMs > 0 && (
                      <Circle
                        cx={40}
                        cy={40}
                        r={36}
                        stroke={
                          timeRemainingMs <= 5000
                            ? '#ef4444'
                            : timeRemainingMs <= 15000
                              ? '#f59e0b'
                              : '#3b82f6'
                        }
                        strokeWidth={4}
                        fill="none"
                        strokeDasharray={2 * Math.PI * 36}
                        strokeDashoffset={
                          2 *
                          Math.PI *
                          36 *
                          (1 -
                            Math.max(
                              0,
                              Math.min(1, timeRemainingMs / totalDurationMs)
                            ))
                        }
                        strokeLinecap="round"
                      />
                    )}
                  </Svg>
                  <View className="absolute inset-0 items-center justify-center">
                    <Text className="text-lg font-bold text-gray-900 dark:text-white">
                      {Math.max(0, Math.floor(timeRemainingMs / 1000))}
                    </Text>
                  </View>
                </View>
              </View>

              {question.choices.map((choice) => {
                const choiceId = typeof choice === 'string' ? choice : choice.id
                const label = typeof choice === 'string' ? choice : choice.value
                const isSelected = submitting && selectedChoiceId === choiceId
                return (
                  <TouchableOpacity
                    key={choiceId}
                    className={`py-4 px-6 rounded-lg ${
                      submitting ? 'bg-blue-300' : 'bg-blue-500'
                    }`}
                    onPress={() => !submitting && handleAnswer(choiceId)}
                    disabled={submitting}
                  >
                    <View className="flex-row items-center justify-center gap-2">
                      {isSelected && <ActivityIndicator color="#fff" />}
                      <Text className="text-white font-bold text-lg text-center">
                        {label}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}
