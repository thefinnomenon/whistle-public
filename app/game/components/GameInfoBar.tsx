import { FontAwesome5, Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import React from 'react'
import { Text, TouchableOpacity, View } from 'react-native'

type Props = {
  game: any
  gamePlayer: any
}

export function GameInfoBar({ game, gamePlayer }: Props) {
  const handleLeaderboard = () => {
    router.push('/game/leaderboard')
  }

  const prizeAmount =
    (game?.prizeAmount as number | undefined) ??
    (game?.prize as number | undefined) ??
    0
  const isCash =
    game?.prizeType === 'USD' || (game as any)?.prize === 'cash' || false
  const playerCount = game?.playerCount || 0

  return (
    <View className="flex flex-row items-center justify-between h-12 border-b border-gray-300 dark:border-gray-700 px-4">
      <View className="flex flex-row items-center gap-2">
        <Ionicons name="star" size={22} color="slategray" />
        <Text className="text-gray-900 dark:text-white">
          {gamePlayer?.score || 0}
        </Text>
      </View>
      <View className="flex flex-row items-center gap-2">
        <Ionicons name="people-sharp" size={24} color="slategray" />
        <Text className="text-gray-900 dark:text-white">{playerCount}</Text>
      </View>
      <View className="flex flex-row items-center gap-2">
        <FontAwesome5 name="coins" size={24} color="slategray" />
        <Text className="text-gray-900 dark:text-white">
          {isCash ? '$' : ''}
          {prizeAmount.toLocaleString('en-US', {
            maximumFractionDigits: 0,
          })}
          {!isCash && prizeAmount > 0 ? ' Whistles' : ''}
        </Text>
      </View>
      <TouchableOpacity onPress={handleLeaderboard}>
        <Ionicons name="trophy-sharp" size={24} color="slategray" />
      </TouchableOpacity>
    </View>
  )
}
