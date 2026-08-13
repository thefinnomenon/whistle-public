import { getFeaturedPoolProgress } from '@/lib/featuredPool'
import { Ionicons } from '@expo/vector-icons'
import { Text, View } from 'react-native'

type FeaturedPoolProgressProps = {
  playerCount: number
  featuredPoolAmount?: number
  compact?: boolean
  answersSubmitted?: number
  cashEligibility?: GamePlayer['cashEligibility']
  showEligibilityRules?: boolean
}

export function FeaturedPoolProgress({
  playerCount,
  featuredPoolAmount,
  compact = false,
  answersSubmitted,
  cashEligibility,
  showEligibilityRules = false,
}: FeaturedPoolProgressProps) {
  const pool = getFeaturedPoolProgress(playerCount, featuredPoolAmount)
  const eligibilityLabel = (() => {
    if (answersSubmitted === undefined) return 'Prize eligibility'
    if (!cashEligibility) {
      return `${answersSubmitted} / 5 answers toward prize eligibility`
    }
    return cashEligibility.qualified ? 'Prize eligible' : 'Not prize eligible'
  })()

  return (
    <View
      className={
        compact
          ? 'rounded-xl border border-blue-400/40 bg-blue-500/10 px-3 py-2'
          : 'rounded-2xl border border-blue-400/40 bg-blue-500/10 p-4'
      }
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Ionicons name="star" size={compact ? 14 : 17} color="#2878ff" />
          <Text
            className={
              compact
                ? 'text-xs font-extrabold uppercase tracking-wide text-blue-600 dark:text-blue-300'
                : 'text-sm font-extrabold uppercase tracking-wide text-blue-600 dark:text-blue-300'
            }
          >
            Featured Game
          </Text>
        </View>
        <Text className="font-extrabold text-foreground">
          ${pool.amount} pool
        </Text>
      </View>

      {pool.nextAmount === null ? (
        <Text className="mt-1 text-xs font-semibold text-muted-foreground">
          $100 pool unlocked
        </Text>
      ) : (
        <>
          <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-200 dark:bg-blue-950">
            <View
              className="h-full rounded-full bg-blue-600"
              style={{ width: `${pool.progress * 100}%` }}
            />
          </View>
          <Text className="mt-1 text-xs font-semibold text-muted-foreground">
            {playerCount} / {pool.nextPlayerThreshold} players.{' '}
            {pool.playersNeeded} more unlock ${pool.nextAmount}
          </Text>
        </>
      )}
      {(answersSubmitted !== undefined || showEligibilityRules) && (
        <View className="mt-2 border-t border-blue-400/20 pt-2">
          <Text className="text-xs font-semibold text-foreground">
            {eligibilityLabel}
          </Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            Answer at least 5 and 50% of questions offered after you join.
          </Text>
        </View>
      )}
    </View>
  )
}
