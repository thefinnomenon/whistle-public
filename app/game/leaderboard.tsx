import { FlashList } from '@shopify/flash-list'

import { useGame } from '@/lib/contexts/GameContext'
import { ordinal } from '@/lib/format'
import { Text, View } from 'react-native'

export default function LeaderboardScreen() {
  const { game } = useGame()

  if (!game) return
  const winnerIds = new Set(game.cashWinnerUserIds ?? [])
  const showCashResults =
    game.isFeatured && game.state === 'resolved' && game.prizeType === 'USD'

  return (
    <View className="flex flex-1">
      {showCashResults && (
        <Text className="px-4 py-3 text-xs text-muted-foreground">
          Prize winners are the highest-scoring eligible players. Eligibility
          requires at least 5 answers and 50% of questions offered after
          joining.
        </Text>
      )}
      <FlashList
        data={game.leaderboard}
        renderItem={({ item }: { item: LeaderboardItem }) => (
          <View className="flex flex-row justify-between items-center p-4">
            <Text className="flex-1 text-left text-bold text-gray-400 dark:text-gray-500">
              {ordinal(item.place)}
            </Text>
            <View className="flex-1 flex-shrink">
              <Text className="text-bold text-gray-900 dark:text-white">
                {item.username}
              </Text>
              {winnerIds.has(item.userId) && (
                <Text className="text-xs font-semibold text-green-600 dark:text-green-400">
                  Prize winner
                </Text>
              )}
            </View>
            <Text className="flex-1 text-right text-gray-900 dark:text-white">
              {item.score}
            </Text>
          </View>
        )}
      />
    </View>
  )
}
