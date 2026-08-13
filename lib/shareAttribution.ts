import AsyncStorage from '@react-native-async-storage/async-storage'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type GameShareAttribution = {
  gameId: string
  source: string
  referralCode?: string
}

const PENDING_GAME_ATTRIBUTION_KEY = 'pendingGameShareAttribution'

const parseAttribution = (value: string): GameShareAttribution | null => {
  const parsed = JSON.parse(value) as JsonValue
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    return null
  }
  const gameId = parsed.gameId
  const source = parsed.source
  const referralCode = parsed.referralCode
  if (typeof gameId !== 'string' || typeof source !== 'string') return null
  if (referralCode !== undefined && typeof referralCode !== 'string')
    return null
  return {
    gameId,
    source,
    ...(referralCode ? { referralCode } : {}),
  }
}

export const savePendingGameAttribution = async (
  attribution: GameShareAttribution
): Promise<void> => {
  await AsyncStorage.setItem(
    PENDING_GAME_ATTRIBUTION_KEY,
    JSON.stringify(attribution)
  )
}

export const getPendingGameAttribution =
  async (): Promise<GameShareAttribution | null> => {
    const value = await AsyncStorage.getItem(PENDING_GAME_ATTRIBUTION_KEY)
    if (!value) return null
    try {
      return parseAttribution(value)
    } catch {
      return null
    }
  }

export const clearPendingGameAttribution = async (
  gameId: string
): Promise<void> => {
  const attribution = await getPendingGameAttribution()
  if (attribution?.gameId === gameId) {
    await AsyncStorage.removeItem(PENDING_GAME_ATTRIBUTION_KEY)
  }
}
