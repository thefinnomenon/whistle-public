import { Feather, FontAwesome5, Ionicons } from '@expo/vector-icons'
import { FlashList } from '@shopify/flash-list'
import { router, useLocalSearchParams, useNavigation } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Image,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native'

import { useAuth } from '@/lib/contexts/AuthContext'
import { useGame } from '@/lib/contexts/GameContext'
import {
  deleteGamePlayer,
  getGamePlayerStream,
  getGameStream,
  getQuestionsStream,
  getUserGameStream,
} from '@/lib/firebase'
import { NFL } from '../../logos'

export default function GameScreen() {
  const navigation = useNavigation()
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const { gameId } = useLocalSearchParams<{ gameId: string }>()
  const [questions, setQuestions] = useState<Question[]>([])
  const [userGame, setUserGame] = useState<UserGame>()
  const [gamePlayer, setGamePlayer] = useState<GamePlayer>()
  const isLeavingRef = useRef(false)

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

  useEffect(() => {
    if (!gameId || !user) return

    console.log('Subscribing to Game Info for Game: ', gameId)
    let unsubscribeGame: () => void
    let unsubscribeQuestions: () => void
    let unsubscribeUserGame: () => void
    let unsubscribeGamePlayer: () => void
    ;(async () => {
      unsubscribeGame = await getGameStream(gameId, setGame)
      unsubscribeQuestions = await getQuestionsStream(gameId, setQuestions)
      unsubscribeUserGame = await getUserGameStream(
        user.id,
        gameId,
        setUserGame
      )
      unsubscribeGamePlayer = await getGamePlayerStream(
        gameId,
        user.id,
        setGamePlayer
      )
    })()

    return () => {
      if (unsubscribeGame) unsubscribeGame()
      if (unsubscribeQuestions) unsubscribeQuestions()
      if (unsubscribeUserGame) unsubscribeUserGame()
      if (unsubscribeGamePlayer) unsubscribeGamePlayer()
    }
  }, [gameId, setGame, user])

  if (!gameId) return

  const showLeaderboard = () => {
    router.push('/game/leaderboard')
  }

  if (!game || !userGame) return null

  return (
    <View className="flex flex-1 pt-10">
      <View className="flex flex-row items-center justify-center h-16 border-b border-gray-300 dark:border-gray-700 relative">
        {game.state === 'open' && (
          <TouchableOpacity
            className="absolute left-4 z-50"
            onPress={() => handleLeaveGame()}
          >
            <Feather name="x" size={28} color="slategray" />
          </TouchableOpacity>
        )}
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
          <Ionicons name="star" size={22} color="gold" />
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
          <Ionicons name="trophy-sharp" size={24} color="gold" />
        </TouchableOpacity>
      </View>
      <FlashList
        data={questions}
        renderItem={({ item }) => (
          <QuestionListItem
            question={item}
            prediction={userGame.predictions && userGame.predictions[item.id]}
          />
        )}
        extraData={userGame.predictions}
      />
    </View>
  )
}

type Props = {
  question: Question
  prediction?: { prediction: string; createdAt: FirestoreTimestamp }
}

const QuestionListItem = ({ question, prediction }: Props) => {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'

  let questionState: UserQuestionState = question.state
  if (question.state === 'resolved' && !prediction) questionState = 'incorrect'
  else if (question.state === 'resolved' && prediction)
    questionState =
      prediction.prediction === question.answer ? 'correct' : 'incorrect'

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
        <Text className={`${questionStyling.text} text-md text-bold`}>
          {prediction?.prediction || ''}
        </Text>
      </View>
    </View>
  )
}
