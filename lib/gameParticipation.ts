import { env } from '@/lib/env'
import { getAuth, getIdToken } from '@react-native-firebase/auth'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JoinGameResult = {
  joined: boolean
  playerCount: number
  prizeAmount: number
  featuredPoolAmount: number | null
}

export type LeaveGameResult = {
  left: boolean
  playerCount: number
}

export type GameShareLink = {
  url: string
  text: string
  referralCode: string
}

const parseJsonObject = (body: string): { [key: string]: JsonValue } => {
  const parsed = JSON.parse(body) as JsonValue
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Invalid server response')
  }
  return parsed
}

const requiredBoolean = (
  value: JsonValue | undefined,
  field: string
): boolean => {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${field}`)
  return value
}

const requiredNumber = (
  value: JsonValue | undefined,
  field: string
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

const requiredString = (
  value: JsonValue | undefined,
  field: string
): string => {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`)
  return value
}

const request = async (
  path: string,
  method: 'POST' | 'DELETE',
  body?: { [key: string]: JsonValue }
): Promise<{ [key: string]: JsonValue }> => {
  const firebaseUser = getAuth().currentUser
  if (!firebaseUser) throw new Error('Sign in required')
  if (!env.DOMAIN) throw new Error('Whistle API is not configured')
  const token = await getIdToken(firebaseUser)
  const response = await fetch(`${env.DOMAIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const responseBody = await response.text()
  const data = responseBody ? parseJsonObject(responseBody) : {}
  if (!response.ok) {
    const message = data.error
    throw new Error(
      typeof message === 'string' ? message : `HTTP ${response.status}`
    )
  }
  return data
}

export const joinGameOnServer = async (params: {
  gameId: string
  platform: string
  source?: string
  referralCode?: string
}): Promise<JoinGameResult> => {
  const data = await request(`/api/games/${params.gameId}/join`, 'POST', {
    platform: params.platform,
    source: params.source || 'direct',
    ...(params.referralCode ? { referralCode: params.referralCode } : {}),
  })
  const featuredPoolAmount = data.featuredPoolAmount
  return {
    joined: requiredBoolean(data.joined, 'joined'),
    playerCount: requiredNumber(data.playerCount, 'playerCount'),
    prizeAmount: requiredNumber(data.prizeAmount, 'prizeAmount'),
    featuredPoolAmount:
      featuredPoolAmount === null
        ? null
        : requiredNumber(featuredPoolAmount, 'featuredPoolAmount'),
  }
}

export const leaveGameOnServer = async (
  gameId: string
): Promise<LeaveGameResult> => {
  const data = await request(`/api/games/${gameId}/join`, 'DELETE')
  return {
    left: requiredBoolean(data.left, 'left'),
    playerCount: requiredNumber(data.playerCount, 'playerCount'),
  }
}

export const getGameShareLink = async (
  gameId: string
): Promise<GameShareLink> => {
  const data = await request(`/api/games/${gameId}/referral-link`, 'POST')
  return {
    url: requiredString(data.url, 'url'),
    text: requiredString(data.text, 'text'),
    referralCode: requiredString(data.referralCode, 'referralCode'),
  }
}

export const deleteAccountOnServer = async (): Promise<void> => {
  await request('/api/account', 'DELETE')
}
