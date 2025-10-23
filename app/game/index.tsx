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
  Alert,
  AppState,
  Image,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { unsubscribeFromGameTopic } from '@/lib/fcm'

import { analytics } from '@/lib/analytics'
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
import { NFL } from '../../logos'

export default function GameScreen() {
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const { gameId } = useLocalSearchParams<{ gameId: string }>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [userGame, setUserGame] = useState<UserGame>()
  const [gamePlayer, setGamePlayer] = useState<GamePlayer>()
  const [predictions, setPredictions] = useState<Map<string, boolean>>(
    new Map()
  )
  const isLeavingRef = useRef(false)
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

  const handleLeaveGame = useCallback(() => {
    Alert.alert(
      'Leave Game',
      'Are you sure you want to leave the game? You will forfeit your chance to win, will no longer receive questions, and will not be able to rejoin.',
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
    const listener = navigation.addListener('beforeRemove', (e) => {
      if (isLeavingRef.current) {
        // Allow navigation if we're intentionally leaving
        return
      }
      e.preventDefault()
      handleLeaveGame()
    })
    return () => listener()
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
          />
        )}
        extraData={predictions}
      />
    </View>
  )
}

type Props = {
  question: Question
  prediction?: boolean
}

const QuestionListItem = ({ question, prediction }: Props) => {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'

  let questionState: UserQuestionState = question.state
  if (question.state === 'resolved' && prediction === undefined)
    questionState = 'incorrect'
  else if (question.state === 'resolved' && prediction !== undefined)
    questionState = prediction === question.answer ? 'correct' : 'incorrect'

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

  return (
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
            {prediction ? 'Yes' : 'No'}
          </Text>
        )}
      </View>
    </View>
  )
}
