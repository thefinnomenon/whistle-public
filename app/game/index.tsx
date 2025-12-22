import {
  router,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { analytics } from '@/lib/analytics'
import { subscribeToGameTopic, unsubscribeFromGameTopic } from '@/lib/fcm'
import {
  checkNotificationPermission,
  requestNotificationPermission,
} from '@/lib/notifications'

import { useAuth } from '@/lib/contexts/AuthContext'
import { useGame } from '@/lib/contexts/GameContext'
import {
  deleteGamePlayer,
  getGamePlayerStream,
  getGameStream,
  getQuestionsStream,
  getUserGameStream,
  getUserPredictionsStream,
} from '@/lib/firebase'
import { GameInfoBar } from './components/GameInfoBar'
import { GameNavbar } from './components/GameNavbar'
import { QuestionAnswerModal } from './components/QuestionAnswerModal'
import { QuestionList } from './components/QuestionList'

export default function GameScreen() {
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const { gameId } = useLocalSearchParams<{
    gameId: string
  }>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [userGame, setUserGame] = useState<UserGame>()
  const [gamePlayer, setGamePlayer] = useState<GamePlayer>()
  const [predictions, setPredictions] = useState<Map<string, string>>(new Map())
  const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(
    null
  )
  const isLeavingRef = useRef(false)
  const isMountedRef = useRef(false)
  const unsubscribeGameRef = useRef<(() => void) | undefined>(null)
  const unsubscribeQuestionsRef = useRef<(() => void) | undefined>(null)
  const unsubscribeUserGameRef = useRef<(() => void) | undefined>(null)
  const unsubscribeGamePlayerRef = useRef<(() => void) | undefined>(null)
  const unsubscribePredictionsRef = useRef<(() => void) | undefined>(null)

  // Control selected question for auto-opening
  useEffect(() => {
    const latest = questions[questions.length - 1]
    if (!latest) {
      setSelectedQuestion(null)
      return
    }
    const expiresAt =
      (latest.timeoutAt as any)?.toMillis?.() ?? Number(latest.timeoutAt)
    const timedOut = Number.isFinite(expiresAt) && expiresAt <= Date.now()
    const alreadyAnswered = predictions.get(latest.id) !== undefined
    if (latest.state !== 'open' || timedOut || alreadyAnswered) {
      setSelectedQuestion(null)
    } else {
      setSelectedQuestion(latest)
    }
  }, [predictions, questions])

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

  // Handle leave game
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

  if (!game || !userGame) return null

  return (
    <View className="flex flex-1">
      <GameNavbar
        game={game}
        insetsTop={insets.top}
        onLeave={handleLeaveGame}
        onSettings={() => router.push('/settings')}
      />
      <GameInfoBar game={game} gamePlayer={gamePlayer} />
      <QuestionList
        questions={questions}
        predictions={predictions}
        userId={user?.id}
        onSelect={(q) => setSelectedQuestion(q)}
      />
      <QuestionAnswerModal
        question={selectedQuestion}
        gameId={gameId}
        userId={user?.id}
      />
    </View>
  )
}
