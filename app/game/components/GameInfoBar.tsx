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
        <Text className="text-gray-900 dark:text-white">{game.userCount}</Text>
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
      <TouchableOpacity onPress={handleLeaderboard}>
        <Ionicons name="trophy-sharp" size={24} color="slategray" />
      </TouchableOpacity>
    </View>
  )
}
