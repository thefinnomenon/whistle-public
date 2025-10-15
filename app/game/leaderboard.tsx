import { FlashList } from '@shopify/flash-list'

import { useGame } from '@/lib/contexts/GameContext'
import { ordinal } from '@/lib/format'
import { Text, View } from 'react-native'

export default function LeaderboardScreen() {
  const { game } = useGame()

  if (!game) return

  return (
    <View className="flex flex-1">
      <FlashList
        data={game.leaderboard}
        renderItem={({ item }: { item: LeaderboardItem }) => (
          <View className="flex flex-row justify-between items-center p-4">
            <Text className="flex-1 text-left text-bold text-gray-400 dark:text-gray-500">
              {ordinal(item.place)}
            </Text>
            <Text className="flex-1 flex-shrink text-bold text-gray-900 dark:text-white">
              {item.username}
            </Text>
            <Text className="flex-1 text-right text-gray-900 dark:text-white">
              {item.score}
            </Text>
          </View>
        )}
      />
    </View>
  )
}
