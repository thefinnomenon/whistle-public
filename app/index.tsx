import { Asset } from 'expo-asset'
import { Image as ExpoImage } from 'expo-image'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Platform,
  Share,
  ScrollView,
  Text,
  View,
} from 'react-native'

import { FeaturedPoolProgress } from '@/components/FeaturedPoolProgress'
import { Button } from '@/components/ui/button'
import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import { subscribeToGameTopic, unsubscribeFromGameTopic } from '@/lib/fcm'
import { getGames, getUserGamesStream } from '@/lib/firebase'
import {
  getGameShareLink,
  joinGameOnServer,
  leaveGameOnServer,
} from '@/lib/gameParticipation'
import {
  clearPendingGameAttribution,
  GameShareAttribution,
  getPendingGameAttribution,
} from '@/lib/shareAttribution'
import { cn } from '@/lib/utils'
import { NBA, NFL } from '@/logos'
import { Ionicons, MaterialCommunityIcons, Octicons } from '@expo/vector-icons'
import { Timestamp } from '@react-native-firebase/firestore'
import { cssInterop, useColorScheme } from 'nativewind'
import { toast } from 'sonner-native'
// This is needed since ExpoImage isn't supported by NativeWind
cssInterop(ExpoImage, { className: 'style' })

if (
  Platform.OS === 'android' &&
  (global as any).UIManager?.setLayoutAnimationEnabledExperimental
) {
  ;(global as any).UIManager.setLayoutAnimationEnabledExperimental(true)
}

type DayOption = { label: string; date: Date; dayNum: number }

const DISPLAY_WINDOW_MS = 5 * 60 * 60 * 1000

const isVisibleNflGame = (game: Game) =>
  game.league === 'NFL' || game.sport === 'FOOTBALL'

const buildDayOptions = (games: Game[]): DayOption[] => {
  const now = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const cutoffMs = now.getTime() - DISPLAY_WINDOW_MS
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const includeYesterday = games.some((game) => {
    const start =
      (game.startTime as any)?.toDate?.() ??
      new Date((game.startTime as unknown as number) || Date.now())
    return (
      start instanceof Date &&
      sameDay(start, yesterday) &&
      start.getTime() >= cutoffMs
    )
  })

  const start = includeYesterday ? yesterday : today
  const dayCount = includeYesterday ? 8 : 7
  const days: DayOption[] = []
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i) // yesterday/today + next days
    const dayNum = d.getDate()
    days.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      date: d,
      dayNum,
    })
  }
  return days
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

export default function GamesScreen() {
  const params = useLocalSearchParams<{
    gameId?: string | string[]
    source?: string | string[]
    ref?: string | string[]
  }>()
  const incomingGameId = Array.isArray(params.gameId)
    ? params.gameId[0]
    : params.gameId
  const incomingSource = Array.isArray(params.source)
    ? params.source[0]
    : params.source
  const incomingReferralCode = Array.isArray(params.ref)
    ? params.ref[0]
    : params.ref
  const [shareAttribution, setShareAttribution] =
    useState<GameShareAttribution | null>(() =>
      incomingGameId
        ? {
            gameId: incomingGameId,
            source: incomingSource || 'shared_link',
            ...(incomingReferralCode
              ? { referralCode: incomingReferralCode }
              : {}),
          }
        : null
    )
  const { colorScheme } = useColorScheme()
  const iconColor = colorScheme === 'dark' ? '#ffffff' : '#000000'
  const { user } = useAuth()
  const [games, setGames] = useState<Game[]>([])
  const [userGames, setUserGames] = useState<Map<string, UserGame>>(new Map())
  const [joiningGameId, setJoiningGameId] = useState<string | null>(null)
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<Date>(() => {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now
  })
  const logoAssets = useMemo(
    () => [...Object.values(NFL), ...Object.values(NBA)],
    []
  )
  const fadeAnim = useRef(new Animated.Value(1)).current
  const isFirstRenderRef = useRef(true)
  const handledIncomingGameRef = useRef<string | null>(null)

  useEffect(() => {
    if (incomingGameId) {
      setShareAttribution({
        gameId: incomingGameId,
        source: incomingSource || 'shared_link',
        ...(incomingReferralCode ? { referralCode: incomingReferralCode } : {}),
      })
      return
    }
    void getPendingGameAttribution().then(setShareAttribution)
  }, [incomingGameId, incomingReferralCode, incomingSource])

  useEffect(() => {
    Asset.loadAsync(logoAssets as any).catch((err) =>
      console.warn('Failed to preload logos', err)
    )
  }, [logoAssets])

  // Keep the current consumer experience focused on NFL games. NBA remains
  // supported by the shared game model and rendering paths for a future return.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    const sub = async () => {
      unsubscribe = await getGames((nextGames) => {
        setGames(nextGames.filter(isVisibleNflGame))
      })
    }
    sub()
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  // Subscribe to user's joined games (persist across modal navigations)
  useEffect(() => {
    if (!user?.id) return
    let unsub: (() => void) | undefined
    const sub = async () => {
      unsub = await getUserGamesStream(user.id, setUserGames)
    }
    sub()
    return () => {
      if (unsub) unsub()
    }
  }, [user?.id])

  // Fade in list on day change
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    fadeAnim.setValue(0.3)
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 260,
      useNativeDriver: true,
    }).start()
  }, [selectedDay, fadeAnim])

  const dayOptions = useMemo(() => buildDayOptions(games), [games])

  const gamesForDay = useMemo(() => {
    const now = new Date()
    const cutoffMs = now.getTime() - DISPLAY_WINDOW_MS
    return games
      .map((g) => {
        const start =
          (g.startTime as any)?.toDate?.() ??
          new Date((g.startTime as unknown as number) || Date.now())
        return { ...g, start }
      })
      .filter((g) => {
        if (!(g.start instanceof Date)) return false
        if (!sameDay(g.start as Date, selectedDay)) return false
        return (g.start as Date).getTime() >= cutoffMs
      })
      .sort(
        (a, b) =>
          Number(Boolean(b.isFeatured)) - Number(Boolean(a.isFeatured)) ||
          (a.start as Date).getTime() - (b.start as Date).getTime()
      )
  }, [games, selectedDay])

  useEffect(() => {
    if (
      !shareAttribution?.gameId ||
      handledIncomingGameRef.current === shareAttribution.gameId ||
      games.length === 0
    ) {
      return
    }
    const incomingGame = games.find(
      (game) => game.id === shareAttribution.gameId
    )
    const incomingStart = incomingGame?.startTime?.toDate?.()
    if (incomingStart) {
      const day = new Date(incomingStart)
      day.setHours(0, 0, 0, 0)
      setSelectedDay(day)
      handledIncomingGameRef.current = shareAttribution.gameId
      analytics.track('Shared Game Opened', {
        game_id: shareAttribution.gameId,
        source: shareAttribution.source,
        has_referral: Boolean(shareAttribution.referralCode),
      })
    }
  }, [games, shareAttribution])

  const handleJoin = async (game: Game & { start?: Date }) => {
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to join games.')
      return
    }
    if (joiningGameId) return

    setJoiningGameId(game.id)
    try {
      if (!user.username) {
        throw new Error('Username is required to join a game.')
      }

      // Small delay so the loading state is visible
      await new Promise((res) => setTimeout(res, 500))

      const kickoffTime =
        game.start &&
        (game.start as Date).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })

      const joinResult = await joinGameOnServer({
        gameId: game.id,
        platform: Platform.OS,
        source:
          shareAttribution?.gameId === game.id
            ? shareAttribution.source
            : 'games_list',
        referralCode:
          shareAttribution?.gameId === game.id
            ? shareAttribution.referralCode
            : undefined,
      })
      await subscribeToGameTopic(game.id)
      analytics.track('Game Joined', {
        user_id: user.id,
        game_id: game.id,
        username: user.username,
        game_state: game.state,
        source:
          shareAttribution?.gameId === game.id
            ? shareAttribution.source
            : 'games_list',
        has_referral: Boolean(
          shareAttribution?.gameId === game.id && shareAttribution.referralCode
        ),
      })
      await clearPendingGameAttribution(game.id)
      if (shareAttribution?.gameId === game.id) setShareAttribution(null)
      // Optimistic count + membership
      setUserGames((prev) => {
        const next = new Map(prev)
        next.set(game.id, { score: 0, updatedAt: Timestamp.now() })
        return next
      })
      setGames((prev) =>
        prev.map((g) =>
          g.id === game.id
            ? {
                ...g,
                playerCount: joinResult.playerCount,
                prizeAmount: joinResult.prizeAmount,
                ...(joinResult.featuredPoolAmount !== null
                  ? { featuredPoolAmount: joinResult.featuredPoolAmount }
                  : {}),
              }
            : g
        )
      )
      toast.success(
        `Joined ${game.awayTeam} vs ${game.homeTeam}!\nEnter when live at ${kickoffTime || ''}.`
      )
    } catch (err) {
      console.error('Join failed', err)
      Alert.alert('Join failed', 'Unable to join this game right now.')
    } finally {
      setJoiningGameId(null)
    }
  }

  const handleLeave = (game: Game) => {
    if (!user) return
    Alert.alert(
      'Leave game',
      'Are you sure you want to leave this game?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              setLeavingGameId(game.id)
              await unsubscribeFromGameTopic(game.id)
              const leaveResult = await leaveGameOnServer(game.id)
              setUserGames((prev) => {
                const next = new Map(prev)
                next.delete(game.id)
                return next
              })
              setGames((prev) =>
                prev.map((g) =>
                  g.id === game.id
                    ? {
                        ...g,
                        playerCount: leaveResult.playerCount,
                      }
                    : g
                )
              )
            } catch (err) {
              console.error('Leave failed', err)
              Alert.alert(
                'Leave failed',
                'Unable to leave this game right now.'
              )
            } finally {
              setLeavingGameId(null)
            }
          },
        },
      ],
      { cancelable: true }
    )
  }

  const handleShare = async (game: Game) => {
    try {
      const shareLink = await getGameShareLink(game.id)
      const result = await Share.share({
        title: `${game.awayTeam} vs ${game.homeTeam} on Whistle`,
        message: `${shareLink.text}\n${shareLink.url}`,
        url: shareLink.url,
      })
      analytics.track('Featured Game Shared', {
        game_id: game.id,
        referral_code: shareLink.referralCode,
        completed: result.action === Share.sharedAction,
      })
    } catch (error) {
      console.error('Share failed', error)
      Alert.alert('Unable to share', 'Please try again in a moment.')
    }
  }

  const renderGame = ({ item }: { item: Game & { start?: Date } }) => {
    const iconColor = colorScheme === 'dark' ? '#ffffff' : '#000000'
    const joined = userGames.has(item.id)
    const canEnter =
      joined &&
      item.state !== 'cancelled' &&
      (item.state === 'open' || item.state === 'resolved')
    const logoHome =
      item.league === 'NBA'
        ? NBA[item.homeTeam as keyof typeof NBA]
        : NFL[item.homeTeam as keyof typeof NFL]
    const logoAway =
      item.league === 'NBA'
        ? NBA[item.awayTeam as keyof typeof NBA]
        : NFL[item.awayTeam as keyof typeof NFL]
    const kickoffTime =
      item.start &&
      (item.start as Date).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    const showJoin =
      !joined && item.state !== 'resolved' && item.state !== 'cancelled'
    const showFinished = !joined && item.state === 'resolved'
    const isCashPrize =
      item.prizeType === 'USD' ||
      (item as any)?.prizeType === 'USD' ||
      (item as any)?.prize === 'cash'
    const prizeAmount = (item.prizeAmount ||
      (item as any)?.prize ||
      0) as number
    const prizeLabel = isCashPrize ? (
      <Text className="text-sm font-semibold text-foreground">
        {`$${prizeAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
      </Text>
    ) : (
      <View className="flex-row items-center">
        <MaterialCommunityIcons
          name="whistle-outline"
          size={16}
          color={iconColor}
        />
        <Text className="text-sm font-semibold text-foreground">
          {prizeAmount.toLocaleString('en-US', {
            maximumFractionDigits: 0,
          })}
        </Text>
      </View>
    )

    return (
      <View className="bg-card border border-border rounded-2xl p-4 mb-4">
        {item.isFeatured && (
          <View className="mb-3">
            <FeaturedPoolProgress
              playerCount={item.playerCount || 0}
              featuredPoolAmount={item.featuredPoolAmount}
              compact
            />
          </View>
        )}
        <View className="flex-row gap-2">
          <View className="flex-1 flex-row items-center gap-4 bg-background/60 rounded-xl relative">
            <View className="items-center">
              <ExpoImage
                className="w-16 h-16"
                contentFit="contain"
                transition={0}
                source={logoAway}
              />
              <Text className="text-sm font-semibold text-foreground mt-1">
                {item.awayTeam}
              </Text>
            </View>
            <Text className="font-bold text-lg text-foreground">vs</Text>
            <View className="items-center">
              <ExpoImage
                className="w-16 h-16"
                contentFit="contain"
                transition={0}
                source={logoHome}
              />
              <Text className="text-sm font-semibold text-foreground mt-1">
                {item.homeTeam}
              </Text>
            </View>
          </View>
          <View className="h-28 w-36 justify-between bg-background/60 rounded-xl">
            <View className="items-end">
              <Text className="text-sm font-semibold text-foreground">
                {kickoffTime || ''}
              </Text>
              {prizeAmount > 0 && (
                <View className="flex-row items-center gap-1">
                  <Octicons
                    name="trophy"
                    size={12}
                    color={iconColor}
                    className="mr-1"
                  />
                  {prizeLabel}
                </View>
              )}
              <View className="flex-row items-center gap-1">
                <Ionicons name="people-outline" size={16} color={iconColor} />
                <Text className="text-sm font-semibold text-foreground">
                  {item.playerCount || 0}
                </Text>
              </View>
            </View>
            {joined ? (
              <View className="flex-row items-center gap-2">
                <Button
                  disabled={!canEnter}
                  onPress={() =>
                    canEnter &&
                    router.push({
                      pathname: '/game',
                      params: { gameId: item.id },
                    })
                  }
                  className={cn(
                    'flex-1 h-11 rounded-lg',
                    canEnter ? 'bg-blue-600 opacity-90' : 'bg-blue-200'
                  )}
                >
                  {leavingGameId === item.id ? (
                    <ActivityIndicator color="white" style={{ height: 12 }} />
                  ) : (
                    <Text
                      className={cn(
                        'font-semibold text-center',
                        canEnter ? 'text-white' : 'text-blue-900'
                      )}
                    >
                      Enter
                    </Text>
                  )}
                </Button>
                {item.isFeatured &&
                  (item.state === 'scheduled' || item.state === 'open') && (
                    <Button
                      variant="ghost"
                      className="h-11 px-1"
                      onPress={() => handleShare(item)}
                    >
                      <Ionicons
                        name="person-add-outline"
                        size={18}
                        color="#2878ff"
                      />
                    </Button>
                  )}
                {item.state === 'scheduled' && (
                  <Button
                    variant="ghost"
                    className="h-11 ml-1 px-0"
                    onPress={() => handleLeave(item)}
                    disabled={leavingGameId === item.id}
                  >
                    {leavingGameId === item.id ? (
                      <ActivityIndicator color="red" style={{ height: 10 }} />
                    ) : (
                      <Ionicons name="log-out-outline" size={16} color="red" />
                    )}
                  </Button>
                )}
              </View>
            ) : showJoin ? (
              <Button
                onPress={() => handleJoin(item)}
                disabled={joiningGameId === item.id}
                className="px-4 py-3 rounded-lg bg-blue-600"
              >
                {joiningGameId === item.id ? (
                  <ActivityIndicator color="white" style={{ height: 16 }} />
                ) : (
                  <Text className="text-white font-semibold text-center leading-none">
                    Join
                  </Text>
                )}
              </Button>
            ) : showFinished ? (
              <Button disabled className="px-4 py-3 rounded-lg bg-slate-200">
                <Text className="text-slate-500 font-semibold text-center leading-none">
                  Finished
                </Text>
              </Button>
            ) : null}
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background px-4 pt-12">
      <View className="h-14 flex-row items-center justify-end gap-2">
        <View className="flex-row items-center gap-1">
          <MaterialCommunityIcons
            name="whistle-outline"
            size={18}
            color={iconColor}
          />
          <Text className="text-sm font-semibold text-foreground">
            {(user?.points ?? 0).toLocaleString()}
          </Text>
        </View>
        <Button
          variant="ghost"
          className="w-14 h-14 rounded-full"
          onPress={() => router.push('/settings')}
        >
          <Ionicons name="settings-outline" size={20} color="slategray" />
        </Button>
      </View>

      <View className="h-24">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mb-6"
          contentContainerStyle={{ alignItems: 'center' }}
        >
          {dayOptions.map((day) => {
            const isSelected = sameDay(day.date, selectedDay)
            const baseBg = isSelected ? 'bg-blue-600' : 'bg-transparent'
            const baseBorder = isSelected ? 'border-blue-600' : 'border-border'
            return (
              <Button
                key={`${day.label}-${day.dayNum}`}
                onPress={() => setSelectedDay(day.date)}
                variant="outline"
                className={cn(
                  'mr-2 h-16 w-16 rounded-full items-center justify-center border p-0',
                  baseBg,
                  baseBorder,
                  isSelected ? 'active:bg-blue-600' : 'active:bg-transparent',
                  !games.some((g) => {
                    const start =
                      (g.startTime as any)?.toDate?.() ??
                      new Date((g.startTime as unknown as number) || Date.now())
                    return (
                      start instanceof Date && sameDay(start as Date, day.date)
                    )
                  }) && 'opacity-60'
                )}
                disabled={
                  !games.some((g) => {
                    const start =
                      (g.startTime as any)?.toDate?.() ??
                      new Date((g.startTime as unknown as number) || Date.now())
                    return (
                      start instanceof Date && sameDay(start as Date, day.date)
                    )
                  })
                }
              >
                <View className="items-center justify-center">
                  <Text
                    className={cn(
                      'text-sm',
                      isSelected ? 'text-white' : 'text-foreground'
                    )}
                  >
                    {day.label}
                  </Text>
                  <Text
                    className={cn(
                      'text-xs',
                      isSelected ? 'text-white/90' : 'text-muted-foreground'
                    )}
                  >
                    {day.dayNum}
                  </Text>
                </View>
              </Button>
            )
          })}
        </ScrollView>
      </View>

      <Animated.View
        style={{
          flex: 1,
          opacity: fadeAnim,
        }}
      >
        {gamesForDay.length === 0 ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-muted-foreground">No games scheduled</Text>
          </View>
        ) : (
          <FlatList
            data={gamesForDay}
            keyExtractor={(item) => item.id}
            renderItem={renderGame}
            showsVerticalScrollIndicator={false}
          />
        )}
      </Animated.View>
    </View>
  )
}
