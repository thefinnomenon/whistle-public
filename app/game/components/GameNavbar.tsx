import { Feather, Ionicons } from '@expo/vector-icons'
import React from 'react'
import { Alert, Image, Text, TouchableOpacity, View } from 'react-native'

import { NFL } from '../../../logos'

type Props = {
  game: any
  insetsTop: number
  onLeave: () => void
  onSettings: () => void
}

export function GameNavbar({ game, insetsTop, onLeave, onSettings }: Props) {
  const handleLeave = () => {
    Alert.alert(
      'Leave Game',
      'Are you sure you want to leave the game? You will forfeit your current score and will no longer receive questions.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'OK', onPress: onLeave },
      ]
    )
  }

  return (
    <View
      className="flex flex-row items-center justify-center border-b border-gray-300 dark:border-gray-800 relative"
      style={{ paddingTop: insetsTop, height: 64 + insetsTop }}
    >
      {game.state === 'open' && (
        <TouchableOpacity
          className="absolute left-4 z-50"
          style={{ top: insetsTop + 18 }}
          onPress={handleLeave}
        >
          <Feather name="x" size={28} color="slategray" />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        className="absolute right-4 z-50"
        style={{ top: insetsTop + 20 }}
        onPress={onSettings}
      >
        <Ionicons name="settings-outline" size={24} color="slategray" />
      </TouchableOpacity>
      <View className="flex flex-row items-center gap-3">
        <Image
          className="h-12 w-12"
          resizeMode="contain"
          source={NFL[game.homeTeam as keyof typeof NFL]}
        />
        <Text className="font-bold text-lg text-gray-900 dark:text-white">
          VS
        </Text>
        <Image
          className="h-12 w-12"
          resizeMode="contain"
          source={NFL[game.awayTeam as keyof typeof NFL]}
        />
      </View>
    </View>
  )
}
