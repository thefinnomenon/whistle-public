import { Feather, Ionicons } from '@expo/vector-icons'
import { Image as ExpoImage } from 'expo-image'
import React, { useMemo } from 'react'
import { Text, TouchableOpacity, View } from 'react-native'

import { router } from 'expo-router'
import { NBA, NFL } from '../../../logos'

type Props = {
  game: Game
  insetsTop: number
  onLeave: () => void
  onShare?: () => void
  showLeave?: boolean
  showShare?: boolean
}

export function GameNavbar({
  game,
  insetsTop,
  onLeave,
  onShare,
  showLeave = true,
  showShare = false,
}: Props) {
  const logos = useMemo(() => {
    const home =
      game.league === 'NBA'
        ? NBA[game.homeTeam as keyof typeof NBA]
        : NFL[game.homeTeam as keyof typeof NFL]
    const away =
      game.league === 'NBA'
        ? NBA[game.awayTeam as keyof typeof NBA]
        : NFL[game.awayTeam as keyof typeof NFL]
    return {
      home,
      away,
    }
  }, [game.awayTeam, game.homeTeam, game.league])

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
        {game.state === 'open' && showShare && onShare && (
          <TouchableOpacity
            onPress={onShare}
            className="h-10 w-10 items-center justify-center"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Invite friends"
          >
            <Ionicons name="person-add-outline" size={20} color="#2878ff" />
          </TouchableOpacity>
        )}
        {game.state === 'open' && showLeave && (
          <TouchableOpacity
            onPress={onLeave}
            className="h-10 w-10 items-center justify-center"
            hitSlop={8}
          >
            <Ionicons name="log-out-outline" size={20} color="red" />
          </TouchableOpacity>
        )}
      </View>
      <View className="flex flex-row items-center gap-3">
        <ExpoImage
          className="h-12 w-12"
          contentFit="contain"
          source={logos.home}
        />
        <Text className="font-bold text-lg text-gray-900 dark:text-white">
          VS
        </Text>
        <ExpoImage
          className="h-12 w-12"
          contentFit="contain"
          source={logos.away}
        />
      </View>
    </View>
  )
}
