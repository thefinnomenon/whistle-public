import { Ionicons } from '@expo/vector-icons'
import { doc, getDoc, getFirestore } from '@react-native-firebase/firestore'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Image, Text, TouchableOpacity, View } from 'react-native'
import { toast } from 'sonner-native'

import { useAuth } from '@/lib/contexts/AuthContext'
import { useGame } from '@/lib/contexts/GameContext'
import { getLatestGame, updateGamePlayer, updateUserGame } from '@/lib/firebase'
import { NFL } from '@/logos'

const db = getFirestore()

export default function GameLobbyScreen() {
  const { user } = useAuth()
  const { game, setGame } = useGame()
  const [canJoin, setCanJoin] = useState(true)
  const [hasUserJoined, setHasUserJoined] = useState<boolean | null>(null)
  const [hasRedirected, setHasRedirected] = useState(false)
  const unsubscribeRef = useRef<(() => void) | undefined>(null)
  const userRef = useRef(user)
  const setGameRef = useRef(setGame)

  // Keep refs updated
  useEffect(() => {
    userRef.current = user
    setGameRef.current = setGame
  }, [user, setGame])

  const hasAlreadyJoined = async (userId: string, gameId: string) => {
    const playerDoc = await getDoc(doc(db, `games/${gameId}/users`, userId))
    if (playerDoc.exists()) {
      console.log('User already joined game!')
      return true
    } else return false
  }

  const hasJoinedAndLeft = async (userId: string, gameId: string) => {
    const userGameDoc = await getDoc(doc(db, `users/${userId}/games`, gameId))
    if (userGameDoc.exists()) {
      console.log(
        'User already joined game and left! Not permitting to join again...'
      )
      return true
    } else return false
  }

  useEffect(() => {
    const checkNofiticationPermissions = async () => {
      // Check for notification permissions
    }
    checkNofiticationPermissions()
  }, [])

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

  useEffect(() => {
    if (!game || !user || hasRedirected) return
    ;(async () => {
      const alreadyJoined = await hasAlreadyJoined(user.id, game.id)
      if (alreadyJoined) {
        setHasUserJoined(true)
        // Auto-redirect if game is open
        if (game.state === 'open') {
          setHasRedirected(true)
          router.push({ pathname: '/game', params: { gameId: game.id } })
        }
      } else {
        const alreadyJoinedAndLeft = await hasJoinedAndLeft(user.id, game.id)
        if (alreadyJoinedAndLeft) setCanJoin(false)
        setHasUserJoined(false)
      }
    })()
  }, [game, user, hasRedirected])

  const joinGame = async () => {
    if (!game || !user) return

    // If already joined, just navigate to the game
    if (hasUserJoined) {
      setHasRedirected(true)
      router.push({ pathname: '/game', params: { gameId: game.id } })
      return
    }

    // Otherwise, join the game
    console.log(`User ${user.id} is joining game ${game.id}`)
    try {
      await updateUserGame(user.id, game.id, { score: 0 })
      await updateGamePlayer(game.id, user.id, {
        score: 0,
        username: user.username,
      })
      setHasUserJoined(true)
      if (game?.state === 'open') {
        setHasRedirected(true)
        router.push({ pathname: '/game', params: { gameId: game.id } })
      } else {
        toast.success("You're in! We'll notify you when the game starts.")
      }
    } catch (e) {
      console.error('Failed to join game, ', e)
    }
  }

  if (!game || hasUserJoined === null) return null

  const isJoinDisabled =
    !canJoin || (hasUserJoined && game.state === 'scheduled')

  return (
    <View className="flex-1 items-center justify-start px-4">
      {/* Header with Settings Icon */}
      <View className="w-full flex-row justify-end pt-12 px-4 absolute top-0 right-0 z-10">
        <TouchableOpacity onPress={() => router.push('/settings')}>
          <Ionicons name="settings-outline" size={28} color="slategray" />
        </TouchableOpacity>
      </View>

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
          className={`w-3/4 bg-blue-500 hover:bg-blue-700 py-4 px-6 rounded-lg ${
            (isJoinDisabled || (hasUserJoined && game.state === 'scheduled')) &&
            'bg-gray-300 hover:bg-gray-300'
          }`}
          disabled={
            isJoinDisabled || (hasUserJoined && game.state === 'scheduled')
          }
          onPress={() => joinGame()}
        >
          {!hasUserJoined ? (
            <Text className="text-white font-bold text-xl text-center">
              JOIN GAME
            </Text>
          ) : (
            <Text className="text-white font-bold text-xl text-center">
              ENTER GAME
            </Text>
          )}
        </TouchableOpacity>
        {!canJoin && (
          <InfoCard message="You've already left this game and cannot rejoin." />
        )}
        {hasUserJoined && game.state === 'scheduled' && (
          <InfoCard message="You're all set! We'll notify you when the game starts." />
        )}
      </View>
    </View>
  )
}

const InfoCard = ({ message }: { message: string }) => (
  <View className="w-3/4 mt-4 p-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-800">
    <Text className="text-gray-900 dark:text-white text-center">{message}</Text>
  </View>
)
