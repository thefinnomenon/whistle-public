import { Ionicons } from '@expo/vector-icons'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { toast } from 'sonner-native'

import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import { useGame } from '@/lib/contexts/GameContext'
import { subscribeToGameTopic } from '@/lib/fcm'
import { getLatestGame, updateGamePlayer, updateUserGame } from '@/lib/firebase'
import { NFL } from '@/logos'

export default function GameLobbyScreen() {
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const insets = useSafeAreaInsets()
  const unsubscribeRef = useRef<(() => void) | undefined>(null)
  const userRef = useRef(user)
  const setGameRef = useRef(setGame)
  const [joining, setJoining] = useState(false)

  // Keep refs updated
  useEffect(() => {
    userRef.current = user
    setGameRef.current = setGame
  }, [user, setGame])

  // Handle app state changes (background/foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        console.log('[Lobby] App backgrounded - unsubscribing')
        if (unsubscribeRef.current) {
          unsubscribeRef.current()
          unsubscribeRef.current = undefined
        }
      } else if (nextAppState === 'active') {
        // Check if we should resubscribe (only if we have a user and no active subscription)
        if (userRef.current && !unsubscribeRef.current) {
          console.log('[Lobby] App foregrounded - resubscribing')
          getLatestGame(setGameRef.current).then((unsub) => {
            unsubscribeRef.current = unsub
            console.log('[Lobby] Successfully resubscribed to latest game')
          })
        }
      }
    })

    return () => {
      subscription.remove()
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (!user) {
        console.log('[Lobby] No user, skipping subscription')
        return
      }

      console.log('[Lobby] Screen focused - subscribing to latest game')

      const subscribe = async () => {
        unsubscribeRef.current = await getLatestGame(setGame)
        console.log('[Lobby] Successfully subscribed to latest game')
      }

      subscribe()

      return () => {
        console.log('[Lobby] Screen unfocused - unsubscribing from latest game')
        if (unsubscribeRef.current) {
          unsubscribeRef.current()
          unsubscribeRef.current = undefined
        }
      }
    }, [setGame, user])
  )

  const joinGame = async () => {
    if (!game || !user || joining) return

    setJoining(true)
    console.log(`User ${user.id} is joining game ${game.id}`)
    try {
      await updateUserGame(user.id, game.id, { score: 0 })
      await updateGamePlayer(game.id, user.id, {
        score: 0,
        username: user.username,
        platform: Platform.OS,
      })

      // Subscribe to game topic for notifications
      await subscribeToGameTopic(game.id)

      // Track game join
      analytics.track('Game Joined', {
        user_id: user.id,
        game_id: game.id,
        username: user.username,
        game_state: game.state,
      })

      if (game?.state === 'open') {
        router.push({ pathname: '/game', params: { gameId: game.id } })
      } else {
        toast.success("You're in! We'll notify you when the game starts.")
      }
    } catch (e) {
      console.error('Failed to join game, ', e)
    } finally {
      setJoining(false)
    }
  }

  if (!game) {
    return (
      <View className="flex-1 items-center justify-center px-4">
        {/* Header with Settings Icon */}
        <TouchableOpacity
          className="absolute right-4 z-10"
          style={{ top: insets.top + 20 }}
          onPress={() => router.push('/settings')}
        >
          <Ionicons name="settings-outline" size={24} color="slategray" />
        </TouchableOpacity>

        <View className="items-center gap-4">
          <Ionicons name="calendar-outline" size={64} color="slategray" />
          <Text className="text-2xl font-semibold text-gray-900 dark:text-white text-center">
            No games scheduled
          </Text>
          <Text className="text-lg text-gray-600 dark:text-gray-400 text-center px-8">
            Check back soon for upcoming games!
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1 items-center justify-start px-4">
      {/* Header with Settings Icon */}
      <TouchableOpacity
        className="absolute right-4 z-10"
        style={{ top: insets.top + 20 }}
        onPress={() => router.push('/settings')}
      >
        <Ionicons name="settings-outline" size={24} color="slategray" />
      </TouchableOpacity>

      {/* Team Logos - Top Third */}
      <View className="w-full h-1/3 flex-row items-center justify-center pt-12">
        <View className="flex-1 items-center justify-center">
          <Image
            className="w-32 h-32"
            resizeMode="contain"
            source={NFL[game.homeTeam]}
          />
        </View>
        <Text className="font-bold text-3xl mx-4 text-gray-900 dark:text-white">
          VS
        </Text>
        <View className="flex-1 items-center justify-center">
          <Image
            className="w-32 h-32"
            resizeMode="contain"
            source={NFL[game.awayTeam]}
          />
        </View>
      </View>

      {/* Game Info */}
      <View className="w-full items-center gap-6 mt-8">
        <View className="items-center">
          <Text className="text-4xl font-bold text-gray-900 dark:text-white">
            $
            {game.prize.toLocaleString('en-US', {
              currency: 'USD',
              maximumFractionDigits: 0,
            })}
          </Text>
        </View>

        <View className="flex-row items-center gap-2">
          <Ionicons name="people-sharp" size={40} color="slategray" />
          <Text className="text-2xl text-gray-900 dark:text-white">
            {game.userCount || 0}
          </Text>
        </View>

        <View className="items-center">
          <Text className="text-2xl text-gray-900 dark:text-white">
            {game.startTime
              .toDate()
              .toLocaleDateString([], { dateStyle: 'full' })}
          </Text>
          <Text className="text-xl text-gray-900 dark:text-white">
            {game.startTime.toDate().toLocaleTimeString([], {
              timeStyle: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
      </View>

      {/* Join Button */}
      <View className="w-full items-center mt-12">
        <TouchableOpacity
          className="w-3/4 bg-blue-500 hover:bg-blue-700 py-4 px-6 rounded-lg"
          onPress={joinGame}
          disabled={joining}
        >
          {joining ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-white font-bold text-xl text-center">
              JOIN GAME
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  )
}
