import { Feather, Ionicons } from '@expo/vector-icons'
import React from 'react'
import { Image, Text, TouchableOpacity, View } from 'react-native'

import { router } from 'expo-router'
import { NBA, NFL } from '../../../logos'

type Props = {
  game: any
  insetsTop: number
  onLeave: () => void
  onSettings: () => void
}

export function GameNavbar({ game, insetsTop, onLeave, onSettings }: Props) {
  return (
    <View
      className="flex flex-row items-center justify-center border-b border-gray-300 dark:border-gray-800 relative"
      style={{ paddingTop: insetsTop, height: 64 + insetsTop }}
    >
      <TouchableOpacity
        className="absolute left-4 z-50"
        style={{ top: insetsTop + 18 }}
        onPress={() => router.back()}
      >
        <Feather name="arrow-left" size={26} color="slategray" />
      </TouchableOpacity>
      <View
        className="absolute right-4 z-50 flex-row items-center gap-2"
        style={{ top: insetsTop + 12 }}
      >
        {game.state === 'open' && (
          <TouchableOpacity
            onPress={onLeave}
            className="h-10 w-10 items-center justify-center"
            hitSlop={8}
          >
            <Ionicons name="log-out-outline" size={16} color="red" />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          className="h-10 w-10 rounded-full items-center justify-center"
          onPress={onSettings}
        >
          <Ionicons name="settings-outline" size={22} color="slategray" />
        </TouchableOpacity>
      </View>
      <View className="flex flex-row items-center gap-3">
        <Image
          className="h-12 w-12"
          resizeMode="contain"
          source={
            game.league === 'NBA'
              ? NBA[game.homeTeam as keyof typeof NBA]
              : NFL[game.homeTeam as keyof typeof NFL]
          }
        />
        <Text className="font-bold text-lg text-gray-900 dark:text-white">
          VS
        </Text>
        <Image
          className="h-12 w-12"
          resizeMode="contain"
          source={
            game.league === 'NBA'
              ? NBA[game.awayTeam as keyof typeof NBA]
              : NFL[game.awayTeam as keyof typeof NFL]
          }
        />
      </View>
    </View>
  )
}
