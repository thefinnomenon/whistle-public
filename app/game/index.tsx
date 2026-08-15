import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AppState,
  Share,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { analytics } from '@/lib/analytics'
import { subscribeToGameTopic, unsubscribeFromGameTopic } from '@/lib/fcm'
import { FeaturedPoolProgress } from '@/components/FeaturedPoolProgress'

import { useAuth } from '@/lib/contexts/AuthContext'
import { useGame } from '@/lib/contexts/GameContext'
import { getGameShareLink } from '@/lib/gameParticipation'
import {
  getGamePlayerStream,
  getGameStream,
  getPracticePredictionsStream,
  getPracticeQuestionsStream,
  getQuestionsStream,
} from '@/lib/firebase'
import { createPracticeQuestion } from '@/lib/practice'
import { GameInfoBar } from './components/GameInfoBar'
import { GameNavbar } from './components/GameNavbar'
import { QuestionAnswerModal } from './components/QuestionAnswerModal'
import { QuestionList } from './components/QuestionList'

export default function GameScreen() {
  const insets = useSafeAreaInsets()
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const { gameId, practice } = useLocalSearchParams<{
    gameId: string
    practice?: string
  }>()
  const isPracticeExplicit = practice === 'true'
  const practiceGameId =
    gameId && gameId.startsWith('practice-')
      ? gameId
      : user?.id
        ? `practice-${user.id}`
        : 'practice'
  const isPracticeMode =
    isPracticeExplicit || (gameId ? gameId.startsWith('practice-') : false)

  const [questions, setQuestions] = useState<Question[]>([])
  const [gamePlayer, setGamePlayer] = useState<GamePlayer>()
  const [predictions, setPredictions] = useState<Map<string, string>>(new Map())
  const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(
    null
  )
  const isLeavingRef = useRef(false)
  const unsubscribeGameRef = useRef<(() => void) | undefined>(null)
  const unsubscribeQuestionsRef = useRef<(() => void) | undefined>(null)
  const unsubscribeGamePlayerRef = useRef<(() => void) | undefined>(null)
  const unsubscribePredictionsRef = useRef<(() => void) | undefined>(null)
  const [sendingPractice, setSendingPractice] = useState(false)
  const lastPracticeScoreRef = useRef<number | undefined>(undefined)

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
  const setGamePlayerRef = useRef(setGamePlayer)
  const setPredictionsRef = useRef(setPredictions)
  const practiceAlertShownRef = useRef(false)

  // Keep refs updated
  useEffect(() => {
    gameIdRef.current = gameId
    userIdRef.current = user?.id
    setGameRef.current = setGame
    setQuestionsRef.current = setQuestions
    setGamePlayerRef.current = setGamePlayer
    setPredictionsRef.current = setPredictions
  }, [gameId, user?.id, setGame, setQuestions, setGamePlayer, setPredictions])

  useEffect(() => {
    if (isPracticeMode) return
    setPredictions(
      new Map(Object.entries(gamePlayer?.predictionsByQuestionId ?? {}))
    )
  }, [gamePlayer?.predictionsByQuestionId, isPracticeMode])

  // Practice: derive local score/leaderboard from predictions
  useEffect(() => {
    if (!isPracticeMode || !user?.id) return

    // Count only correct answers (prediction matches resolved answer/randomAnswer)
    const score = Array.from(predictions.entries()).reduce(
      (acc, [qid, pred]) => {
        const q = questions.find((question) => question.id === qid)
        const answerValue =
          // @ts-ignore
          q?.answer !== undefined ? String(q.answer) : String(q?.randomAnswer)
        if (
          answerValue !== undefined &&
          String(pred).toLowerCase() === answerValue.toLowerCase()
        ) {
          return acc + 10
        }
        return acc
      },
      0
    )

    if (lastPracticeScoreRef.current === score) return
    lastPracticeScoreRef.current = score
    // @ts-ignore
    setGamePlayer((prev) => ({
      ...(prev || {}),
      score,
      username: user.username || 'You',
    }))
    // @ts-ignore
    setGame((prev: any) => ({
      ...(prev || {}),
      id: practiceGameId,
      state: 'open',
      prize: 0,
      homeTeam: prev?.homeTeam || 'NE',
      awayTeam: prev?.awayTeam || 'NYJ',
      playerCount: 1,
      leaderboard: [
        {
          userId: user.id,
          username: user.username || 'You',
          score,
          place: 1,
        },
      ],
      startTime: prev?.startTime || (new Date() as any),
      createdAt: prev?.createdAt || (new Date() as any),
      closedAt: prev?.closedAt || (new Date() as any),
      updatedAt: new Date() as any,
    }))
  }, [
    isPracticeMode,
    practiceGameId,
    predictions,
    questions,
    setGame,
    setGamePlayer,
    user?.id,
    user?.username,
  ])

  // Handle leave game
  const handleLeaveGame = useCallback(() => {
    Alert.alert(
      'Exit Game',
      'Exit this screen and stop game notifications? Your score and game entry will be kept, and you can return later.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Exit',
          onPress: async () => {
            if (!user || !game) return
            const id = gameId || game.id
            if (!id) {
              console.error('No game ID available')
              return
            }
            try {
              isLeavingRef.current = true

              analytics.track('Game Exited', {
                user_id: user.id,
                game_id: id,
                username: user.username,
              })

              if (!isPracticeMode) {
                // Unsubscribe from game topic
                await unsubscribeFromGameTopic(id)
              }

              router.replace('/')
            } catch (error) {
              console.error('Failed to leave game:', error)
              isLeavingRef.current = false
            }
          },
        },
      ]
    )
  }, [user, game, gameId, isPracticeMode])

  const handleShareFeaturedGame = useCallback(async () => {
    if (!game?.id || !game.isFeatured) return
    try {
      const shareLink = await getGameShareLink(game.id)
      const result = await Share.share({
        title: `${game.awayTeam} vs ${game.homeTeam} on Whistle`,
        message: `${shareLink.text}\n${shareLink.url}`,
        url: shareLink.url,
      })
      analytics.track('Featured Game Shared', {
        game_id: game.id,
        referral_code: shareLink.referralCode,
        source: 'live_game',
        completed: result.action === Share.sharedAction,
      })
    } catch (error) {
      console.error('Failed to share featured game:', error)
      Alert.alert('Unable to share', 'Please try again in a moment.')
    }
  }, [game])

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        console.log('[Game] App backgrounded - unsubscribing')
        if (unsubscribeGameRef.current) unsubscribeGameRef.current()
        if (unsubscribeQuestionsRef.current) unsubscribeQuestionsRef.current()
        if (unsubscribeGamePlayerRef.current) unsubscribeGamePlayerRef.current()
        if (unsubscribePredictionsRef.current)
          unsubscribePredictionsRef.current()
        unsubscribeGameRef.current = undefined
        unsubscribeQuestionsRef.current = undefined
        unsubscribeGamePlayerRef.current = undefined
        unsubscribePredictionsRef.current = undefined
      } else if (nextAppState === 'active') {
        if (isPracticeMode) {
          const currentUserId = userIdRef.current
          if (currentUserId && !unsubscribeQuestionsRef.current) {
            console.log('[Game] App foregrounded - resubscribing practice')
            Promise.all([
              getPracticeQuestionsStream(
                currentUserId,
                setQuestionsRef.current
              ),
              getPracticePredictionsStream(
                currentUserId,
                setPredictionsRef.current
              ),
            ]).then(([questionsUnsub, predictionsUnsub]) => {
              unsubscribeQuestionsRef.current = questionsUnsub
              unsubscribePredictionsRef.current = predictionsUnsub
              console.log('[Game] Practice resubscribed (2 streams)')
            })
          }
        } else {
          // Only resubscribe if we have gameId and userId and no active subscriptions
          const currentGameId = gameIdRef.current
          const currentUserId = userIdRef.current
          if (currentGameId && currentUserId && !unsubscribeGameRef.current) {
            console.log('[Game] App foregrounded - resubscribing')
            Promise.all([
              getGameStream(currentGameId, setGameRef.current),
              getQuestionsStream(currentGameId, setQuestionsRef.current),
              getGamePlayerStream(
                currentGameId,
                currentUserId,
                setGamePlayerRef.current
              ),
            ]).then(([gameUnsub, questionsUnsub, gamePlayerUnsub]) => {
              unsubscribeGameRef.current = gameUnsub
              unsubscribeQuestionsRef.current = questionsUnsub
              unsubscribeGamePlayerRef.current = gamePlayerUnsub
              console.log(
                `[Game] Successfully resubscribed to game ${currentGameId} (3 subscriptions)`
              )
            })
          }
        }
      }
    })

    return () => {
      subscription.remove()
    }
  }, [isPracticeMode])

  useEffect(() => {
    if (isPracticeMode && !practiceAlertShownRef.current) {
      const timer = setTimeout(() => {
        practiceAlertShownRef.current = true
        Alert.alert(
          'Practice mode',
          'Tap "Send Practice Question" to simulate a game. You can answer here on the game screen, or answer from the notification. Long press to expand on iOS or tap the arrow to expand on Android.'
        )
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [isPracticeMode])

  useFocusEffect(
    useCallback(() => {
      if (!user?.id) {
        console.log('[Game] No gameId or user, skipping subscriptions')
        return
      }

      const targetGameId = isPracticeMode ? practiceGameId : gameId
      if (!targetGameId) {
        console.log('[Game] No target gameId, skipping subscription')
        return
      }

      console.log(
        `[Game] Screen focused - subscribing to ${isPracticeMode ? 'practice' : 'game'} ${targetGameId}`
      )

      const subscribe = async () => {
        if (isPracticeMode) {
          // Reset cached score so we recalc after stream reloads
          lastPracticeScoreRef.current = undefined
          // Build a mock game object so UI renders
          setGame({
            id: practiceGameId,
            state: 'open',
            prize: 0,
            homeTeam: 'NE',
            awayTeam: 'NYJ',
            playerCount: 1,
            leaderboard: [],
            startTime: new Date() as any,
            createdAt: new Date() as any,
            closedAt: new Date() as any,
            updatedAt: new Date() as any,
          } as any)
          setGamePlayer({
            score: 0,
            username: user.username || 'You',
          } as any)

          const [questionsUnsub, predictionsUnsub] = await Promise.all([
            getPracticeQuestionsStream(user.id, setQuestions),
            getPracticePredictionsStream(user.id, setPredictions),
          ])

          unsubscribeQuestionsRef.current = questionsUnsub
          unsubscribePredictionsRef.current = predictionsUnsub
          console.log('[Game] Practice subscribed (2 streams)')

          return
        }

        const [gameUnsub, questionsUnsub, gamePlayerUnsub] = await Promise.all([
          getGameStream(targetGameId, setGame),
          getQuestionsStream(targetGameId, setQuestions),
          getGamePlayerStream(targetGameId, user.id, setGamePlayer),
        ])

        unsubscribeGameRef.current = gameUnsub
        unsubscribeQuestionsRef.current = questionsUnsub
        unsubscribeGamePlayerRef.current = gamePlayerUnsub
        console.log(
          `[Game] Successfully subscribed to game ${targetGameId} (3 subscriptions)`
        )

        // Resubscribe to FCM topic for notifications if available.
        // Users can still play without push permissions.
        try {
          await subscribeToGameTopic(targetGameId)
          console.log(
            `[Game] Resubscribed to FCM topic for game ${targetGameId}`
          )
        } catch (error) {
          console.warn(
            `[Game] Unable to subscribe to notifications for game ${targetGameId}:`,
            error
          )
        }
      }

      subscribe()

      return () => {
        console.log(
          `[Game] Screen unfocused - unsubscribing from ${isPracticeMode ? 'practice' : 'game'} ${targetGameId}`
        )
        if (unsubscribeGameRef.current) unsubscribeGameRef.current()
        if (unsubscribeQuestionsRef.current) unsubscribeQuestionsRef.current()
        if (unsubscribeGamePlayerRef.current) unsubscribeGamePlayerRef.current()
        if (unsubscribePredictionsRef.current)
          unsubscribePredictionsRef.current()
        unsubscribeGameRef.current = undefined
        unsubscribeQuestionsRef.current = undefined
        unsubscribeGamePlayerRef.current = undefined
        unsubscribePredictionsRef.current = undefined
      }
    }, [
      gameId,
      isPracticeMode,
      practiceGameId,
      setGame,
      user?.id,
      user?.username,
    ])
  )

  if (!gameId && !isPracticeMode) return

  if (!game || (!isPracticeMode && !gamePlayer)) return null

  const handlePracticeQuestion = async () => {
    if (!user?.id) return
    setSendingPractice(true)
    try {
      await createPracticeQuestion()
      analytics.track('Practice Question Requested', { user_id: user.id })
    } catch (error: any) {
      console.error('Failed to send practice question:', error)
      Alert.alert(
        'Practice unavailable',
        error?.message || 'Unable to start practice right now.'
      )
    } finally {
      setSendingPractice(false)
    }
  }

  return (
    <View className="flex flex-1">
      <GameNavbar
        game={game}
        insetsTop={insets.top}
        onLeave={handleLeaveGame}
        onShare={handleShareFeaturedGame}
        showLeave={!isPracticeMode && !game.isFeatured}
        showShare={!isPracticeMode && Boolean(game.isFeatured)}
      />
      <GameInfoBar game={game} gamePlayer={gamePlayer} />
      {!isPracticeMode && game.isFeatured && (
        <View className="px-4 py-3">
          <FeaturedPoolProgress
            playerCount={game.playerCount || 0}
            featuredPoolAmount={game.featuredPoolAmount}
            answersSubmitted={gamePlayer?.answersSubmitted ?? 0}
            cashEligibility={gamePlayer?.cashEligibility}
            compact
          />
        </View>
      )}
      {isPracticeMode && (
        <View className="px-4 py-3">
          <TouchableOpacity
            onPress={handlePracticeQuestion}
            disabled={sendingPractice}
            className="bg-blue-500 rounded-lg px-4 py-3 items-center justify-center"
          >
            {sendingPractice ? (
              <Text className="text-white font-semibold">Sending…</Text>
            ) : (
              <Text className="text-white font-semibold">
                Send Practice Question
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}
      <QuestionList
        questions={questions}
        predictions={predictions}
        userId={user?.id}
        onSelect={(q) => setSelectedQuestion(q)}
      />
      <QuestionAnswerModal
        question={selectedQuestion}
        gameId={isPracticeMode ? practiceGameId : (gameId as string)}
        userId={user?.id}
        isPractice={isPracticeMode}
      />
    </View>
  )
}
