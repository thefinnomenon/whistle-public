import { createHmac } from 'crypto'
import { execSync } from 'child_process'
import type { Message } from 'firebase-admin/messaging'
import type {
  BoxScore,
  BoxScorePlayer,
  BoxScoreTeam,
  EngineEvent,
  EngineGameState,
  OfficialCumulativeStatsSnapshot,
} from '../types/engine'
import { EngineEventSource, EventType, NbaEventSubType } from '../types/engine'
import { trackEvent } from './mixpanel'
import {
  buildQuestionCreatedProps,
  buildQuestionSentProps,
  deriveQuestionDimensions,
} from './questionAnalytics'
import type {
  PlayerSeasonProfile,
  TeamSeasonProfile,
} from '../workers/seasonProfilesWorker'

type PeriodWindow = 'EARLY' | 'MID' | 'LATE' | 'CLUTCH'
type QuestionWindowType =
  | 'PERIOD'
  | 'NEXT_N_MIN'
  | 'NEXT_EVENT'
  | 'GAME'
  | 'JUMP_BALL'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type ResolutionContextValue =
  | string
  | number
  | boolean
  | null
  | SelectionReason[]
  | { id: string; value: string }[]
  | string[]
  | number[]
  | Record<string, number>
  | Record<string, string>
  | Record<string, JsonValue>
export type ResolutionContext = {
  type?: string
  [key: string]: ResolutionContextValue | undefined
}

type QuestionTemplate = {
  id: string
  text: string
  weight: number
  windowType: QuestionWindowType
  resolutionWindowMs?: number | null
  resolutionContext?: ResolutionContext
}

type SelectionReason = {
  code: string
  detail?: string
}

export type EngineQuestionPayload = {
  templateId: string
  question: string
  windowType: QuestionWindowType
  timeoutMs: number
  resolutionWindowMs?: number | null
  resolutionContext?: ResolutionContext
  selectionReason?: SelectionReason[]
  trigger: string
  period: number
  clockMs: number
}

type QuestionRecord = Partial<EngineQuestionPayload> & {
  resolutionContext?: ResolutionContext
  resolutionWindowMs?: number | null
}

const asString = (value: ResolutionContextValue | undefined): string | null =>
  typeof value === 'string' ? value : null

const asNumber = (value: ResolutionContextValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asBoolean = (
  value: ResolutionContextValue | undefined
): boolean | null => (typeof value === 'boolean' ? value : null)

const asNumberArray = (
  value: ResolutionContextValue | undefined
): number[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? value
    : null

const asChoiceArray = (
  value: ResolutionContextValue | undefined
): { id: string; value: string }[] | null =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      'value' in item &&
      typeof (item as { id: string }).id === 'string' &&
      typeof (item as { value: string }).value === 'string'
  )
    ? (value as { id: string; value: string }[])
    : null

const asSelectionReasons = (
  value: ResolutionContextValue | undefined
): SelectionReason[] | null =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'code' in item &&
      typeof (item as { code: string }).code === 'string'
  )
    ? (value as SelectionReason[])
    : null

const asRecordNumber = (
  value: ResolutionContextValue | undefined
): Record<string, number> | null =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === 'number')
    ? (value as Record<string, number>)
    : null

type TriggerOptions = {
  nowMs?: number
  bypassMarginConditions?: boolean
  bypassCooldown?: boolean
  suppressLogs?: boolean
  skipQuestionGeneration?: boolean
  delayMs?: number
  persistQuestions?: boolean
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
    teamsById: Map<string, TeamSeasonProfile>
  }
  derivedStats?: DerivedStatsSnapshot
}

type DerivedStatLine = {
  points: number
  assists: number
  rebounds: number
  steals: number
  threes: number
  blocks: number
  freeThrowsMade: number
}

export type DerivedStatsSnapshot = {
  teams: Record<string, DerivedStatLine>
  players: Record<string, DerivedStatLine>
}

const LAST_QUESTION_AT_BY_GAME = new Map<string, number>()
const LAST_QUESTION_COOLDOWN_MS_BY_GAME = new Map<string, number>()
const LAST_COOLDOWN_LOGGED_UNTIL_BY_GAME = new Map<string, number>()
const PLAYER_THREE_STREAK_BY_GAME = new Map<string, Map<number, number>>()
const PLAYER_FG_STREAK_BY_GAME = new Map<string, Map<number, number>>()
const TEAM_THREE_STREAK_BY_GAME = new Map<string, Map<string, number>>()
const RECENT_EVENTS_BY_GAME = new Map<
  string,
  {
    timeMs: number
    type: EventType
    playerId: number | null
    teamTricode: string | null
    subType: string | null
  }[]
>()
const GAME_START_ASKED_BY_GAME = new Set<string>()
const PERIOD_GROUPS_BY_GAME = new Map<string, Map<number, Set<string>>>()
const HALF_GROUPS_BY_GAME = new Map<string, Map<number, Set<string>>>()
const GAME_GROUPS_BY_GAME = new Map<string, Set<string>>()
const PLAYER_USAGE_BY_GAME = new Map<
  string,
  Map<number, { period: number; clockMs: number; askedAt: number }>
>()
const QUESTION_SIGNATURE_SECRET = process.env.WHISTLE_JWT_SECRET
const QUESTION_PAYLOAD_VERSION = 1
const USE_OFFICIAL_CUMULATIVE_RESOLUTION =
  process.env.NBA_USE_OFFICIAL_CUMULATIVE_RESOLUTION === '1'
const resolveEngineVersion = (): string => {
  const fromEnv =
    process.env.ENGINE_VERSION ||
    process.env.GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ''
  if (fromEnv) return String(fromEnv).slice(0, 40)
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return sha || 'unknown'
  } catch {
    return 'unknown'
  }
}
const ENGINE_VERSION = resolveEngineVersion()
const MIN_QUESTION_INTERVAL_MS = 4 * 60 * 1000
const MAX_QUESTION_INTERVAL_MS = 8 * 60 * 1000
const QUESTION_TIMEOUT_MS = 30_000
const MIN_RESOLUTION_WINDOW_MS = 30_000

const ASK_QUESTION_PROBABILITY = 1
const PERIOD_START_PROBABILITY = 1
const PERIOD_END_PROBABILITY = 1
const HALFTIME_PROBABILITY = 1
const TIMEOUT_QUESTION_PROBABILITY = 1
const FOUL_QUESTION_PROBABILITY = 1

const QUESTION_TEMPLATES: QuestionTemplate[] = []

const pickFrom = <T>(values: T[]): T =>
  values[Math.floor(Math.random() * values.length)]

const PLAYER_TEMPLATE_IDS = new Set([
  'PERIOD_PLAYER_MILESTONE',
  'PERIOD_PLAYER_ASSISTS',
  'PERIOD_PLAYER_REBOUNDS',
  'PERIOD_PLAYER_STEALS',
])

const filterPlayersBySeasonCandidate = (
  players: BoxScorePlayer[],
  playersById: Map<string, PlayerSeasonProfile>,
  statType: string
) => {
  const filtered = players.filter((player) => {
    const id =
      typeof player?.personId === 'number'
        ? player.personId
        : typeof player?.playerId === 'number'
          ? player.playerId
          : null
    if (!id) return false
    const profile = playersById.get(String(id))
    if (!profile) return false
    if (statType === 'ASSISTS') return profile.isAssistCandidate
    if (statType === 'REBOUNDS') return profile.isReboundCandidate
    if (statType === 'STEALS') return profile.isStealsCandidate
    if (statType === 'THREES') return profile.isThreeCandidate
    if (statType === 'FTM') return profile.isFreeThrowCandidate
    if (statType === 'BLOCKS') return profile.isBlocksCandidate
    return profile.isScoringCandidate
  })
  return filtered.length ? filtered : players
}

const DUNK_RESOLUTION_WINDOW_MS = 3 * 60 * 1000

const getPlayerId = (
  player: BoxScorePlayer | null | undefined
): number | null =>
  typeof player?.personId === 'number'
    ? player.personId
    : typeof player?.playerId === 'number'
      ? player.playerId
      : null

const getPlayerNameFromBoxScore = (
  boxScore: BoxScore | null,
  playerId: number | null
): string | null => {
  if (!playerId) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: BoxScorePlayer[] = []
  if (Array.isArray(homeTeam?.players)) players.push(...homeTeam.players)
  if (Array.isArray(awayTeam?.players)) players.push(...awayTeam.players)
  const match = players.find((player) => getPlayerId(player) === playerId)
  if (!match) return null
  if (typeof match?.name === 'string') return match.name
  if (
    typeof match?.firstName === 'string' &&
    typeof match?.lastName === 'string'
  )
    return `${match.firstName} ${match.lastName}`
  return null
}

const getPlayerFromBoxScore = (
  boxScore: BoxScore | null,
  playerId: number | null
): BoxScorePlayer | null => {
  if (!playerId) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: BoxScorePlayer[] = []
  if (Array.isArray(homeTeam?.players)) players.push(...homeTeam.players)
  if (Array.isArray(awayTeam?.players)) players.push(...awayTeam.players)
  const match = players.find((player) => getPlayerId(player) === playerId)
  return match ?? null
}

const getPlayerTeamTricodeFromBoxScore = (
  playerId: number | null,
  boxScore: BoxScore | null
): string | null => {
  if (!playerId) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homePlayers: BoxScorePlayer[] = Array.isArray(homeTeam?.players)
    ? homeTeam.players
    : []
  const awayPlayers: BoxScorePlayer[] = Array.isArray(awayTeam?.players)
    ? awayTeam.players
    : []
  if (homePlayers.some((player) => getPlayerId(player) === playerId))
    return normalizeTricode(homeTeam?.teamTricode)
  if (awayPlayers.some((player) => getPlayerId(player) === playerId))
    return normalizeTricode(awayTeam?.teamTricode)
  return null
}

const getPeriodLengthMs = (period: number): number =>
  period > 4 ? 5 * 60 * 1000 : 12 * 60 * 1000

const getPlayerTargetInfo = (
  profile: PlayerSeasonProfile | undefined,
  statType: string,
  period: number,
  clockMs: number | null,
  currentStat: number | null
): {
  target: number | null
  perQuarterAvg: number | null
  timeLeftRatio: number | null
} => {
  if (!profile)
    return { target: null, perQuarterAvg: null, timeLeftRatio: null }
  const avg =
    statType === 'POINTS'
      ? profile.ppg
      : statType === 'REBOUNDS'
        ? profile.rpg
        : statType === 'ASSISTS'
          ? profile.apg
          : statType === 'STEALS'
            ? profile.spg
            : statType === 'BLOCKS'
              ? profile.bpg
              : 0
  if (!Number.isFinite(avg) || avg <= 0)
    return { target: null, perQuarterAvg: null, timeLeftRatio: null }
  const perQuarterAvg = avg / 4
  if (
    clockMs !== null &&
    Number.isFinite(clockMs) &&
    currentStat !== null &&
    Number.isFinite(currentStat)
  ) {
    const periodLengthMs = getPeriodLengthMs(period)
    const timeLeftRatio = Math.max(0, Math.min(1, clockMs / periodLengthMs))
    const target = Math.max(
      1,
      Math.ceil(currentStat + perQuarterAvg * timeLeftRatio)
    )
    return { target, perQuarterAvg, timeLeftRatio }
  }
  return {
    target: Math.max(1, Math.ceil(perQuarterAvg * 1.3)),
    perQuarterAvg,
    timeLeftRatio: null,
  }
}

const getPlayerPeriodStat = (
  player: BoxScorePlayer | null | undefined,
  period: number,
  statType: string
): number | null => {
  const periods =
    player?.statistics?.periods ||
    player?.periods ||
    player?.stats?.periods ||
    null
  if (!Array.isArray(periods)) return null
  const entry = periods.find((p) => Number(p?.period) === period)
  if (!entry) return null
  const stats = entry.statistics || entry
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'REBOUNDS')
    return Number(stats.reboundsTotal ?? stats.rebounds ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'BLOCKS') return Number(stats.blocks ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? stats.fg3m ?? 0)
  if (key === 'FTM') return Number(stats.freeThrowsMade ?? stats.ftm ?? 0)
  return null
}

const getPlayerGameStat = (
  player: BoxScorePlayer | null | undefined,
  statType: string
): number | null => {
  const stats = player?.statistics
  if (!stats) return null
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'REBOUNDS')
    return Number(stats.reboundsTotal ?? stats.rebounds ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'BLOCKS') return Number(stats.blocks ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? stats.fg3m ?? 0)
  return null
}

const getPlayerCurrentStat = (
  player: BoxScorePlayer | null | undefined,
  period: number,
  statType: string
): number | null => {
  const periodStat = getPlayerPeriodStat(player, period, statType)
  if (periodStat !== null) return periodStat
  return getPlayerGameStat(player, statType)
}

const getStreakValue = <K extends number | string>(
  map: Map<string, Map<K, number>>,
  gameId: string,
  key: K
): number => {
  const gameMap = map.get(gameId)
  if (!gameMap) return 0
  return gameMap.get(key) ?? 0
}

const setStreakValue = <K extends number | string>(
  map: Map<string, Map<K, number>>,
  gameId: string,
  key: K,
  value: number
) => {
  let gameMap = map.get(gameId)
  if (!gameMap) {
    gameMap = new Map()
    map.set(gameId, gameMap)
  }
  gameMap.set(key, value)
}

const updateStreaksForEvent = (gameId: string, event: EngineEvent) => {
  const shot = event.context?.shot
  const playerId = shot?.shooterId ?? event.context?.primaryPlayerId ?? null
  const teamTricode = shot?.teamTricode ?? event.context?.teamTricode ?? null
  if (!playerId && !teamTricode) return

  const isMade3 = event.type === EventType.MADE_3
  const isMissed3 = event.type === EventType.MISSED_3
  const isMadeFg = event.type === EventType.MADE_FG || isMade3
  const isMissedFg = event.type === EventType.MISSED_FG || isMissed3

  if (playerId) {
    const currentFg = getStreakValue(PLAYER_FG_STREAK_BY_GAME, gameId, playerId)
    const current3 = getStreakValue(
      PLAYER_THREE_STREAK_BY_GAME,
      gameId,
      playerId
    )
    const nextFg = isMadeFg ? currentFg + 1 : isMissedFg ? 0 : currentFg
    const next3 = isMade3 ? current3 + 1 : isMissed3 ? 0 : current3
    setStreakValue(PLAYER_FG_STREAK_BY_GAME, gameId, playerId, nextFg)
    setStreakValue(PLAYER_THREE_STREAK_BY_GAME, gameId, playerId, next3)
  }

  if (teamTricode) {
    const currentTeam3 = getStreakValue(
      TEAM_THREE_STREAK_BY_GAME,
      gameId,
      teamTricode
    )
    const nextTeam3 = isMade3 ? currentTeam3 + 1 : isMissed3 ? 0 : currentTeam3
    setStreakValue(TEAM_THREE_STREAK_BY_GAME, gameId, teamTricode, nextTeam3)
  }
}

const getEventTimeActualMs = (event: EngineEvent): number | null => {
  const timeActual = event.context?.raw?.timeActual ?? null
  if (typeof timeActual !== 'string') return null
  const parsed = Date.parse(timeActual)
  return Number.isFinite(parsed) ? parsed : null
}

const recordRecentEvent = (gameId: string, event: EngineEvent) => {
  const timeMs = getEventTimeActualMs(event)
  if (timeMs === null) return
  const playerId =
    event.context?.shot?.shooterId ??
    event.context?.freeThrow?.shooterId ??
    event.context?.primaryPlayerId ??
    null
  const teamTricode =
    event.context?.shot?.teamTricode ??
    event.context?.freeThrow?.teamTricode ??
    event.context?.teamTricode ??
    null
  const subType = typeof event.subType === 'string' ? event.subType : null
  const entry = { timeMs, type: event.type, playerId, teamTricode, subType }
  const list = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  list.push(entry)
  const cutoff = timeMs - 60_000
  const recent = list.filter((item) => item.timeMs >= cutoff)
  const trimmed = recent.length > 10 ? recent.slice(recent.length - 10) : recent
  RECENT_EVENTS_BY_GAME.set(gameId, trimmed)
}

const shouldSkipForLatency = (
  gameId: string,
  event: EngineEvent,
  questionPayload: EngineQuestionPayload
): boolean => {
  const timeMs = getEventTimeActualMs(event)
  if (timeMs === null) return false
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  const futureCutoff = timeMs + 60_000
  const relevant = recent.filter(
    (item) => item.timeMs > timeMs && item.timeMs <= futureCutoff
  )
  if (!relevant.length) return false
  const context = questionPayload.resolutionContext ?? {}
  const type = asString(context.type) ?? ''

  const matchesEventType = (evt: EventType, expected: string) =>
    String(evt) === expected

  if (type === 'NEXT_EVENT') {
    const expected = asString(context.expectedEventType) ?? ''
    if (!expected) return false
    const expectedSubType = asString(context.expectedSubType)
    return relevant.some((item) => {
      if (!matchesEventType(item.type, expected)) return false
      if (expectedSubType && item.subType !== expectedSubType) return false
      const playerId = asNumber(context.playerId)
      if (playerId && item.playerId !== playerId) return false
      const teamTricode = asString(context.teamTricode)
      if (teamTricode && item.teamTricode !== teamTricode) return false
      return true
    })
  }

  if (type === 'NEXT_DUNK_TEAM') {
    return relevant.some(
      (item) =>
        item.subType === NbaEventSubType.DUNK &&
        (item.type === EventType.MADE_FG || item.type === EventType.MADE_3)
    )
  }

  if (type === 'NEXT_DUNK_PLAYER') {
    const playerIds = asNumberArray(context.playerIds) ?? []
    if (!playerIds.length) return false
    const playerSet = new Set(playerIds)
    return relevant.some(
      (item) =>
        item.subType === NbaEventSubType.DUNK &&
        (item.type === EventType.MADE_FG || item.type === EventType.MADE_3) &&
        item.playerId !== null &&
        playerSet.has(item.playerId)
    )
  }

  const isScoringEvent = (evt: EventType) =>
    evt === EventType.MADE_FG ||
    evt === EventType.MADE_3 ||
    evt === EventType.MADE_FT
  const isMadeThree = (evt: EventType) => evt === EventType.MADE_3
  const isSteal = (evt: EventType) => evt === EventType.STEAL
  const isBlock = (evt: EventType) => evt === EventType.BLOCK
  const isRebound = (evt: EventType) => evt === EventType.REBOUND

  if (type === 'TOTAL_POINTS_NEXT_N') {
    return relevant.some((item) => isScoringEvent(item.type))
  }

  if (type === 'TEAM_POINTS_NEXT_N') {
    const team = asString(context.teamTricode)
    return relevant.some((item) => {
      if (!isScoringEvent(item.type)) return false
      if (team && item.teamTricode !== team) return false
      return true
    })
  }

  if (type === 'MADE_3_COUNT_NEXT_N') {
    return relevant.some((item) => isMadeThree(item.type))
  }

  if (type === 'PLAYER_COMPARE_NEXT_N') {
    const statType = (asString(context.statType) ?? '').toUpperCase()
    const playerIds = asNumberArray(context.playerIds) ?? []
    const matchesPlayer = (item: (typeof relevant)[number]) =>
      playerIds.length
        ? item.playerId !== null && playerIds.includes(item.playerId)
        : true
    const eventMatchesStat = (evt: EventType) => {
      if (statType === 'POINTS') return isScoringEvent(evt)
      if (statType === 'THREES') return isMadeThree(evt)
      if (statType === 'STEALS') return isSteal(evt)
      if (statType === 'BLOCKS') return isBlock(evt)
      if (statType === 'REBOUNDS') return isRebound(evt)
      if (statType === 'ASSISTS')
        return evt === EventType.MADE_FG || evt === EventType.MADE_3
      return false
    }
    return relevant.some(
      (item) => matchesPlayer(item) && eventMatchesStat(item.type)
    )
  }

  if (type === 'BUZZER_BEATER_TIMEOUT') {
    const teamTricode = normalizeTricode(asString(context.teamTricode))
    return relevant.some((item) => {
      const isMade =
        item.type === EventType.MADE_FG || item.type === EventType.MADE_3
      if (!isMade) return false
      if (!teamTricode) return true
      return normalizeTricode(item.teamTricode) === teamTricode
    })
  }

  return false
}

const buildPlayerStreakTemplate = (opts: {
  id: string
  text: string
  statType: string
  expectedEventType: string
  playerId: number
  playerName: string
  teamTricode: string | null
  streak: number
}): QuestionTemplate => ({
  id: opts.id,
  text: opts.text,
  weight: 6,
  windowType: 'NEXT_EVENT',
  resolutionWindowMs: 180_000,
  resolutionContext: {
    type: 'NEXT_EVENT',
    expectedEventType: opts.expectedEventType,
    playerId: opts.playerId,
    playerName: opts.playerName,
    teamTricode: opts.teamTricode,
    streak: opts.streak,
  },
})

const buildTeamThreeStreakTemplate = (opts: {
  teamTricode: string
  streak: number
}): QuestionTemplate => ({
  id: 'PERIOD_TEAM_THREE_STREAK',
  text: `${opts.teamTricode} has hit ${opts.streak} 3s in a row. Will they hit their next 3?`,
  weight: 5,
  windowType: 'NEXT_EVENT',
  resolutionWindowMs: 180_000,
  resolutionContext: {
    type: 'NEXT_EVENT',
    expectedEventType: 'MADE_3',
    teamTricode: opts.teamTricode,
    streak: opts.streak,
  },
})

const getStreakQuestionTemplates = (
  gameId: string,
  event: EngineEvent,
  boxScore: BoxScore | null,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  }
): QuestionTemplate[] => {
  const templates: QuestionTemplate[] = []
  const shot = event.context?.shot
  const playerId = shot?.shooterId ?? event.context?.primaryPlayerId ?? null
  const teamTricode = shot?.teamTricode ?? event.context?.teamTricode ?? null

  if (playerId) {
    const profile = seasonProfiles?.playersById.get(String(playerId))
    const playerName = getPlayerNameFromBoxScore(boxScore, playerId)
    const used = PLAYER_USAGE_BY_GAME.get(gameId)?.has(playerId) ?? false
    const threeStreak = getStreakValue(
      PLAYER_THREE_STREAK_BY_GAME,
      gameId,
      playerId
    )
    const fgStreak = getStreakValue(PLAYER_FG_STREAK_BY_GAME, gameId, playerId)
    if (
      playerName &&
      !used &&
      event.type === EventType.MADE_3 &&
      threeStreak >= 2 &&
      profile?.isThreeCandidate
    ) {
      templates.push(
        buildPlayerStreakTemplate({
          id: 'PERIOD_PLAYER_THREE_STREAK',
          text: `${playerName} has hit ${threeStreak} 3s in a row. Will they hit their next 3?`,
          statType: 'THREES',
          expectedEventType: 'MADE_3',
          playerId,
          playerName,
          teamTricode,
          streak: threeStreak,
        })
      )
    }
    if (
      playerName &&
      !used &&
      event.type === EventType.MADE_FG &&
      fgStreak >= 4 &&
      profile?.isScoringCandidate
    ) {
      templates.push(
        buildPlayerStreakTemplate({
          id: 'PERIOD_PLAYER_FG_STREAK',
          text: `${playerName} has hit ${fgStreak} shots in a row. Will they hit their next shot?`,
          statType: 'POINTS',
          expectedEventType: 'MADE_FG',
          playerId,
          playerName,
          teamTricode,
          streak: fgStreak,
        })
      )
    }
  }

  if (teamTricode && event.type === EventType.MADE_3) {
    const teamStreak = getStreakValue(
      TEAM_THREE_STREAK_BY_GAME,
      gameId,
      teamTricode
    )
    if (teamStreak >= 2) {
      templates.push(
        buildTeamThreeStreakTemplate({
          teamTricode,
          streak: teamStreak,
        })
      )
    }
  }

  return templates
}

const buildPlayerCompareTemplate = (
  template: QuestionTemplate,
  boxScore: BoxScore | null,
  excludeIds?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  },
  period?: number
): QuestionTemplate => {
  const statType = asString(template.resolutionContext?.statType) ?? 'POINTS'
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: BoxScorePlayer[] = []
  const homePlayers = homeTeam?.players
  const awayPlayers = awayTeam?.players
  if (Array.isArray(homePlayers)) players.push(...homePlayers)
  if (Array.isArray(awayPlayers)) players.push(...awayPlayers)
  const active = players.filter(
    (player) =>
      player?.isOnCourt === true ||
      String(player?.oncourt || '') === '1' ||
      String(player?.status || '').toUpperCase() === 'ACTIVE'
  )
  const pool = active.length ? active : players
  const filteredPool = excludeIds
    ? pool.filter((player) => {
        const id = getPlayerId(player)
        return id === null ? true : !excludeIds.has(id)
      })
    : pool
  const currentPeriod =
    period ??
    boxScore?.period ??
    boxScore?.game?.period ??
    boxScore?.gamePeriod ??
    1
  const candidatePool = seasonProfiles?.playersById
    ? filterPlayersBySeasonCandidate(
        filteredPool,
        seasonProfiles.playersById,
        statType
      )
    : filteredPool
  const byStat = new Map<number, BoxScorePlayer[]>()
  for (const player of candidatePool) {
    const stat = getPlayerCurrentStat(player, currentPeriod, statType)
    if (!Number.isFinite(stat)) continue
    const key = Number(stat)
    const list = byStat.get(key) ?? []
    list.push(player)
    byStat.set(key, list)
  }
  const tiedGroups = Array.from(byStat.entries())
    .filter(([, list]) => list.length >= 2)
    .map(([value, list]) => ({ value, list }))
  if (!tiedGroups.length) {
    return {
      ...template,
      resolutionContext: {
        ...(template.resolutionContext ?? {}),
        invalid: true,
      },
    }
  }
  const group = tiedGroups[Math.floor(Math.random() * tiedGroups.length)]
  const shuffled = [...group.list].sort(() => Math.random() - 0.5)
  const picked = shuffled.slice(0, 4)
  if (picked.length < 2) {
    return {
      ...template,
      resolutionContext: {
        ...(template.resolutionContext ?? {}),
        invalid: true,
      },
    }
  }
  const choices = picked
    .map((player) => {
      const id = getPlayerId(player)
      const name =
        typeof player?.name === 'string'
          ? player.name
          : typeof player?.firstName === 'string' &&
              typeof player?.lastName === 'string'
            ? `${player.firstName} ${player.lastName}`
            : null
      if (!id || !name) return null
      return { id: String(id), value: name }
    })
    .filter(Boolean) as { id: string; value: string }[]
  if (choices.length < 2) {
    return {
      ...template,
      resolutionContext: {
        ...(template.resolutionContext ?? {}),
        invalid: true,
      },
    }
  }
  const playerIds = choices.map((choice) => Number(choice.id))
  return {
    ...template,
    resolutionContext: {
      ...(template.resolutionContext ?? {}),
      playerIds,
      choices,
      tiedStatValue: group.value,
    },
  }
}

const MULTI_CHOICE_TEMPLATE_IDS = new Set([
  'GAME_WINNER',
  'JUMP_BALL_WINNER',
  'PERIOD_LEADER',
  'PERIOD_LEADER_END',
  'PERIOD_TEAM_COMPARE_THREES',
  'PERIOD_TEAM_COMPARE_POINTS',
  'PERIOD_TEAM_COMPARE_ASSISTS',
  'PERIOD_TEAM_COMPARE_REBOUNDS',
  'PERIOD_TEAM_COMPARE_STEALS',
  'PERIOD_PLAYER_COMPARE_POINTS',
  'PERIOD_PLAYER_COMPARE_ASSISTS',
  'PERIOD_PLAYER_COMPARE_REBOUNDS',
  'PERIOD_PLAYER_COMPARE_STEALS',
  'PERIOD_PLAYER_COMPARE_THREES',
  'TIMEOUT_NEXT_SCORE_TEAM',
  'TIMEOUT_NAIL_BITER_WINNER',
  'NEXT_DUNK_TEAM',
  'NEXT_DUNK_PLAYER',
  'NEXT_N_PLAYER_COMPARE_POINTS',
  'NEXT_N_PLAYER_COMPARE_ASSISTS',
  'NEXT_N_PLAYER_COMPARE_REBOUNDS',
  'NEXT_N_PLAYER_COMPARE_BLOCKS',
  'NEXT_N_PLAYER_COMPARE_THREES',
])

const COMPARE_TEMPLATE_IDS = new Set([
  'PERIOD_LEADER',
  'PERIOD_LEADER_END',
  'PERIOD_TEAM_COMPARE_THREES',
  'PERIOD_TEAM_COMPARE_POINTS',
  'PERIOD_TEAM_COMPARE_ASSISTS',
  'PERIOD_TEAM_COMPARE_REBOUNDS',
  'PERIOD_TEAM_COMPARE_STEALS',
  'PERIOD_PLAYER_COMPARE_POINTS',
  'PERIOD_PLAYER_COMPARE_ASSISTS',
  'PERIOD_PLAYER_COMPARE_REBOUNDS',
  'PERIOD_PLAYER_COMPARE_STEALS',
  'PERIOD_PLAYER_COMPARE_THREES',
  'NEXT_N_PLAYER_COMPARE_POINTS',
  'NEXT_N_PLAYER_COMPARE_ASSISTS',
  'NEXT_N_PLAYER_COMPARE_REBOUNDS',
  'NEXT_N_PLAYER_COMPARE_BLOCKS',
  'NEXT_N_PLAYER_COMPARE_THREES',
])

type SignedQuestionPayload = {
  version: number
  gameId: string
  questionId: string
  question: string
  choices: { id: string; value: string }[]
  timeoutAt: number
  engineTag: string
  engineVersion: string
  windowType: QuestionWindowType
  resolutionWindowMs: number | null
  resolutionContext: ResolutionContext | null
}

const buildSignedQuestionPayload = (payload: SignedQuestionPayload) => {
  if (!QUESTION_SIGNATURE_SECRET) {
    throw new Error('Missing WHISTLE_JWT_SECRET')
  }
  const payloadString = JSON.stringify(payload)
  const signature = createHmac('sha256', QUESTION_SIGNATURE_SECRET)
    .update(payloadString)
    .digest('hex')
  return { payloadString, signature }
}

const buildTeamTitle = (question: EngineQuestionPayload): string => {
  const home = asString(question.resolutionContext?.homeTricode)
  const away = asString(question.resolutionContext?.awayTricode)
  if (home && away) return `${home} vs ${away}`
  return 'New Question'
}

export const buildQuestionChoices = (
  question: EngineQuestionPayload
): { id: string; value: string }[] => {
  const choices = asChoiceArray(question.resolutionContext?.choices)
  if (choices) return choices
  if (MULTI_CHOICE_TEMPLATE_IDS.has(question.templateId)) {
    const home = asString(question.resolutionContext?.homeTricode) ?? 'HOME'
    const away = asString(question.resolutionContext?.awayTricode) ?? 'AWAY'
    return [
      { id: String(home), value: String(home) },
      { id: String(away), value: String(away) },
    ]
  }
  return [
    { id: 'yes', value: 'Yes' },
    { id: 'no', value: 'No' },
  ]
}

const createAndSendEngineQuestion = async (
  gameId: string,
  question: EngineQuestionPayload
): Promise<void> => {
  const { admin, db } = await import('../firebase')
  const isDev = process.env.NODE_ENV !== 'production'
  const now = Date.now()
  const timeoutAt = now + question.timeoutMs
  const choices = buildQuestionChoices(question)
  const type = MULTI_CHOICE_TEMPLATE_IDS.has(question.templateId)
    ? 'MULTIPLE_CHOICE'
    : 'YESNO'

  const questionPayload = {
    question: question.question,
    choices,
    type,
    state: 'open',
    timeoutAt,
    engineTag: question.templateId,
    engineVersion: ENGINE_VERSION,
    windowType: question.windowType,
    resolutionWindowMs: question.resolutionWindowMs ?? null,
    resolutionContext: question.resolutionContext ?? null,
    selectionReason: question.selectionReason ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
  }

  const qRef = await db
    .collection('games')
    .doc(gameId)
    .collection('questions')
    .add(questionPayload)

  const dimensions = deriveQuestionDimensions({
    templateId: question.templateId,
    trigger: question.trigger,
    windowType: question.windowType,
    questionText: question.question,
    choices,
  })

  try {
    const gameSnap = await db.collection('games').doc(gameId).get()
    const gameData = gameSnap.exists
      ? (gameSnap.data() as { league?: string })
      : null
    const league = gameData?.league || 'NBA'
    trackEvent(
      'question_created',
      buildQuestionCreatedProps({
        gameId,
        league,
        questionId: qRef.id,
        expectedResolutionTimeMs: timeoutAt,
        dimensions,
      })
    )
  } catch (error) {
    console.error(
      `[engine] analytics question_created failed game=${gameId} question=${qRef.id}`,
      error
    )
  }

  const baseQuestionPayload = {
    version: QUESTION_PAYLOAD_VERSION,
    gameId,
    questionId: qRef.id,
    question: question.question,
    choices,
    timeoutAt,
    engineTag: question.templateId,
    engineVersion: ENGINE_VERSION,
    windowType: question.windowType,
    resolutionWindowMs: question.resolutionWindowMs ?? null,
    resolutionContext: question.resolutionContext ?? null,
  }
  const { payloadString, signature } =
    buildSignedQuestionPayload(baseQuestionPayload)

  const topic = `game_${gameId}`
  const collapseId = topic
  const baseTitle = buildTeamTitle(question)
  const title = isDev ? `[DEV] ${baseTitle}` : baseTitle
  const message = {
    topic,
    data: {
      type: 'question',
      gameId,
      questionId: qRef.id,
      question: question.question,
      title,
      sentAt: now.toString(),
      engineTag: question.templateId,
      engineVersion: ENGINE_VERSION,
      collapseId,
      choices: JSON.stringify(choices),
      timeoutAt: String(timeoutAt),
      questionPayload: payloadString,
      questionSignature: signature,
    },
    android: {
      priority: 'high' as const,
      ttl: 10,
      collapseKey: collapseId,
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title,
            body: question.question,
          },
          category: 'question',
          sound: 'whistle.wav',
          'mutable-content': 1,
        },
      },
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': collapseId,
        'apns-expiration': Math.floor((now + 30_000) / 1000).toString(),
      },
    },
  }

  await admin.messaging().send(message as Message)

  try {
    const usersSnap = await db
      .collection('games')
      .doc(gameId)
      .collection('users')
      .get()
    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id
      trackEvent(
        'question_sent',
        buildQuestionSentProps({
          questionId: qRef.id,
          userId,
          gameId,
          sendTimestampMs: now,
          dimensions,
        }),
        userId
      )
    }
  } catch (error) {
    console.error(
      `[engine] analytics question_sent failed game=${gameId} question=${qRef.id}`,
      error
    )
  }
}

type GroupScope = 'PERIOD' | 'HALF' | 'GAME'

const QUESTION_GROUPS: Record<string, { name: string; scope: GroupScope }> = {
  NEXT_5_MIN_TOTAL_POINTS: { name: 'SCORING_WINDOW', scope: 'HALF' },
  NEXT_5_MIN_TEAM_POINTS: { name: 'SCORING_WINDOW', scope: 'HALF' },
  NEXT_5_MIN_TWO_THREES: { name: 'SCORING_WINDOW', scope: 'HALF' },
  REST_QUARTER_TEAM_POINTS: { name: 'SCORING_WINDOW', scope: 'HALF' },
  REST_QUARTER_BOTH_10: { name: 'SCORING_WINDOW', scope: 'HALF' },
  LEAD_CHANGE_FINAL_4: { name: 'LEAD_CHANGE', scope: 'GAME' },
  OVERTIME_YES_NO: { name: 'OVERTIME', scope: 'GAME' },
  PERIOD_TEAM_POINTS: { name: 'TEAM_POINTS', scope: 'PERIOD' },
  PERIOD_ANY_3: { name: 'THREE_COUNT', scope: 'PERIOD' },
  PERIOD_LEADER: { name: 'PERIOD_LEADER', scope: 'PERIOD' },
  PERIOD_LEADER_END: { name: 'PERIOD_LEADER', scope: 'PERIOD' },
  TIMEOUT_TEAM_SCORE_AFTER: { name: 'TIMEOUT_TEAM_SCORE', scope: 'PERIOD' },
  TIMEOUT_FIRST_PLAY: { name: 'TIMEOUT_FIRST_PLAY', scope: 'PERIOD' },
  FOUL_TEAM_SCORE_AFTER_FT: { name: 'FOUL_TEAM_SCORE', scope: 'PERIOD' },
  FOUL_FIRST_PLAY_AFTER_FT: { name: 'FOUL_FIRST_PLAY', scope: 'PERIOD' },
  PERIOD_TEAM_REBOUNDS: { name: 'TEAM_REBOUNDS', scope: 'PERIOD' },
  PERIOD_TEAM_ASSISTS: { name: 'TEAM_ASSISTS', scope: 'PERIOD' },
  PERIOD_TEAM_STEALS: { name: 'TEAM_STEALS', scope: 'PERIOD' },
  PERIOD_TEAM_THREES: { name: 'TEAM_THREES', scope: 'PERIOD' },
  PERIOD_TEAM_COMPARE_THREES: { name: 'TEAM_THREES_COMPARE', scope: 'PERIOD' },
  PERIOD_TEAM_COMPARE_POINTS: { name: 'TEAM_POINTS_COMPARE', scope: 'PERIOD' },
  PERIOD_TEAM_COMPARE_ASSISTS: {
    name: 'TEAM_ASSISTS_COMPARE',
    scope: 'PERIOD',
  },
  PERIOD_TEAM_COMPARE_REBOUNDS: {
    name: 'TEAM_REBOUNDS_COMPARE',
    scope: 'PERIOD',
  },
  PERIOD_TEAM_COMPARE_STEALS: { name: 'TEAM_STEALS_COMPARE', scope: 'PERIOD' },
  PERIOD_PLAYER_MILESTONE: { name: 'PLAYER_POINTS', scope: 'PERIOD' },
  PERIOD_PLAYER_ASSISTS: { name: 'PLAYER_ASSISTS', scope: 'PERIOD' },
  PERIOD_PLAYER_REBOUNDS: { name: 'PLAYER_REBOUNDS', scope: 'PERIOD' },
  PERIOD_PLAYER_STEALS: { name: 'PLAYER_STEALS', scope: 'PERIOD' },
  PERIOD_PLAYER_ANOTHER_THREE: { name: 'PLAYER_THREES', scope: 'PERIOD' },
  PERIOD_PLAYER_ANOTHER_STEAL: { name: 'PLAYER_STEALS', scope: 'PERIOD' },
  PERIOD_BEHIND_TEAM_TAKES_LEAD: { name: 'PERIOD_LEADER', scope: 'PERIOD' },
  PERIOD_LEADER_RETAINS: { name: 'PERIOD_LEADER', scope: 'PERIOD' },
  PERIOD_PLAYER_COMPARE_POINTS: {
    name: 'PLAYER_COMPARE_POINTS',
    scope: 'PERIOD',
  },
  PERIOD_PLAYER_COMPARE_ASSISTS: {
    name: 'PLAYER_COMPARE_ASSISTS',
    scope: 'PERIOD',
  },
  PERIOD_PLAYER_COMPARE_REBOUNDS: {
    name: 'PLAYER_COMPARE_REBOUNDS',
    scope: 'PERIOD',
  },
  PERIOD_PLAYER_COMPARE_STEALS: {
    name: 'PLAYER_COMPARE_STEALS',
    scope: 'PERIOD',
  },
  PERIOD_PLAYER_COMPARE_THREES: {
    name: 'PLAYER_COMPARE_THREES',
    scope: 'PERIOD',
  },
  NEXT_N_PLAYER_COMPARE_POINTS: {
    name: 'PLAYER_COMPARE_POINTS',
    scope: 'PERIOD',
  },
  NEXT_N_PLAYER_COMPARE_ASSISTS: {
    name: 'PLAYER_COMPARE_ASSISTS',
    scope: 'PERIOD',
  },
  NEXT_N_PLAYER_COMPARE_REBOUNDS: {
    name: 'PLAYER_COMPARE_REBOUNDS',
    scope: 'PERIOD',
  },
  NEXT_N_PLAYER_COMPARE_BLOCKS: {
    name: 'PLAYER_COMPARE_BLOCKS',
    scope: 'PERIOD',
  },
  NEXT_N_PLAYER_COMPARE_THREES: {
    name: 'PLAYER_COMPARE_THREES',
    scope: 'PERIOD',
  },
  PERIOD_PLAYER_THREE_STREAK: { name: 'PLAYER_THREE_STREAK', scope: 'PERIOD' },
  PERIOD_PLAYER_FG_STREAK: { name: 'PLAYER_FG_STREAK', scope: 'PERIOD' },
  PERIOD_TEAM_THREE_STREAK: { name: 'TEAM_THREE_STREAK', scope: 'PERIOD' },
  TIMEOUT_NEXT_SCORE_TEAM: { name: 'NEXT_SCORE_TEAM', scope: 'PERIOD' },
  TIMEOUT_BUZZER_BEATER: { name: 'TIMEOUT_BUZZER', scope: 'PERIOD' },
  TIMEOUT_NAIL_BITER_WINNER: { name: 'TIMEOUT_NAIL_BITER', scope: 'GAME' },
  TIMEOUT_NAIL_BITER_RETAIN: { name: 'TIMEOUT_NAIL_BITER', scope: 'GAME' },
  TIMEOUT_NAIL_BITER_TAKE: { name: 'TIMEOUT_NAIL_BITER', scope: 'GAME' },
  NEXT_DUNK_TEAM: { name: 'NEXT_DUNK', scope: 'PERIOD' },
  NEXT_DUNK_PLAYER: { name: 'NEXT_DUNK', scope: 'PERIOD' },
}

const getHalf = (period: number): number => (period <= 2 ? 1 : 2)

const hasGroup = (
  gameId: string,
  period: number,
  group: { name: string; scope: GroupScope } | undefined
): boolean => {
  if (!group) return false
  if (group.scope === 'GAME') {
    return GAME_GROUPS_BY_GAME.get(gameId)?.has(group.name) ?? false
  }
  if (group.scope === 'HALF') {
    const half = getHalf(period)
    return HALF_GROUPS_BY_GAME.get(gameId)?.get(half)?.has(group.name) ?? false
  }
  const periodGroups = PERIOD_GROUPS_BY_GAME.get(gameId)?.get(period)
  return periodGroups ? periodGroups.has(group.name) : false
}

const markGroup = (
  gameId: string,
  period: number,
  group: { name: string; scope: GroupScope } | undefined
): void => {
  if (!group) return
  if (group.scope === 'GAME') {
    const set = GAME_GROUPS_BY_GAME.get(gameId) ?? new Set<string>()
    set.add(group.name)
    GAME_GROUPS_BY_GAME.set(gameId, set)
    return
  }
  if (group.scope === 'HALF') {
    const half = getHalf(period)
    let gameHalves = HALF_GROUPS_BY_GAME.get(gameId)
    if (!gameHalves) {
      gameHalves = new Map()
      HALF_GROUPS_BY_GAME.set(gameId, gameHalves)
    }
    let halfGroups = gameHalves.get(half)
    if (!halfGroups) {
      halfGroups = new Set()
      gameHalves.set(half, halfGroups)
    }
    halfGroups.add(group.name)
    return
  }
  let gamePeriods = PERIOD_GROUPS_BY_GAME.get(gameId)
  if (!gamePeriods) {
    gamePeriods = new Map()
    PERIOD_GROUPS_BY_GAME.set(gameId, gamePeriods)
  }
  let periodGroups = gamePeriods.get(period)
  if (!periodGroups) {
    periodGroups = new Set()
    gamePeriods.set(period, periodGroups)
  }
  periodGroups.add(group.name)
}

const getUsedPlayerIds = (gameId: string): Set<number> => {
  const players = PLAYER_USAGE_BY_GAME.get(gameId)
  return players ? new Set(players.keys()) : new Set()
}

const markPlayerAsked = (
  gameId: string,
  period: number,
  clockMs: number,
  playerId: number | null
): void => {
  if (!playerId) return
  let players = PLAYER_USAGE_BY_GAME.get(gameId)
  if (!players) {
    players = new Map()
    PLAYER_USAGE_BY_GAME.set(gameId, players)
  }
  players.set(playerId, {
    period,
    clockMs,
    askedAt: Date.now(),
  })
}

const TIMEOUT_TEMPLATES: QuestionTemplate[] = []

const FOUL_TEMPLATES: QuestionTemplate[] = []

const PERIOD_START_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_TEAM_POINTS',
    text: 'Will the home team score 25+ this quarter?',
    weight: 1,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'TEAM_POINTS_THIS_PERIOD',
      target: 25,
      team: 'HOME',
    },
  },
  {
    id: 'PERIOD_ANY_3',
    text: 'Will there be 8+ made 3-pointers this quarter?',
    weight: 1,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'THREE_COUNT_THIS_PERIOD', target: 8 },
  },
  {
    id: 'PERIOD_LEADER',
    text: 'Who will lead at the end of the quarter?',
    weight: 1,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'LEADER_END_OF_PERIOD' },
  },
  {
    id: 'PERIOD_LEADER_END',
    text: 'Who will be leading at the end of this period?',
    weight: 1,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'LEADER_END_OF_PERIOD' },
  },
  {
    id: 'PERIOD_TEAM_REBOUNDS',
    text: 'Will the home team record 12+ rebounds this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'TEAM_STAT_THIS_PERIOD',
      target: 12,
      team: 'HOME',
      statType: 'REBOUNDS',
    },
  },
  {
    id: 'PERIOD_TEAM_ASSISTS',
    text: 'Will the home team record 8+ assists this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'TEAM_STAT_THIS_PERIOD',
      target: 8,
      team: 'HOME',
      statType: 'ASSISTS',
    },
  },
  {
    id: 'PERIOD_TEAM_STEALS',
    text: 'Will the home team record 4+ steals this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'TEAM_STAT_THIS_PERIOD',
      target: 4,
      team: 'HOME',
      statType: 'STEALS',
    },
  },
  {
    id: 'PERIOD_TEAM_THREES',
    text: 'Will the home team record 4+ 3-pointers this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'TEAM_STAT_THIS_PERIOD',
      target: 4,
      team: 'HOME',
      statType: 'THREES',
    },
  },
  {
    id: 'PERIOD_TEAM_COMPARE_THREES',
    text: 'Which team will score more 3s this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_COMPARE_PERIOD', statType: 'THREES' },
  },
  {
    id: 'PERIOD_TEAM_COMPARE_POINTS',
    text: 'Which team will score more points this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_COMPARE_PERIOD', statType: 'POINTS' },
  },
  {
    id: 'PERIOD_TEAM_COMPARE_ASSISTS',
    text: 'Which team will record more assists this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_COMPARE_PERIOD', statType: 'ASSISTS' },
  },
  {
    id: 'PERIOD_TEAM_COMPARE_REBOUNDS',
    text: 'Which team will record more rebounds this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_COMPARE_PERIOD', statType: 'REBOUNDS' },
  },
  {
    id: 'PERIOD_TEAM_COMPARE_STEALS',
    text: 'Which team will record more steals this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_COMPARE_PERIOD', statType: 'STEALS' },
  },
]

const PERIOD_START_TEAM_TEMPLATES = PERIOD_START_TEMPLATES.filter((template) =>
  template.id.startsWith('PERIOD_TEAM_')
)

const PERIOD_START_CLOSE_MARGIN_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_BEHIND_TEAM_TAKES_LEAD',
    text: 'Will team behind take the lead this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'LEADER_END_OF_PERIOD', requiresTrailing: true },
  },
  {
    id: 'PERIOD_LEADER_RETAINS',
    text: 'Will leading team retain the lead this quarter?',
    weight: 2,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'LEADER_END_OF_PERIOD', requiresLeading: true },
  },
]

const PLAYER_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_PLAYER_MILESTONE',
    text: 'Will a player reach 10+ points in the rest of this quarter?',
    weight: 8,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      target: 10,
      statType: 'POINTS',
    },
  },
  {
    id: 'PERIOD_PLAYER_ASSISTS',
    text: 'Will a player record 3+ assists in the rest of this quarter?',
    weight: 7,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      target: 3,
      statType: 'ASSISTS',
    },
  },
  {
    id: 'PERIOD_PLAYER_REBOUNDS',
    text: 'Will a player record 4+ rebounds in the rest of this quarter?',
    weight: 7,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      target: 4,
      statType: 'REBOUNDS',
    },
  },
  {
    id: 'PERIOD_PLAYER_STEALS',
    text: 'Will a player record 2+ steals in the rest of this quarter?',
    weight: 6,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      target: 2,
      statType: 'STEALS',
    },
  },
]

const LATE_PERIOD_PLAYER_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_PLAYER_ANOTHER_THREE',
    text: 'Will a player hit another 3-pointer in the rest of this quarter?',
    weight: 6,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      statType: 'THREES',
      increment: 1,
      requiresCurrent: true,
    },
  },
  {
    id: 'PERIOD_PLAYER_ANOTHER_STEAL',
    text: 'Will a player get another steal in the rest of this quarter?',
    weight: 5,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: {
      type: 'PLAYER_MILESTONE_PERIOD',
      statType: 'STEALS',
      increment: 1,
      requiresCurrent: true,
    },
  },
  // Intentionally omit free throw questions (too low-signal).
]

const PLAYER_COMPARE_PERIOD_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_PLAYER_COMPARE_POINTS',
    text: 'Who will score the most points this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'PLAYER_COMPARE_PERIOD', statType: 'POINTS' },
  },
  {
    id: 'PERIOD_PLAYER_COMPARE_ASSISTS',
    text: 'Who will record the most assists this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'PLAYER_COMPARE_PERIOD', statType: 'ASSISTS' },
  },
  {
    id: 'PERIOD_PLAYER_COMPARE_REBOUNDS',
    text: 'Who will record the most rebounds this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'PLAYER_COMPARE_PERIOD', statType: 'REBOUNDS' },
  },
  {
    id: 'PERIOD_PLAYER_COMPARE_STEALS',
    text: 'Who will record the most steals this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'PLAYER_COMPARE_PERIOD', statType: 'STEALS' },
  },
  {
    id: 'PERIOD_PLAYER_COMPARE_THREES',
    text: 'Who will hit the most 3-pointers this quarter?',
    weight: 3,
    windowType: 'PERIOD',
    resolutionWindowMs: null,
    resolutionContext: { type: 'PLAYER_COMPARE_PERIOD', statType: 'THREES' },
  },
]

const weightedPick = <T extends { weight: number }>(items: T[]): T | null => {
  if (!items.length) return null
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  const roll = Math.random() * total
  let cursor = 0
  for (const item of items) {
    cursor += item.weight
    if (roll <= cursor) return item
  }
  return items[items.length - 1]
}

const shouldAskQuestion = (probability: number): boolean =>
  Math.random() < probability

const SHOT_ATTEMPT_EVENT_TYPES = new Set([
  EventType.MADE_FG,
  EventType.MISSED_FG,
  EventType.MADE_3,
  EventType.MISSED_3,
])
const THREE_ATTEMPT_EVENT_TYPES = new Set([
  EventType.MADE_3,
  EventType.MISSED_3,
])
const SCORING_EVENT_TYPES = new Set([
  EventType.MADE_FG,
  EventType.MADE_3,
  EventType.MADE_FT,
])

const hasRecentTeamShotAttempt = (
  gameId: string,
  teamTricode: string | null,
  nowMs: number
): boolean => {
  if (!teamTricode) return true
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      item.teamTricode &&
      normalizeTricode(item.teamTricode) === normalizeTricode(teamTricode) &&
      SHOT_ATTEMPT_EVENT_TYPES.has(item.type) &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentPlayerShotAttempt = (
  gameId: string,
  playerId: number,
  nowMs: number
): boolean => {
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      item.playerId === playerId &&
      SHOT_ATTEMPT_EVENT_TYPES.has(item.type) &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentTeamThreeAttempt = (
  gameId: string,
  teamTricode: string | null,
  nowMs: number
): boolean => {
  if (!teamTricode) return true
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      item.teamTricode &&
      normalizeTricode(item.teamTricode) === normalizeTricode(teamTricode) &&
      THREE_ATTEMPT_EVENT_TYPES.has(item.type) &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentPlayerThreeAttempt = (
  gameId: string,
  playerId: number,
  nowMs: number
): boolean => {
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      item.playerId === playerId &&
      THREE_ATTEMPT_EVENT_TYPES.has(item.type) &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentScore = (gameId: string, nowMs: number): boolean => {
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      SCORING_EVENT_TYPES.has(item.type) &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentTransition = (gameId: string, nowMs: number): boolean => {
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      (item.type === EventType.STEAL || item.type === EventType.TURNOVER) &&
      nowMs - item.timeMs <= 30_000 &&
      nowMs >= item.timeMs
  )
}

const hasRecentDunk = (gameId: string, nowMs: number): boolean => {
  const recent = RECENT_EVENTS_BY_GAME.get(gameId) ?? []
  return recent.some(
    (item) =>
      item.subType === NbaEventSubType.DUNK &&
      nowMs - item.timeMs <= 60_000 &&
      nowMs >= item.timeMs
  )
}

const getFouledPlayerId = (event: EngineEvent): number | null => {
  const secondary = event.context?.secondaryPlayerIds
  if (Array.isArray(secondary) && secondary.length) return secondary[0] ?? null
  return (
    event.context?.shot?.shooterId ??
    event.context?.freeThrow?.shooterId ??
    event.context?.primaryPlayerId ??
    null
  )
}

const getPossessionTricode = (
  event: EngineEvent,
  boxScore: BoxScore | null
): string | null => {
  const possession = event.gameState?.possession
  if (!possession) return normalizeTricode(getEventTeamTricode(event))
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  if (typeof possession === 'number') {
    if (homeTeam?.teamId === possession)
      return normalizeTricode(homeTeam?.teamTricode)
    if (awayTeam?.teamId === possession)
      return normalizeTricode(awayTeam?.teamTricode)
  }
  const asNumber = Number(possession)
  if (Number.isFinite(asNumber)) {
    if (homeTeam?.teamId === asNumber)
      return normalizeTricode(homeTeam?.teamTricode)
    if (awayTeam?.teamId === asNumber)
      return normalizeTricode(awayTeam?.teamTricode)
  }
  if (typeof possession === 'string' && possession.length <= 4) {
    return normalizeTricode(possession)
  }
  return normalizeTricode(getEventTeamTricode(event))
}

const getOpponentTricode = (
  event: EngineEvent,
  boxScore: BoxScore | null
): string | null => {
  const teamTricode = normalizeTricode(getEventTeamTricode(event))
  if (!teamTricode) return null
  const teamSide = resolveTeamSideByTricode(boxScore, teamTricode)
  if (!teamSide) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  return teamSide === 'HOME'
    ? normalizeTricode(awayTeam?.teamTricode)
    : normalizeTricode(homeTeam?.teamTricode)
}

const buildTimeoutTemplates = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  opts?: TriggerOptions,
  gameId?: string
): QuestionTemplate[] => {
  const isLongTimeout = event.subType === NbaEventSubType.FULL
  const clockMs = event.gameState?.clockMs ?? null
  const timeoutTricode = normalizeTricode(getEventTeamTricode(event))
  if (clockMs !== null && clockMs <= 5 * 1000 && timeoutTricode) {
    return [
      {
        id: 'TIMEOUT_BUZZER_BEATER',
        text: `Will ${timeoutTricode} hit a buzzer beater?`,
        weight: 3,
        windowType: 'PERIOD',
        resolutionWindowMs: null,
        resolutionContext: {
          type: 'BUZZER_BEATER_TIMEOUT',
          teamTricode: timeoutTricode,
        },
      },
    ]
  }
  if (clockMs !== null && clockMs <= 30 * 1000) {
    const margin = getScoreMargin(event)
    const period = event.gameState?.period ?? 0
    if (margin !== null && margin <= 3 && period >= 4) {
      const { leader, leaderTricode } = getLeader(event)
      const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
      const homeTricode = normalizeTricode(homeTeam?.teamTricode)
      const awayTricode = normalizeTricode(awayTeam?.teamTricode)
      const trailingTricode =
        leader === 'HOME' ? awayTricode : leader === 'AWAY' ? homeTricode : null
      const templates: QuestionTemplate[] = [
        {
          id: 'TIMEOUT_NAIL_BITER_WINNER',
          text: 'This is a nail biter! Which team will win?',
          weight: 2,
          windowType: 'GAME',
          resolutionWindowMs: null,
          resolutionContext: {
            type: 'GAME_WINNER',
          },
        },
      ]
      if (leader !== 'TIE' && leaderTricode) {
        templates.push({
          id: 'TIMEOUT_NAIL_BITER_RETAIN',
          text: `This is a nail biter! Will ${leaderTricode} retain the lead and win?`,
          weight: 2,
          windowType: 'GAME',
          resolutionWindowMs: null,
          resolutionContext: {
            type: 'TEAM_WINS_GAME',
            teamTricode: leaderTricode,
          },
        })
      }
      if (trailingTricode) {
        templates.push({
          id: 'TIMEOUT_NAIL_BITER_TAKE',
          text: `This is a nail biter! Will ${trailingTricode} take the lead and win?`,
          weight: 2,
          windowType: 'GAME',
          resolutionWindowMs: null,
          resolutionContext: {
            type: 'TEAM_WINS_GAME',
            teamTricode: trailingTricode,
          },
        })
      }
      return templates
    }
  }
  const timeActualMs = getEventTimeActualMs(event)
  const canUseRecent = !!timeActualMs && !!gameId
  if (isLongTimeout) {
    const templates: QuestionTemplate[] = []
    const possessionTricode = getPossessionTricode(event, boxScore)
    if (possessionTricode) {
      const canAskTeamScore = !canUseRecent
        ? true
        : !hasRecentTeamShotAttempt(gameId!, possessionTricode, timeActualMs!)
      if (canAskTeamScore) {
        templates.push({
          id: 'TIMEOUT_POSSESSION_TEAM_SCORE',
          text: `Will ${possessionTricode} score coming out of this timeout?`,
          weight: 2,
          windowType: 'NEXT_EVENT',
          resolutionWindowMs: 90_000,
          resolutionContext: {
            type: 'TEAM_SCORE_AFTER_TIMEOUT',
            teamTricode: possessionTricode,
          },
        })
      }
      if (canAskTeamScore) {
        templates.push({
          id: 'TIMEOUT_POSSESSION_TEAM_NEXT_THREE',
          text: `Will ${possessionTricode} hit a 3 coming out of this timeout?`,
          weight: 1,
          windowType: 'NEXT_EVENT',
          resolutionWindowMs: 90_000,
          resolutionContext: {
            type: 'NEXT_EVENT',
            expectedEventType: 'MADE_3',
            teamTricode: possessionTricode,
          },
        })
      }
    }
    const canAskNextScore = !canUseRecent
      ? true
      : !hasRecentScore(gameId!, timeActualMs!)
    if (canAskNextScore) {
      templates.push({
        id: 'TIMEOUT_NEXT_SCORE_TEAM',
        text: 'Which team will score next?',
        weight: 1,
        windowType: 'NEXT_EVENT',
        resolutionWindowMs: 90_000,
        resolutionContext: {
          type: 'NEXT_SCORE_TEAM',
        },
      })
    }
    if (canAskNextScore) {
      templates.push({
        id: 'TIMEOUT_NEXT_SHOT_THREE',
        text: 'Will the next shot be a 3?',
        weight: 1,
        windowType: 'NEXT_EVENT',
        resolutionWindowMs: 90_000,
        resolutionContext: {
          type: 'NEXT_EVENT',
          expectedEventType: 'ATTEMPT_3',
        },
      })
    }
    return templates
  }
  const opponentTricode = getOpponentTricode(event, boxScore)
  if (!opponentTricode) return []
  const shouldAskAttempt = !canUseRecent
    ? true
    : !hasRecentTeamShotAttempt(gameId!, opponentTricode, timeActualMs!)
  if (!shouldAskAttempt) return []
  return [
    {
      id: 'TIMEOUT_OPP_TEAM_NEXT_ATTEMPT',
      text: `Will ${opponentTricode} make their next shot?`,
      weight: 2,
      windowType: 'NEXT_EVENT',
      resolutionWindowMs: 90_000,
      resolutionContext: {
        type: 'NEXT_EVENT',
        expectedEventType: 'MADE_FG',
        teamTricode: opponentTricode,
      },
    },
  ]
}

const buildFoulTemplates = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  opts?: TriggerOptions,
  gameId?: string
): QuestionTemplate[] => {
  const timeActualMs = getEventTimeActualMs(event)
  if (!timeActualMs || !gameId) return []
  const opponentTricode = getOpponentTricode(event, boxScore)
  const templates: QuestionTemplate[] = []
  if (opponentTricode) {
    if (!hasRecentTeamShotAttempt(gameId, opponentTricode, timeActualMs)) {
      templates.push({
        id: 'FOUL_OPP_TEAM_NEXT_SHOT',
        text: `Will ${opponentTricode} make their next shot?`,
        weight: 2,
        windowType: 'NEXT_EVENT',
        resolutionWindowMs: 90_000,
        resolutionContext: {
          type: 'NEXT_EVENT',
          expectedEventType: 'MADE_FG',
          teamTricode: opponentTricode,
        },
      })
    }
    if (!hasRecentTeamThreeAttempt(gameId, opponentTricode, timeActualMs)) {
      templates.push({
        id: 'FOUL_OPP_TEAM_NEXT_THREE',
        text: `Will ${opponentTricode} hit their next 3?`,
        weight: 1,
        windowType: 'NEXT_EVENT',
        resolutionWindowMs: 90_000,
        resolutionContext: {
          type: 'NEXT_EVENT',
          expectedEventType: 'MADE_3',
          teamTricode: opponentTricode,
        },
      })
    }
  }
  if (opponentTricode) {
    const opponentPlayers = getTeamPlayersByTricode(boxScore, opponentTricode)
    const activeOpponents = opponentPlayers.filter(
      (player) =>
        player?.isOnCourt === true ||
        String(player?.oncourt || '') === '1' ||
        String(player?.status || '').toUpperCase() === 'ACTIVE'
    )
    const pool = activeOpponents.length ? activeOpponents : opponentPlayers
    const playersById = opts?.seasonProfiles?.playersById
    const scoringCandidates = playersById
      ? pool.filter((player) => {
          const id = getPlayerId(player)
          if (id === null) return false
          const profile = playersById.get(String(id))
          return !!profile?.isScoringCandidate
        })
      : pool
    const threeCandidates = playersById
      ? pool.filter((player) => {
          const id = getPlayerId(player)
          if (id === null) return false
          const profile = playersById.get(String(id))
          return !!profile?.isThreeCandidate
        })
      : pool
    const pickCandidate = (candidates: BoxScorePlayer[]) =>
      candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null
    const scoringChoice = pickCandidate(scoringCandidates)
    const threeChoice = pickCandidate(threeCandidates)
    const scoringId = getPlayerId(scoringChoice)
    const threeId = getPlayerId(threeChoice)
    if (
      scoringId !== null &&
      !hasRecentPlayerShotAttempt(gameId, scoringId, timeActualMs)
    ) {
      const playerName = getPlayerNameFromBoxScore(boxScore, scoringId)
      if (playerName) {
        templates.push({
          id: 'FOUL_OPP_PLAYER_NEXT_SHOT',
          text: `Will ${playerName} hit their next shot?`,
          weight: 1,
          windowType: 'NEXT_EVENT',
          resolutionWindowMs: 90_000,
          resolutionContext: {
            type: 'NEXT_EVENT',
            expectedEventType: 'MADE_FG',
            playerId: scoringId,
            teamTricode: opponentTricode,
            cancelOnGameEnd: true,
          },
        })
      }
    }
    if (
      threeId !== null &&
      !hasRecentPlayerThreeAttempt(gameId, threeId, timeActualMs)
    ) {
      const playerName = getPlayerNameFromBoxScore(boxScore, threeId)
      if (playerName) {
        templates.push({
          id: 'FOUL_OPP_PLAYER_NEXT_THREE',
          text: `Will ${playerName} hit their next 3?`,
          weight: 1,
          windowType: 'NEXT_EVENT',
          resolutionWindowMs: 90_000,
          resolutionContext: {
            type: 'NEXT_EVENT',
            expectedEventType: 'MADE_3',
            playerId: threeId,
            teamTricode: opponentTricode,
            cancelOnGameEnd: true,
          },
        })
      }
    }
  }
  return templates
}

const buildDunkTemplates = (
  gameId: string,
  event: EngineEvent,
  boxScore: BoxScore | null,
  opts?: TriggerOptions
): QuestionTemplate[] => {
  const clockMs = event.gameState?.clockMs ?? 0
  if (clockMs > 9 * 60 * 1000 || clockMs < 3 * 60 * 1000) return []
  const timeActualMs = getEventTimeActualMs(event)
  if (!timeActualMs) return []
  if (hasRecentDunk(gameId, timeActualMs)) return []
  if (hasRecentTransition(gameId, timeActualMs)) return []
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  if (!homeTeam?.teamTricode || !awayTeam?.teamTricode) return []
  const templates: QuestionTemplate[] = [
    {
      id: 'NEXT_DUNK_TEAM',
      text: 'Which team will have the next dunk?',
      weight: 1,
      windowType: 'NEXT_EVENT',
      resolutionWindowMs: DUNK_RESOLUTION_WINDOW_MS,
      resolutionContext: {
        type: 'NEXT_DUNK_TEAM',
      },
    },
  ]
  const players: BoxScorePlayer[] = []
  if (Array.isArray(homeTeam.players)) players.push(...homeTeam.players)
  if (Array.isArray(awayTeam.players)) players.push(...awayTeam.players)
  if (!players.length) return templates
  const active = players.filter(
    (player) =>
      player?.isOnCourt === true ||
      String(player?.oncourt || '') === '1' ||
      String(player?.status || '').toUpperCase() === 'ACTIVE'
  )
  const pool = active.length ? active : players
  const candidatePool = opts?.seasonProfiles?.playersById
    ? pool.filter((player) => {
        const id = getPlayerId(player)
        if (id === null) return false
        const profile = opts.seasonProfiles?.playersById.get(String(id))
        return !!profile?.isDunkCandidate
      })
    : pool
  const shuffled = [...candidatePool].sort(() => Math.random() - 0.5)
  const picked = shuffled.slice(0, 4)
  const choices = picked
    .map((player) => {
      const id = getPlayerId(player)
      const name =
        typeof player?.name === 'string'
          ? player.name
          : typeof player?.firstName === 'string' &&
              typeof player?.lastName === 'string'
            ? `${player.firstName} ${player.lastName}`
            : null
      if (!id || !name) return null
      return { id: String(id), value: name }
    })
    .filter(Boolean) as { id: string; value: string }[]
  if (choices.length < 2) return templates
  templates.push({
    id: 'NEXT_DUNK_PLAYER',
    text: 'Who will have the next dunk?',
    weight: 1,
    windowType: 'NEXT_EVENT',
    resolutionWindowMs: DUNK_RESOLUTION_WINDOW_MS,
    resolutionContext: {
      type: 'NEXT_DUNK_PLAYER',
      playerIds: choices.map((choice) => Number(choice.id)),
      choices,
    },
  })
  return templates
}

const isShootingFoulWithShots = (event: EngineEvent): boolean => {
  const desc = String(event.description || '').toLowerCase()
  const hasShots =
    desc.includes('2 shots') ||
    desc.includes('two shots') ||
    desc.includes('3 shots') ||
    desc.includes('three shots') ||
    desc.includes('2 ft') ||
    desc.includes('3 ft') ||
    desc.includes('2 free throw') ||
    desc.includes('3 free throw') ||
    desc.includes('two free throw') ||
    desc.includes('three free throw')
  const isShooting =
    event.subType === NbaEventSubType.SHOOTING || desc.includes('shooting')
  return isShooting && hasShots
}

const getPeriodWindow = (clockMs: number): PeriodWindow => {
  if (clockMs >= 9 * 60 * 1000) return 'EARLY'
  if (clockMs >= 5 * 60 * 1000) return 'MID'
  if (clockMs >= 2 * 60 * 1000) return 'LATE'
  return 'CLUTCH'
}

const computeResolutionWindowMs = (
  template: QuestionTemplate,
  event: EngineEvent
): number | null => {
  const clockMs = event.gameState?.clockMs ?? null
  if (template.windowType !== 'NEXT_N_MIN') return null
  if (clockMs === null) return null
  const windowMs = template.resolutionWindowMs ?? 0
  return Math.max(0, clockMs - windowMs)
}

const buildPeriodThreeTemplate = (
  template: QuestionTemplate
): QuestionTemplate => {
  const target = 8 + Math.floor(Math.random() * 5)
  return {
    ...template,
    text: `Will there be ${target}+ made 3-pointers this quarter?`,
    resolutionContext: {
      ...(template.resolutionContext ?? {}),
      target,
      type: 'THREE_COUNT_THIS_PERIOD',
    },
  }
}

const getBoxScoreTeams = (
  boxScore: BoxScore | null
): { homeTeam: BoxScoreTeam | null; awayTeam: BoxScoreTeam | null } => {
  const game = boxScore?.game
  return {
    homeTeam: game?.homeTeam ?? boxScore?.homeTeam ?? null,
    awayTeam: game?.awayTeam ?? boxScore?.awayTeam ?? null,
  }
}

const buildTeamStatTemplate = (
  template: QuestionTemplate,
  boxScore: BoxScore | null,
  seasonProfiles?: {
    teamsById: Map<string, TeamSeasonProfile>
  }
): QuestionTemplate => {
  const statType = asString(template.resolutionContext?.statType) ?? 'REBOUNDS'
  const team = pickFrom(['HOME', 'AWAY'] as const)
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const teamTricode =
    team === 'HOME'
      ? (homeTeam?.teamTricode ?? null)
      : (awayTeam?.teamTricode ?? null)
  const teamId =
    team === 'HOME' ? (homeTeam?.teamId ?? null) : (awayTeam?.teamId ?? null)
  const profile = teamId
    ? seasonProfiles?.teamsById.get(String(teamId))
    : undefined
  const avg =
    statType === 'ASSISTS'
      ? (profile?.apg ?? null)
      : statType === 'STEALS'
        ? (profile?.spg ?? null)
        : statType === 'THREES'
          ? (profile?.fg3m ?? null)
          : (profile?.rpg ?? null)
  const perQuarterTarget =
    typeof avg === 'number' && avg > 0 ? Math.max(1, Math.ceil(avg / 4)) : null
  const fallbackTarget =
    statType === 'ASSISTS'
      ? pickFrom([6, 8, 10])
      : statType === 'STEALS'
        ? pickFrom([3, 4, 5])
        : statType === 'THREES'
          ? pickFrom([3, 4, 5])
          : pickFrom([10, 12, 14])
  const target = perQuarterTarget ?? fallbackTarget
  const label =
    statType === 'ASSISTS'
      ? 'assists'
      : statType === 'STEALS'
        ? 'steals'
        : statType === 'THREES'
          ? '3-pointers'
          : 'rebounds'
  const resolutionContext = { ...(template.resolutionContext ?? {}) }
  delete (resolutionContext as { team?: string }).team
  return {
    ...template,
    text: `Will the ${team === 'HOME' ? 'home team' : 'away team'} record ${target}+ ${label} this quarter?`,
    resolutionContext: {
      ...resolutionContext,
      teamTricode: teamTricode ?? null,
      target,
    },
  }
}

const buildTeamPointsTemplate = (
  template: QuestionTemplate,
  boxScore: BoxScore | null,
  seasonProfiles?: {
    teamsById: Map<string, TeamSeasonProfile>
  }
): QuestionTemplate => {
  const team = asString(template.resolutionContext?.team) ?? 'HOME'
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const teamTricode =
    team === 'HOME'
      ? (homeTeam?.teamTricode ?? null)
      : (awayTeam?.teamTricode ?? null)
  const teamId =
    team === 'HOME' ? (homeTeam?.teamId ?? null) : (awayTeam?.teamId ?? null)
  const profile = teamId
    ? seasonProfiles?.teamsById.get(String(teamId))
    : undefined
  const avg = profile?.ppg ?? null
  const target =
    typeof avg === 'number' && avg > 0
      ? Math.max(1, Math.ceil(avg / 4))
      : (asNumber(template.resolutionContext?.target) ?? 25)
  const resolutionContext = { ...(template.resolutionContext ?? {}) }
  delete (resolutionContext as { team?: string }).team
  return {
    ...template,
    text: `Will the ${team === 'HOME' ? 'home team' : 'away team'} score ${target}+ this quarter?`,
    resolutionContext: {
      ...resolutionContext,
      target,
      teamTricode: teamTricode ?? null,
    },
  }
}

const buildPlayerMilestoneTemplate = (
  template: QuestionTemplate,
  boxScore: BoxScore | null,
  excludeIds?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  },
  period?: number,
  clockMs?: number | null
): QuestionTemplate => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: BoxScorePlayer[] = []
  const homePlayers = homeTeam?.players
  const awayPlayers = awayTeam?.players
  if (Array.isArray(homePlayers)) players.push(...homePlayers)
  if (Array.isArray(awayPlayers)) players.push(...awayPlayers)
  const active = players.filter(
    (player) =>
      player?.isOnCourt === true ||
      String(player?.oncourt || '') === '1' ||
      String(player?.status || '').toUpperCase() === 'ACTIVE'
  )
  const pool = active.length ? active : players
  const filteredPool = excludeIds
    ? pool.filter((player) => {
        const id = getPlayerId(player)
        return id === null ? true : !excludeIds.has(id)
      })
    : pool
  const statType = asString(template.resolutionContext?.statType) ?? 'POINTS'
  const currentPeriod =
    period ??
    boxScore?.period ??
    boxScore?.game?.period ??
    boxScore?.gamePeriod ??
    1
  const increment = asNumber(template.resolutionContext?.increment) ?? 0
  const requiresCurrent =
    asBoolean(template.resolutionContext?.requiresCurrent) === true
  const pickPool = filteredPool.filter((player) => {
    const id = getPlayerId(player)
    if (!id) return true
    const periodStat = getPlayerPeriodStat(player, currentPeriod, statType)
    if (periodStat === null) return !requiresCurrent
    if (requiresCurrent && periodStat < Math.max(1, increment)) return false
    if (increment > 0) return true
    const profile = seasonProfiles?.playersById.get(String(id))
    const targetInfo = getPlayerTargetInfo(
      profile,
      statType,
      currentPeriod,
      clockMs ?? null,
      periodStat
    )
    const target = targetInfo.target
    if (!target) return true
    return periodStat < Math.max(1, target - 1)
  })
  const candidatePool = seasonProfiles?.playersById
    ? filterPlayersBySeasonCandidate(
        pickPool,
        seasonProfiles.playersById,
        statType
      )
    : pickPool
  const choice =
    candidatePool.length > 0
      ? candidatePool[Math.floor(Math.random() * candidatePool.length)]
      : null
  const playerId =
    typeof choice?.personId === 'number'
      ? choice.personId
      : typeof choice?.playerId === 'number'
        ? choice.playerId
        : null
  const playerName =
    typeof choice?.name === 'string'
      ? choice.name
      : typeof choice?.firstName === 'string' &&
          typeof choice?.lastName === 'string'
        ? `${choice.firstName} ${choice.lastName}`
        : null
  const rawTeamId =
    typeof choice?.teamId === 'number'
      ? choice.teamId
      : typeof choice?.teamId === 'string'
        ? Number(choice.teamId)
        : null
  const rawNestedTeamId =
    typeof choice?.team?.teamId === 'number'
      ? choice.team.teamId
      : typeof choice?.team?.teamId === 'string'
        ? Number(choice.team.teamId)
        : null
  const teamTricode = normalizeTricode(
    typeof choice?.teamTricode === 'string'
      ? choice.teamTricode
      : typeof choice?.teamAbbreviation === 'string'
        ? choice.teamAbbreviation
        : rawTeamId !== null && rawTeamId === homeTeam?.teamId
          ? (homeTeam?.teamTricode ?? null)
          : rawTeamId !== null && rawTeamId === awayTeam?.teamId
            ? (awayTeam?.teamTricode ?? null)
            : rawNestedTeamId !== null && rawNestedTeamId === homeTeam?.teamId
              ? (homeTeam?.teamTricode ?? null)
              : rawNestedTeamId !== null && rawNestedTeamId === awayTeam?.teamId
                ? (awayTeam?.teamTricode ?? null)
                : null
  )
  const resolvedTeamTricode =
    teamTricode ??
    (playerId &&
    Array.isArray(homePlayers) &&
    homePlayers.some((player) => getPlayerId(player) === playerId)
      ? (homeTeam?.teamTricode ?? null)
      : playerId &&
          Array.isArray(awayPlayers) &&
          awayPlayers.some((player) => getPlayerId(player) === playerId)
        ? (awayTeam?.teamTricode ?? null)
        : null)
  const isActiveChoice = !!choice
    ? active.some((player) => {
        const id = getPlayerId(player)
        return id !== null && id === playerId
      })
    : false
  const profile = playerId
    ? seasonProfiles?.playersById.get(String(playerId))
    : undefined
  const currentStat = playerId
    ? getPlayerPeriodStat(choice, currentPeriod, statType)
    : null
  const targetInfo = getPlayerTargetInfo(
    profile,
    statType,
    currentPeriod,
    clockMs ?? null,
    currentStat
  )
  const perQuarterTarget = targetInfo.target
  const isCandidate =
    statType === 'POINTS'
      ? !!profile?.isScoringCandidate
      : statType === 'REBOUNDS'
        ? !!profile?.isReboundCandidate
        : statType === 'ASSISTS'
          ? !!profile?.isAssistCandidate
          : statType === 'STEALS'
            ? !!profile?.isStealsCandidate
            : statType === 'BLOCKS'
              ? !!profile?.isBlocksCandidate
              : false
  const selectionReason: SelectionReason[] = []
  if (isActiveChoice) selectionReason.push({ code: 'active_player' })
  if (isCandidate) {
    selectionReason.push({
      code: 'season_candidate',
      detail: `statType=${statType}`,
    })
  }
  const target =
    Number.isFinite(currentStat) && increment > 0
      ? Math.max(1, Number(currentStat) + increment)
      : (perQuarterTarget ?? asNumber(template.resolutionContext?.target) ?? 10)
  if (playerId) {
    const periodStat = currentStat
    if (periodStat !== null && Number.isFinite(target)) {
      selectionReason.push({
        code: 'period_stat',
        detail: `current=${periodStat} target=${target} timeLeft=${targetInfo.timeLeftRatio ?? 'n/a'}`,
      })
    }
  }
  const baseLabel =
    statType === 'ASSISTS'
      ? 'assists'
      : statType === 'REBOUNDS'
        ? 'rebounds'
        : statType === 'STEALS'
          ? increment > 0
            ? 'another steal'
            : 'steals'
          : statType === 'THREES'
            ? increment > 0
              ? 'another 3-pointer'
              : '3-pointers'
            : statType === 'FTM'
              ? 'a free throw'
              : 'points'
  const questionText = playerName
    ? increment > 0
      ? `Will ${playerName} record ${baseLabel} in the rest of this quarter?`
      : `Will ${playerName} record ${target}+ ${baseLabel} in the rest of this quarter?`
    : template.text
  return {
    ...template,
    text: questionText,
    resolutionContext: {
      ...(template.resolutionContext ?? {}),
      playerId,
      playerName,
      teamTricode: resolvedTeamTricode,
      statType,
      target,
      selectionReason,
    },
  }
}

const resolveTeamText = (text: string, boxScore: BoxScore | null): string => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeTricode = homeTeam?.teamTricode
  const awayTricode = awayTeam?.teamTricode
  let resolved = text
  if (homeTricode) {
    resolved = resolved.replace(/the home team/gi, homeTricode)
    resolved = resolved.replace(/home team/gi, homeTricode)
  }
  if (awayTricode) {
    resolved = resolved.replace(/the away team/gi, awayTricode)
    resolved = resolved.replace(/away team/gi, awayTricode)
  }
  return resolved
}

const resolveTemplate = (
  template: QuestionTemplate,
  boxScore: BoxScore | null,
  playerExclude?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
    teamsById: Map<string, TeamSeasonProfile>
  },
  period?: number,
  clockMs?: number | null
): QuestionTemplate => {
  let resolvedTemplate = template
  if (PLAYER_TEMPLATE_IDS.has(template.id)) {
    resolvedTemplate = buildPlayerMilestoneTemplate(
      template,
      boxScore,
      playerExclude,
      seasonProfiles,
      period,
      clockMs
    )
  }
  if (
    template.resolutionContext?.type === 'PLAYER_COMPARE_PERIOD' ||
    template.resolutionContext?.type === 'PLAYER_COMPARE_NEXT_N'
  ) {
    resolvedTemplate = buildPlayerCompareTemplate(
      resolvedTemplate,
      boxScore,
      playerExclude,
      seasonProfiles,
      period
    )
  }
  if (template.id === 'PERIOD_ANY_3') {
    resolvedTemplate = buildPeriodThreeTemplate(resolvedTemplate)
  }
  if (template.resolutionContext?.type === 'TEAM_POINTS_THIS_PERIOD') {
    resolvedTemplate = buildTeamPointsTemplate(
      resolvedTemplate,
      boxScore,
      seasonProfiles
    )
  }
  if (template.resolutionContext?.type === 'TEAM_STAT_THIS_PERIOD') {
    resolvedTemplate = buildTeamStatTemplate(
      resolvedTemplate,
      boxScore,
      seasonProfiles
    )
  }
  resolvedTemplate = {
    ...resolvedTemplate,
    text: resolveTeamText(resolvedTemplate.text, boxScore),
  }
  return resolvedTemplate
}

const buildQuestionPayload = (
  template: QuestionTemplate,
  event: EngineEvent,
  boxScore: BoxScore | null,
  triggerReason: string,
  playerExclude?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
    teamsById: Map<string, TeamSeasonProfile>
  },
  derivedStats?: DerivedStatsSnapshot
): EngineQuestionPayload => {
  const clockMs = event.gameState?.clockMs ?? null
  const resolvedTemplate = resolveTemplate(
    template,
    boxScore,
    playerExclude,
    seasonProfiles,
    event.gameState?.period ?? 0,
    clockMs
  )
  const resolutionWindowMs = computeResolutionWindowMs(resolvedTemplate, event)
  const resolutionContext = buildResolutionContext(
    resolvedTemplate,
    event,
    boxScore,
    resolutionWindowMs,
    derivedStats
  )
  if (
    resolvedTemplate.windowType === 'PERIOD' &&
    clockMs !== null &&
    clockMs <= 30_000
  ) {
    resolutionContext.invalid = true
  }
  if (resolutionContext.type === 'PLAYER_MILESTONE_PERIOD') {
    const increment = asNumber(resolutionContext.increment) ?? 0
    const playerId = asNumber(resolutionContext.playerId)
    const statType = asString(resolutionContext.statType) ?? 'POINTS'
    const target = asNumber(resolutionContext.target)
    if (increment === 0 && playerId && target !== null) {
      const player = getPlayerFromBoxScore(boxScore, playerId)
      const currentStat = getPlayerPeriodStat(
        player,
        event.gameState?.period ?? 0,
        statType
      )
      if (
        currentStat !== null &&
        Number.isFinite(currentStat) &&
        target - currentStat <=
          (statType === 'POINTS'
            ? 3
            : statType === 'ASSISTS' ||
                statType === 'STEALS' ||
                statType === 'REBOUNDS' ||
                statType === 'BLOCKS' ||
                statType === 'THREES'
              ? 2
              : 1)
      ) {
        resolutionContext.invalid = true
      }
    }
    if (
      playerId !== null &&
      Number.isFinite(playerId) &&
      resolutionContext.initialValue === null
    ) {
      resolutionContext.invalid = true
    }
  }
  let questionText = resolvedTemplate.text
  if (resolutionContext?.type === 'PLAYER_COMPARE_NEXT_N') {
    const minutes = asNumber(resolutionContext?.minutes)
    if (minutes !== null) {
      questionText = questionText.replace(/\{minutes\}/gi, String(minutes))
    }
  }
  if (
    asBoolean(resolutionContext?.requiresTrailing) &&
    asString(resolutionContext?.trailingTricode)
  ) {
    questionText = questionText.replace(
      /team behind/gi,
      String(asString(resolutionContext?.trailingTricode))
    )
  }
  if (
    asBoolean(resolutionContext?.requiresLeading) &&
    asString(resolutionContext?.leadingTricode)
  ) {
    questionText = questionText.replace(
      /leading team/gi,
      String(asString(resolutionContext?.leadingTricode))
    )
  }
  return {
    templateId: resolvedTemplate.id,
    question: questionText,
    windowType: resolvedTemplate.windowType,
    timeoutMs: QUESTION_TIMEOUT_MS,
    resolutionWindowMs,
    resolutionContext,
    selectionReason:
      asSelectionReasons(resolutionContext?.selectionReason) ?? undefined,
    trigger: triggerReason,
    period: event.gameState?.period ?? 0,
    clockMs: event.gameState?.clockMs ?? 0,
  }
}

const buildSyntheticEvent = (gameState: EngineGameState): EngineEvent => ({
  eventId: 0,
  source: EngineEventSource.NBA_COM,
  type: EventType.OTHER,
  subType: NbaEventSubType.UNKNOWN,
  context: null,
  description: 'game_start',
  questionId: null,
  gameState,
  ingestedAt: null,
})

export const triggerGameStartQuestions = (
  gameId: string,
  gameState: EngineGameState,
  boxScore: BoxScore | null,
  opts?: TriggerOptions
): EngineQuestionPayload[] => {
  if (GAME_START_ASKED_BY_GAME.has(gameId)) return []
  const templates: QuestionTemplate[] = [
    {
      id: 'GAME_WINNER',
      text: 'Who will win the game?',
      weight: 1,
      windowType: 'GAME',
      resolutionContext: { type: 'GAME_WINNER' },
    },
    {
      id: 'JUMP_BALL_WINNER',
      text: 'Who will win the opening jump ball?',
      weight: 1,
      windowType: 'JUMP_BALL',
      resolutionContext: { type: 'JUMP_BALL_WINNER' },
    },
  ]
  const emit = () => {
    const now = opts?.nowMs ?? Date.now()
    const event = buildSyntheticEvent(gameState)
    const payloads = templates.map((template) =>
      buildQuestionPayload(
        template,
        event,
        boxScore,
        'game_start',
        undefined,
        opts?.seasonProfiles
      )
    )
    LAST_QUESTION_AT_BY_GAME.set(gameId, now)
    if (opts?.persistQuestions) {
      for (const payload of payloads) {
        void createAndSendEngineQuestion(gameId, payload)
      }
    }
    if (!opts?.suppressLogs) {
      for (const payload of payloads) {
        console.log(
          `[engine] trigger question game=${gameId} payload=${JSON.stringify(
            payload
          )}`
        )
      }
    }
    return payloads
  }
  GAME_START_ASKED_BY_GAME.add(gameId)
  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(() => {
      emit()
    }, opts.delayMs)
    return []
  }
  return emit()
}

export const scheduleGameStartQuestions = (
  gameId: string,
  gameState: EngineGameState,
  boxScore: BoxScore | null,
  opts?: TriggerOptions & {
    winnerDelayMs?: { min: number; max: number }
    jumpBallDelayMs?: { min: number; max: number }
  }
): void => {
  if (GAME_START_ASKED_BY_GAME.has(gameId)) return
  const templates: QuestionTemplate[] = [
    {
      id: 'GAME_WINNER',
      text: 'Who will win the game?',
      weight: 1,
      windowType: 'GAME',
      resolutionContext: { type: 'GAME_WINNER' },
    },
    {
      id: 'JUMP_BALL_WINNER',
      text: 'Who will win the opening jump ball?',
      weight: 1,
      windowType: 'JUMP_BALL',
      resolutionContext: { type: 'JUMP_BALL_WINNER' },
    },
  ]
  const randDelay = (range: { min: number; max: number }) => {
    const span = Math.max(0, range.max - range.min)
    return range.min + Math.floor(Math.random() * (span + 1))
  }
  const winnerDelay = randDelay(
    opts?.winnerDelayMs ?? { min: 10_000, max: 30_000 }
  )
  const jumpBallDelay = randDelay(
    opts?.jumpBallDelayMs ?? { min: 60_000, max: 90_000 }
  )

  const emit = (template: QuestionTemplate) => {
    const payload = buildQuestionPayload(
      template,
      buildSyntheticEvent(gameState),
      boxScore,
      'game_start',
      undefined,
      opts?.seasonProfiles
    )
    LAST_QUESTION_AT_BY_GAME.set(gameId, Date.now())
    if (opts?.persistQuestions) {
      void createAndSendEngineQuestion(gameId, payload)
    }
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] trigger question game=${gameId} payload=${JSON.stringify(
          payload
        )}`
      )
    }
  }

  GAME_START_ASKED_BY_GAME.add(gameId)
  setTimeout(() => emit(templates[0]), winnerDelay)
  setTimeout(() => emit(templates[1]), winnerDelay + jumpBallDelay)
}

const coerceScore = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  return Number(value)
}

const getScoreMargin = (event: EngineEvent): number | null => {
  const home = coerceScore(event.gameState?.scoreHome)
  const away = coerceScore(event.gameState?.scoreAway)
  if (home === null || away === null) return null
  return Math.abs(home - away)
}

const getLeader = (
  event: EngineEvent
): { leader: 'HOME' | 'AWAY' | 'TIE'; leaderTricode: string | null } => {
  const home = coerceScore(event.gameState?.scoreHome)
  const away = coerceScore(event.gameState?.scoreAway)
  if (home === null || away === null) {
    return { leader: 'TIE', leaderTricode: null }
  }
  if (home === away) return { leader: 'TIE', leaderTricode: null }
  const leader = home > away ? 'HOME' : 'AWAY'
  const leaderTricode =
    leader === 'HOME'
      ? (event.gameState?.boxScore?.homeTeam?.teamTricode ?? null)
      : (event.gameState?.boxScore?.awayTeam?.teamTricode ?? null)
  return { leader, leaderTricode }
}

const getElapsedSeconds = (period: number, clockMs: number): number => {
  const periodLengthSeconds = period > 4 ? 5 * 60 : 12 * 60
  const elapsedThisPeriod = periodLengthSeconds - Math.floor(clockMs / 1000)
  const regulationElapsed = Math.max(0, period - 1) * 12 * 60
  const overtimeElapsed = period > 4 ? (period - 5) * 5 * 60 : 0
  return regulationElapsed + overtimeElapsed + elapsedThisPeriod
}

const getTeamScore = (
  event: EngineEvent,
  team: 'HOME' | 'AWAY'
): number | null => {
  const score =
    team === 'HOME' ? event.gameState?.scoreHome : event.gameState?.scoreAway
  return coerceScore(score)
}

const getTeamStat = (
  boxScore: BoxScore | null,
  team: 'HOME' | 'AWAY',
  statType: string
): number | null => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const teamData = team === 'HOME' ? homeTeam : awayTeam
  const stats = teamData?.statistics
  if (!stats) return null
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'REBOUNDS') return Number(stats.reboundsTotal ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? 0)
  return null
}

const getComparableTeamValue = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  team: 'HOME' | 'AWAY',
  statType: string | null | undefined
): number | null => {
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return getTeamScore(event, team)
  return getTeamStat(boxScore, team, key)
}

const getDerivedTeamStat = (
  derived: DerivedStatsSnapshot | null | undefined,
  tricode: string | null,
  statType: string | null | undefined
): number | null => {
  if (!derived || !tricode) return null
  const key = normalizeTricode(tricode)
  if (!key) return null
  const line = derived.teams[key]
  if (!line) return null
  const stat = String(statType || '').toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getDerivedPlayerStat = (
  derived: DerivedStatsSnapshot | null | undefined,
  playerId: number | null,
  statType: string | null | undefined
): number | null => {
  if (!derived || !playerId) return null
  const line = derived.players[String(playerId)]
  if (!line) return null
  const stat = String(statType || '').toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getOfficialStatLineValue = (
  line: {
    points: number
    assists: number
    rebounds: number
    steals: number
    threes: number
    blocks: number
    freeThrowsMade: number
  } | null,
  statType: string | null | undefined
): number | null => {
  if (!line) return null
  const stat = String(statType || '').toUpperCase()
  if (stat === 'POINTS') return line.points
  if (stat === 'ASSISTS') return line.assists
  if (stat === 'REBOUNDS') return line.rebounds
  if (stat === 'STEALS') return line.steals
  if (stat === 'THREES' || stat === 'FG3M') return line.threes
  if (stat === 'BLOCKS') return line.blocks
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return line.freeThrowsMade
  return null
}

const getOfficialCumulativeSnapshot = (
  event: EngineEvent
): OfficialCumulativeStatsSnapshot | null => {
  const snapshot = event.context?.officialCumulativeStats
  if (!snapshot) return null
  return snapshot
}

const getOfficialCumulativeTeamStat = (
  event: EngineEvent,
  tricode: string | null,
  statType: string | null | undefined
): number | null => {
  const snapshot = getOfficialCumulativeSnapshot(event)
  if (!snapshot || !tricode) return null
  const key = normalizeTricode(tricode)
  if (!key) return null
  const line = snapshot.teams[key] ?? null
  return getOfficialStatLineValue(line, statType)
}

const getOfficialCumulativePlayerStat = (
  event: EngineEvent,
  playerId: number | null,
  statType: string | null | undefined
): number | null => {
  const snapshot = getOfficialCumulativeSnapshot(event)
  if (!snapshot || !playerId) return null
  const line = snapshot.players[String(playerId)] ?? null
  return getOfficialStatLineValue(line, statType)
}

const getTeamPlayersByTricode = (
  boxScore: BoxScore | null,
  teamTricode: string | null
): BoxScorePlayer[] => {
  if (!teamTricode) return []
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const normalized = normalizeTricode(teamTricode)
  if (!normalized) return []
  if (normalizeTricode(homeTeam?.teamTricode) === normalized) {
    return Array.isArray(homeTeam?.players) ? homeTeam.players : []
  }
  if (normalizeTricode(awayTeam?.teamTricode) === normalized) {
    return Array.isArray(awayTeam?.players) ? awayTeam.players : []
  }
  return []
}

const normalizeTricode = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.trim().toUpperCase()
}

const resolveTeamSideByTricode = (
  boxScore: BoxScore | null,
  tricode: string | null | undefined
): 'HOME' | 'AWAY' | null => {
  const code = normalizeTricode(tricode)
  if (!code) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeCode = normalizeTricode(homeTeam?.teamTricode)
  const awayCode = normalizeTricode(awayTeam?.teamTricode)
  if (homeCode && code === homeCode) return 'HOME'
  if (awayCode && code === awayCode) return 'AWAY'
  return null
}

const buildResolutionContext = (
  template: QuestionTemplate,
  event: EngineEvent,
  boxScore: BoxScore | null,
  resolutionWindowMs: number | null,
  derivedStats?: DerivedStatsSnapshot
): ResolutionContext => {
  const statBoxScore = event.gameState?.boxScore ?? null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeTricode =
    homeTeam?.teamTricode ??
    event.gameState?.boxScore?.homeTeam?.teamTricode ??
    null
  const awayTricode =
    awayTeam?.teamTricode ??
    event.gameState?.boxScore?.awayTeam?.teamTricode ??
    null
  const templateTeamTricode = normalizeTricode(
    asString(template.resolutionContext?.teamTricode)
  )
  const base = {
    ...template.resolutionContext,
    startEventId: event.eventId,
    startPeriod: event.gameState?.period ?? null,
    startClockMs: event.gameState?.clockMs ?? null,
    startScoreHome: event.gameState?.scoreHome ?? null,
    startScoreAway: event.gameState?.scoreAway ?? null,
    homeTricode,
    awayTricode,
  }
  if ('team' in base) {
    delete (base as { team?: string }).team
  }

  switch (template.resolutionContext?.type) {
    case 'TOTAL_POINTS_NEXT_N': {
      const home = coerceScore(event.gameState?.scoreHome) ?? 0
      const away = coerceScore(event.gameState?.scoreAway) ?? 0
      const currentTotal = home + away
      const target = asNumber(template.resolutionContext?.target) ?? 0
      return {
        ...base,
        startTotal: currentTotal,
        minTotalScore: currentTotal + target,
        initialValue: currentTotal,
      }
    }
    case 'TEAM_POINTS_NEXT_N':
    case 'TEAM_POINTS_REST_PERIOD':
    case 'TEAM_POINTS_THIS_PERIOD': {
      const teamContext =
        templateTeamTricode ??
        asString(template.resolutionContext?.team) ??
        'HOME'
      const teamSide = templateTeamTricode
        ? resolveTeamSideByTricode(boxScore, templateTeamTricode)
        : teamContext === 'HOME' || teamContext === 'AWAY'
          ? teamContext
          : resolveTeamSideByTricode(boxScore, teamContext)
      const teamTricode = templateTeamTricode
        ? templateTeamTricode
        : teamSide === 'HOME'
          ? homeTricode
          : teamSide === 'AWAY'
            ? awayTricode
            : normalizeTricode(teamContext)
      const current = teamSide ? (getTeamScore(event, teamSide) ?? 0) : 0
      const target = asNumber(template.resolutionContext?.target) ?? 0
      return {
        ...base,
        teamTricode,
        minTeamScore: current + target,
        initialValue: current,
      }
    }
    case 'TEAM_STAT_THIS_PERIOD': {
      const teamContext =
        templateTeamTricode ??
        asString(template.resolutionContext?.team) ??
        'HOME'
      const teamSide = templateTeamTricode
        ? resolveTeamSideByTricode(boxScore, templateTeamTricode)
        : teamContext === 'HOME' || teamContext === 'AWAY'
          ? teamContext
          : resolveTeamSideByTricode(boxScore, teamContext)
      const teamTricode = templateTeamTricode
        ? templateTeamTricode
        : teamSide === 'HOME'
          ? homeTricode
          : teamSide === 'AWAY'
            ? awayTricode
            : normalizeTricode(teamContext)
      const statType = asString(template.resolutionContext?.statType)
      const current =
        teamSide && statType
          ? (() => {
              const byDerived = getDerivedTeamStat(
                derivedStats,
                teamTricode,
                statType
              )
              if (byDerived !== null) return byDerived
              return (
                getComparableTeamValue(
                  event,
                  statBoxScore,
                  teamSide,
                  statType
                ) ?? 0
              )
            })()
          : 0
      const target = asNumber(template.resolutionContext?.target) ?? 0
      return {
        ...base,
        teamTricode,
        statType,
        startTeamStat: current,
        minTeamStat: current + target,
        initialValue: current,
      }
    }
    case 'BOTH_TEAMS_10_REST_PERIOD': {
      const home = getTeamScore(event, 'HOME') ?? 0
      const away = getTeamScore(event, 'AWAY') ?? 0
      const target = asNumber(template.resolutionContext?.target) ?? 0
      return {
        ...base,
        minHomeScore: home + target,
        minAwayScore: away + target,
        initialValue: { home, away },
      }
    }
    case 'MADE_3_COUNT_NEXT_N': {
      const homeThrees =
        getDerivedTeamStat(derivedStats, homeTricode, 'THREES') ??
        getTeamStat(statBoxScore, 'HOME', 'THREES') ??
        null
      const awayThrees =
        getDerivedTeamStat(derivedStats, awayTricode, 'THREES') ??
        getTeamStat(statBoxScore, 'AWAY', 'THREES') ??
        null
      return {
        ...base,
        minMade3Count: asNumber(template.resolutionContext?.target) ?? 0,
        windowMs: resolutionWindowMs,
        startHomeThrees: homeThrees,
        startAwayThrees: awayThrees,
        initialValue: { home: homeThrees, away: awayThrees },
      }
    }
    case 'MADE_FG_BEFORE_PERIOD_END':
    case 'MADE_3_BEFORE_PERIOD_END':
    case 'MADE_FT_BEFORE_PERIOD_END': {
      return {
        ...base,
        endPeriod: base.startPeriod,
      }
    }
    case 'ANY_3_THIS_PERIOD':
    case 'THREE_COUNT_THIS_PERIOD': {
      const homeThrees =
        getDerivedTeamStat(derivedStats, homeTricode, 'THREES') ??
        getTeamStat(statBoxScore, 'HOME', 'THREES') ??
        null
      const awayThrees =
        getDerivedTeamStat(derivedStats, awayTricode, 'THREES') ??
        getTeamStat(statBoxScore, 'AWAY', 'THREES') ??
        null
      return {
        ...base,
        endPeriod: base.startPeriod,
        minMade3Count: asNumber(template.resolutionContext?.target) ?? 0,
        startHomeThrees: homeThrees,
        startAwayThrees: awayThrees,
        initialValue: { home: homeThrees, away: awayThrees },
      }
    }
    case 'LEADER_END_OF_PERIOD': {
      if (template.resolutionContext?.requiresTrailing) {
        const { leader, leaderTricode } = getLeader(event)
        if (leader === 'TIE') return { ...base, invalid: true }
        const trailingTricode =
          leader === 'HOME' ? base.awayTricode : base.homeTricode
        return {
          ...base,
          endPeriod: base.startPeriod,
          trailingTricode,
          leaderTricode,
        }
      }
      if (template.resolutionContext?.requiresLeading) {
        const { leader, leaderTricode } = getLeader(event)
        if (leader === 'TIE') return { ...base, invalid: true }
        return {
          ...base,
          endPeriod: base.startPeriod,
          leadingTricode: leaderTricode,
          leaderTricode,
        }
      }
      return {
        ...base,
        endPeriod: base.startPeriod,
      }
    }
    case 'TEAM_COMPARE_PERIOD': {
      const statType = asString(template.resolutionContext?.statType) ?? ''
      const homeStat = (() => {
        const byDerived = getDerivedTeamStat(
          derivedStats,
          homeTricode,
          statType
        )
        if (byDerived !== null) return byDerived
        return (
          getComparableTeamValue(event, statBoxScore, 'HOME', statType) ?? 0
        )
      })()
      const awayStat = (() => {
        const byDerived = getDerivedTeamStat(
          derivedStats,
          awayTricode,
          statType
        )
        if (byDerived !== null) return byDerived
        return (
          getComparableTeamValue(event, statBoxScore, 'AWAY', statType) ?? 0
        )
      })()
      return {
        ...base,
        endPeriod: base.startPeriod,
        statType,
        minHomeStat: homeStat,
        minAwayStat: awayStat,
        initialValue: { home: homeStat, away: awayStat },
      }
    }
    case 'PLAYER_MILESTONE_PERIOD': {
      const playerId = asNumber(template.resolutionContext?.playerId)
      const statType = asString(template.resolutionContext?.statType) ?? ''
      const player =
        playerId !== null && Number.isFinite(playerId)
          ? getPlayerFromBoxScore(boxScore, playerId)
          : null
      const currentGameStat =
        playerId !== null && Number.isFinite(playerId)
          ? (() => {
              const byDerived = getDerivedPlayerStat(
                derivedStats,
                playerId,
                statType
              )
              if (byDerived !== null) return byDerived
              return getPlayerGameStat(player, statType)
            })()
          : null
      const currentPeriodStat =
        playerId !== null && Number.isFinite(playerId)
          ? getPlayerPeriodStat(player, base.startPeriod ?? 0, statType)
          : null
      return {
        ...base,
        endPeriod: base.startPeriod,
        target: asNumber(template.resolutionContext?.target),
        playerId,
        startGameStat:
          currentGameStat !== null && Number.isFinite(currentGameStat)
            ? currentGameStat
            : null,
        initialValue:
          currentGameStat !== null && Number.isFinite(currentGameStat)
            ? currentGameStat
            : null,
      }
    }
    case 'PLAYER_COMPARE_PERIOD': {
      const statType = asString(template.resolutionContext?.statType) ?? ''
      const playerIds =
        asNumberArray(template.resolutionContext?.playerIds) ?? []
      const startStats: Record<string, number> = {}
      const startGameStats: Record<string, number> = {}
      for (const playerId of playerIds) {
        const player = getPlayerFromBoxScore(boxScore, Number(playerId))
        const gameStat = player ? getPlayerGameStat(player, statType) : null
        const derivedGameStat = getDerivedPlayerStat(
          derivedStats,
          playerId,
          statType
        )
        const baseGameStat =
          derivedGameStat !== null ? derivedGameStat : gameStat
        if (baseGameStat !== null && !Number.isNaN(baseGameStat)) {
          startGameStats[String(playerId)] = baseGameStat
        }
        if (!player) continue
        const stat = getPlayerPeriodStat(
          player,
          base.startPeriod ?? 0,
          statType
        )
        if (stat === null || Number.isNaN(stat)) continue
        startStats[String(playerId)] = stat
      }
      return {
        ...base,
        endPeriod: base.startPeriod,
        statType,
        playerIds,
        choices: asChoiceArray(template.resolutionContext?.choices) ?? [],
        tiedStatValue: asNumber(template.resolutionContext?.tiedStatValue),
        startPlayerGameStats: Object.keys(startGameStats).length
          ? startGameStats
          : null,
        initialValue: Object.keys(startStats).length ? startStats : null,
      }
    }
    case 'PLAYER_COMPARE_NEXT_N': {
      const playerIds =
        asNumberArray(template.resolutionContext?.playerIds) ?? []
      const startPlayerStats: Record<string, number> = {}
      const statType = asString(template.resolutionContext?.statType) ?? ''
      if (playerIds.length) {
        for (const playerId of playerIds) {
          const player = getPlayerFromBoxScore(boxScore, Number(playerId))
          const derivedStat = getDerivedPlayerStat(
            derivedStats,
            playerId,
            statType
          )
          const stat =
            derivedStat !== null
              ? derivedStat
              : player
                ? getPlayerGameStat(player, statType)
                : null
          if (stat === null || Number.isNaN(stat)) continue
          startPlayerStats[String(playerId)] = stat
        }
      }
      return {
        ...base,
        statType,
        minutes: asNumber(template.resolutionContext?.minutes),
        windowMs: resolutionWindowMs,
        playerIds,
        choices: asChoiceArray(template.resolutionContext?.choices) ?? [],
        tiedStatValue: asNumber(template.resolutionContext?.tiedStatValue),
        startPlayerStats:
          Object.keys(startPlayerStats).length > 0 ? startPlayerStats : null,
        initialValue:
          Object.keys(startPlayerStats).length > 0 ? startPlayerStats : null,
      }
    }
    case 'TEAM_SCORE_AFTER_TIMEOUT':
    case 'TEAM_SCORE_AFTER_FREETHROWS': {
      const teamContext =
        templateTeamTricode ??
        asString(template.resolutionContext?.team) ??
        'HOME'
      const teamSide = templateTeamTricode
        ? resolveTeamSideByTricode(boxScore, templateTeamTricode)
        : teamContext === 'HOME' || teamContext === 'AWAY'
          ? teamContext
          : resolveTeamSideByTricode(boxScore, teamContext)
      const teamTricode = templateTeamTricode
        ? templateTeamTricode
        : teamSide === 'HOME'
          ? homeTricode
          : teamSide === 'AWAY'
            ? awayTricode
            : normalizeTricode(teamContext)
      const current = teamSide ? (getTeamScore(event, teamSide) ?? 0) : 0
      return {
        ...base,
        teamTricode,
        minTeamScore: current + 1,
        windowMs: resolutionWindowMs,
      }
    }
    case 'NEXT_EVENT': {
      return {
        ...base,
        expectedEventType: asString(
          template.resolutionContext?.expectedEventType
        ),
        expectedSubType: asString(template.resolutionContext?.expectedSubType),
        windowMs: resolutionWindowMs,
      }
    }
    case 'BUZZER_BEATER_TIMEOUT': {
      return {
        ...base,
        endPeriod: base.startPeriod,
      }
    }
    case 'NEXT_DUNK_TEAM':
    case 'NEXT_DUNK_PLAYER': {
      return {
        ...base,
        windowMs: resolutionWindowMs,
      }
    }
    case 'LEAD_CHANGE_REST_GAME': {
      const { leader, leaderTricode } = getLeader(event)
      return {
        ...base,
        leader,
        leaderTricode,
        margin: getScoreMargin(event),
      }
    }
    case 'GAME_POINTS_PACE': {
      const home = coerceScore(event.gameState?.scoreHome) ?? 0
      const away = coerceScore(event.gameState?.scoreAway) ?? 0
      const currentTotal = home + away
      const elapsedSeconds = getElapsedSeconds(
        base.startPeriod ?? 1,
        base.startClockMs ?? 0
      )
      const regulationSeconds = 48 * 60
      const paceTotal =
        elapsedSeconds > 0
          ? Math.round((currentTotal / elapsedSeconds) * regulationSeconds)
          : null
      return {
        ...base,
        currentTotal,
        elapsedSeconds,
        paceTotal,
      }
    }
    case 'OVERTIME':
    case 'GAME_WINNER': {
      return {
        ...base,
      }
    }
    case 'JUMP_BALL_WINNER': {
      return {
        ...base,
        windowMs: resolutionWindowMs,
      }
    }
    default:
      return base
  }
}

const getThresholdQuestionTemplates = (
  event: EngineEvent,
  opts?: TriggerOptions
): QuestionTemplate[] => {
  const period = event.gameState?.period ?? 0
  const clockMs = event.gameState?.clockMs ?? 0
  const margin = opts?.bypassMarginConditions ? 0 : getScoreMargin(event)
  const templates: QuestionTemplate[] = []

  if (clockMs <= 9 * 60 * 1000 && clockMs > 6 * 60 * 1000) {
    const minutes = pickFrom([3, 4, 5])
    const teamTarget = pickFrom([6, 8, 10])
    const windowMs = minutes * 60 * 1000
    const playerCompareTemplates: QuestionTemplate[] = [
      {
        id: 'NEXT_N_PLAYER_COMPARE_POINTS',
        text: 'Who will score the most points in the next {minutes} minutes?',
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'PLAYER_COMPARE_NEXT_N',
          minutes,
          statType: 'POINTS',
        },
      },
      {
        id: 'NEXT_N_PLAYER_COMPARE_ASSISTS',
        text: 'Who will record the most assists in the next {minutes} minutes?',
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'PLAYER_COMPARE_NEXT_N',
          minutes,
          statType: 'ASSISTS',
        },
      },
      {
        id: 'NEXT_N_PLAYER_COMPARE_REBOUNDS',
        text: 'Who will record the most rebounds in the next {minutes} minutes?',
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'PLAYER_COMPARE_NEXT_N',
          minutes,
          statType: 'REBOUNDS',
        },
      },
      {
        id: 'NEXT_N_PLAYER_COMPARE_BLOCKS',
        text: 'Who will record the most blocks in the next {minutes} minutes?',
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'PLAYER_COMPARE_NEXT_N',
          minutes,
          statType: 'BLOCKS',
        },
      },
      {
        id: 'NEXT_N_PLAYER_COMPARE_THREES',
        text: 'Who will hit the most 3-pointers in the next {minutes} minutes?',
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'PLAYER_COMPARE_NEXT_N',
          minutes,
          statType: 'THREES',
        },
      },
    ]
    templates.push(
      {
        id: 'NEXT_5_MIN_TOTAL_POINTS',
        text: `Will there be 12+ total points scored in the next ${minutes} minutes?`,
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'TOTAL_POINTS_NEXT_N',
          minutes,
          target: 12,
        },
      },
      {
        id: 'NEXT_5_MIN_TEAM_POINTS',
        text: `Will the home team score ${teamTarget}+ in the next ${minutes} minutes?`,
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'TEAM_POINTS_NEXT_N',
          minutes,
          target: teamTarget,
          team: 'HOME',
        },
      },
      {
        id: 'NEXT_5_MIN_TWO_THREES',
        text: `Will there be at least two made threes in the next ${minutes} minutes?`,
        weight: 1,
        windowType: 'NEXT_N_MIN',
        resolutionWindowMs: windowMs,
        resolutionContext: {
          type: 'MADE_3_COUNT_NEXT_N',
          minutes,
          target: 2,
        },
      },
      ...playerCompareTemplates
    )
  }

  if (clockMs <= 6 * 60 * 1000 && clockMs > 4 * 60 * 1000) {
    if (margin !== null && margin <= 10) {
      templates.push(
        {
          id: 'REST_QUARTER_TEAM_POINTS',
          text: 'Will the away team score 12+ before the end of the quarter?',
          weight: 2,
          windowType: 'PERIOD',
          resolutionWindowMs: null,
          resolutionContext: {
            type: 'TEAM_POINTS_REST_PERIOD',
            target: 12,
            team: 'AWAY',
          },
        },
        {
          id: 'REST_QUARTER_BOTH_10',
          text: 'Will both teams score 10+ before the end of the quarter?',
          weight: 2,
          windowType: 'PERIOD',
          resolutionWindowMs: null,
          resolutionContext: { type: 'BOTH_TEAMS_10_REST_PERIOD', target: 10 },
        }
      )
    }
  }

  if (period === 4 && clockMs <= 4 * 60 * 1000 && clockMs > 2 * 60 * 1000) {
    if (margin !== null && margin <= 8) {
      templates.push({
        id: 'LEAD_CHANGE_FINAL_4',
        text: 'Will there be a lead change before the end of the game?',
        weight: 3,
        windowType: 'GAME',
        resolutionWindowMs: null,
        resolutionContext: { type: 'LEAD_CHANGE_REST_GAME' },
      })
    }
  }

  if (period === 4 && clockMs <= 2 * 60 * 1000) {
    if (margin !== null && margin <= 3) {
      templates.push({
        id: 'OVERTIME_YES_NO',
        text: 'Will this game go to overtime?',
        weight: 2,
        windowType: 'GAME',
        resolutionWindowMs: null,
        resolutionContext: { type: 'OVERTIME' },
      })
    }
  }

  return templates
}

export const triggerBasketballQuestion = async (
  gameId: string,
  event: EngineEvent,
  boxScore: BoxScore | null,
  opts?: TriggerOptions
): Promise<EngineQuestionPayload | null> => {
  const now = opts?.nowMs ?? Date.now()

  const period = event.gameState?.period ?? null
  const clockMs = event.gameState?.clockMs ?? null
  if (!period || clockMs === null) {
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] skip question game=${gameId} reason=missing_period_or_clock`
      )
    }
    return null
  }
  const isTimeoutEvent = event.type === EventType.TIMEOUT
  if (clockMs <= 10 * 1000 && !(isTimeoutEvent && clockMs <= 5 * 1000)) {
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] skip question game=${gameId} reason=under_ten_seconds period=${period} clockMs=${clockMs}`
      )
    }
    return null
  }

  const periodLengthMs = getPeriodLengthMs(period)
  const inSecondHalf = clockMs <= periodLengthMs / 2
  const gameElapsedMs = getElapsedSeconds(period, clockMs) * 1000

  recordRecentEvent(gameId, event)
  updateStreaksForEvent(gameId, event)
  if (opts?.skipQuestionGeneration) {
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] skip question generation game=${gameId} reason=catchup`
      )
    }
    return null
  }

  const window = getPeriodWindow(clockMs)
  const isTimeout = isTimeoutEvent
  const isFoul = event.type === EventType.FOUL
  const isShootingFoul = isFoul && isShootingFoulWithShots(event)
  const isPeriodStart = event.type === EventType.PERIOD_START
  const isPeriodEnd = event.type === EventType.PERIOD_END
  const isHalftime = isPeriodEnd && period === 2

  let triggerReason = `window:${window}`
  let triggerProbability = ASK_QUESTION_PROBABILITY

  if (isTimeout) {
    triggerReason = 'timeout'
    triggerProbability = TIMEOUT_QUESTION_PROBABILITY
  } else if (isShootingFoul) {
    triggerReason = 'foul'
    triggerProbability = FOUL_QUESTION_PROBABILITY
  } else if (isPeriodStart) {
    triggerReason = 'period_start'
    triggerProbability = PERIOD_START_PROBABILITY
  } else if (isPeriodEnd) {
    triggerReason = isHalftime ? 'halftime' : 'period_end'
    triggerProbability = isHalftime
      ? HALFTIME_PROBABILITY
      : PERIOD_END_PROBABILITY
  }
  if (
    triggerReason !== 'timeout' &&
    triggerReason !== 'foul' &&
    clockMs < 2 * 60 * 1000
  ) {
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] skip question game=${gameId} reason=under_two_minutes period=${period} clockMs=${clockMs}`
      )
    }
    return null
  }

  const lastAskedAt = LAST_QUESTION_AT_BY_GAME.get(gameId)
  const cooldownMs =
    LAST_QUESTION_COOLDOWN_MS_BY_GAME.get(gameId) ?? MIN_QUESTION_INTERVAL_MS
  const clockMinutes = Math.floor(clockMs / 60000)
  const clockSeconds = Math.floor((clockMs % 60000) / 1000)
  const timeLeftLabel = `${clockMinutes}:${String(clockSeconds).padStart(2, '0')}`
  const elapsedSeconds = getElapsedSeconds(period, clockMs)
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  const elapsedSecondsRemainder = elapsedSeconds % 60
  const elapsedLabel = `${elapsedMinutes}:${String(elapsedSecondsRemainder).padStart(2, '0')}`
  const foulCooldownMs = 60_000
  const timeoutCooldownMs = 60_000
  const bypassCooldown =
    (triggerReason === 'timeout' &&
      (!lastAskedAt || now - lastAskedAt >= timeoutCooldownMs)) ||
    (triggerReason === 'foul' &&
      (!lastAskedAt || now - lastAskedAt >= foulCooldownMs))

  if (
    triggerReason !== 'period_start' &&
    !bypassCooldown &&
    !opts?.bypassCooldown &&
    lastAskedAt &&
    now - lastAskedAt < cooldownMs
  ) {
    const remainingMs = cooldownMs - (now - lastAskedAt)
    if (!opts?.suppressLogs) {
      const cooldownEndMs = lastAskedAt + cooldownMs
      const lastLoggedUntil = LAST_COOLDOWN_LOGGED_UNTIL_BY_GAME.get(gameId)
      if (lastLoggedUntil !== cooldownEndMs) {
        const cooldownSeconds = Math.max(0, Math.round(remainingMs / 1000))
        const cooldownMinutes = Math.floor(cooldownSeconds / 60)
        const cooldownSecondsRemainder = cooldownSeconds % 60
        const cooldownLabel = `${cooldownMinutes}:${String(cooldownSecondsRemainder).padStart(2, '0')}`
        console.log(
          `[engine] skip question game=${gameId} reason=cooldown trigger=${triggerReason} cooldownRemaining=${cooldownLabel} elapsed=${elapsedLabel} timeLeft=${timeLeftLabel}`
        )
        LAST_COOLDOWN_LOGGED_UNTIL_BY_GAME.set(gameId, cooldownEndMs)
      }
    }
    return null
  }

  let jitteredProbability = triggerProbability * (0.2 + Math.random() * 0.8)
  if (triggerReason === 'foul' && bypassCooldown) jitteredProbability = 1
  if (triggerReason === 'timeout' && bypassCooldown) jitteredProbability = 1
  const canAsk = shouldAskQuestion(jitteredProbability)

  if (!canAsk) {
    if (!opts?.suppressLogs) {
      console.log(
        `[engine] skip question game=${gameId} reason=probability trigger=${triggerReason}`
      )
    }
    return null
  }

  void window

  const thresholdTemplates = getThresholdQuestionTemplates(event, opts)
  const dunkTemplates = buildDunkTemplates(gameId, event, boxScore, opts)
  const streakTemplates = getStreakQuestionTemplates(
    gameId,
    event,
    boxScore,
    opts?.seasonProfiles
  )
  const playerCompareTemplates = PLAYER_COMPARE_PERIOD_TEMPLATES
  let candidates: QuestionTemplate[] = [
    ...streakTemplates,
    ...dunkTemplates,
    ...QUESTION_TEMPLATES,
    ...thresholdTemplates,
    ...PLAYER_TEMPLATES,
    ...playerCompareTemplates,
    ...(inSecondHalf ? LATE_PERIOD_PLAYER_TEMPLATES : []),
  ]

  if (triggerReason === 'timeout') {
    const timeoutTemplates = buildTimeoutTemplates(
      event,
      boxScore,
      opts,
      gameId
    )
    candidates = [...timeoutTemplates]
  } else if (triggerReason === 'foul') {
    const foulTemplates = buildFoulTemplates(event, boxScore, opts, gameId)
    candidates = [...foulTemplates]
  } else if (triggerReason === 'period_start') {
    const margin = getScoreMargin(event) ?? 0
    candidates =
      margin > 0 && margin < 10
        ? [
            ...PERIOD_START_TEAM_TEMPLATES,
            ...PERIOD_START_CLOSE_MARGIN_TEMPLATES,
          ]
        : [...PERIOD_START_TEAM_TEMPLATES]
  }

  candidates = candidates.filter((template) => {
    if (!template.resolutionWindowMs) return true
    return template.resolutionWindowMs >= MIN_RESOLUTION_WINDOW_MS
  })
  candidates = candidates.filter((template) => {
    const group = QUESTION_GROUPS[template.id]
    return !hasGroup(gameId, period, group)
  })
  let questionPayload: EngineQuestionPayload | null = null
  let template: QuestionTemplate | null = null
  let remaining = [...candidates]
  const maxAttempts = Math.min(5, remaining.length)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    template = weightedPick(remaining)
    if (!template) return null

    const nextPayload = buildQuestionPayload(
      template,
      event,
      boxScore,
      triggerReason,
      getUsedPlayerIds(gameId),
      opts?.seasonProfiles,
      opts?.derivedStats
    )
    const invalidResolution =
      asBoolean(nextPayload.resolutionContext?.invalid) === true
    const missingPlayer =
      PLAYER_TEMPLATE_IDS.has(template.id) &&
      asNumber(nextPayload.resolutionContext?.playerId) === null
    const latencySkip = shouldSkipForLatency(gameId, event, nextPayload)
    const invalid = invalidResolution || missingPlayer || latencySkip

    if (invalid) {
      if (!opts?.suppressLogs) {
        console.log(
          `[engine] skip question game=${gameId} template=${template.id} reason=${invalidResolution ? 'invalid' : missingPlayer ? 'missing_player' : 'latency'}`
        )
      }
      remaining = remaining.filter((item) => item.id !== template?.id)
      template = null
      continue
    }

    if (PLAYER_TEMPLATE_IDS.has(template.id)) {
      const playerId = asNumber(nextPayload.resolutionContext?.playerId)
      if (!playerId) {
        questionPayload = nextPayload
        break
      }
      const lastAsked = PLAYER_USAGE_BY_GAME.get(gameId)?.get(playerId)
      const selectionReason = nextPayload.selectionReason
        ? [...nextPayload.selectionReason]
        : []
      selectionReason.push({
        code: 'last_asked',
        detail: lastAsked
          ? `period=${lastAsked.period} clockMs=${lastAsked.clockMs} askedAt=${new Date(
              lastAsked.askedAt
            ).toISOString()}`
          : 'never',
      })
      nextPayload.selectionReason = selectionReason
    }

    questionPayload = nextPayload
    break
  }

  if (!questionPayload || !template) return null
  LAST_QUESTION_AT_BY_GAME.set(gameId, now)
  const nextCooldownMs =
    MIN_QUESTION_INTERVAL_MS +
    Math.floor(
      Math.random() * (MAX_QUESTION_INTERVAL_MS - MIN_QUESTION_INTERVAL_MS)
    )
  LAST_QUESTION_COOLDOWN_MS_BY_GAME.set(gameId, nextCooldownMs)
  LAST_COOLDOWN_LOGGED_UNTIL_BY_GAME.delete(gameId)
  if (opts?.persistQuestions) {
    await createAndSendEngineQuestion(gameId, questionPayload)
  }
  if (!opts?.suppressLogs) {
    console.log(
      `[engine] trigger question game=${gameId} payload=${JSON.stringify(
        questionPayload
      )}`
    )
  }
  const payloadPlayerId = asNumber(questionPayload.resolutionContext?.playerId)
  if (PLAYER_TEMPLATE_IDS.has(template.id)) {
    markPlayerAsked(
      gameId,
      period,
      event.gameState?.clockMs ?? 0,
      payloadPlayerId
    )
  }
  if (payloadPlayerId && !PLAYER_TEMPLATE_IDS.has(template.id)) {
    markPlayerAsked(
      gameId,
      period,
      event.gameState?.clockMs ?? 0,
      payloadPlayerId
    )
  }
  const payloadPlayerIds = asNumberArray(
    questionPayload.resolutionContext?.playerIds
  )
  if (payloadPlayerIds) {
    for (const id of payloadPlayerIds) {
      markPlayerAsked(gameId, period, event.gameState?.clockMs ?? 0, id)
    }
  }
  markGroup(gameId, period, QUESTION_GROUPS[template.id])
  return questionPayload
}
type QuestionResolutionDecision = {
  state: 'resolved' | 'cancelled'
  answer: string | null
  reason?: string
}

export const getEventPlayerId = (event: EngineEvent): number | null =>
  event.context?.shot?.shooterId ??
  event.context?.freeThrow?.shooterId ??
  event.context?.primaryPlayerId ??
  null

export const getEventTeamTricode = (event: EngineEvent): string | null =>
  event.context?.shot?.teamTricode ??
  event.context?.freeThrow?.teamTricode ??
  event.context?.teamTricode ??
  null

const getEventTeamId = (event: EngineEvent): number | null =>
  event.context?.shot?.teamId ??
  event.context?.freeThrow?.teamId ??
  event.context?.teamId ??
  null

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.trim().toUpperCase()
}

const resolveTeamSide = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  context: ResolutionContext
): 'HOME' | 'AWAY' | null => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeTricode =
    normalizeCode(asString(context.homeTricode)) ??
    normalizeCode(homeTeam?.teamTricode) ??
    normalizeCode(event.gameState?.boxScore?.homeTeam?.teamTricode)
  const awayTricode =
    normalizeCode(asString(context.awayTricode)) ??
    normalizeCode(awayTeam?.teamTricode) ??
    normalizeCode(event.gameState?.boxScore?.awayTeam?.teamTricode)
  const eventTricode = normalizeCode(getEventTeamTricode(event))
  if (eventTricode && homeTricode && eventTricode === homeTricode) return 'HOME'
  if (eventTricode && awayTricode && eventTricode === awayTricode) return 'AWAY'
  const eventTeamId = getEventTeamId(event)
  if (eventTeamId && homeTeam?.teamId === eventTeamId) return 'HOME'
  if (eventTeamId && awayTeam?.teamId === eventTeamId) return 'AWAY'
  return null
}

const getCurrentScore = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  team: 'HOME' | 'AWAY'
): number | null => {
  const stateScore =
    team === 'HOME' ? event.gameState?.scoreHome : event.gameState?.scoreAway
  if (stateScore !== null && stateScore !== undefined) return Number(stateScore)
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const boxScoreValue =
    team === 'HOME' ? (homeTeam?.score ?? null) : (awayTeam?.score ?? null)
  if (boxScoreValue !== null && boxScoreValue !== undefined)
    return Number(boxScoreValue)
  return null
}

const isScoringEvent = (type: EventType) =>
  type === EventType.MADE_FG ||
  type === EventType.MADE_3 ||
  type === EventType.MADE_FT

const matchesExpectedEvent = (type: EventType, expected: string): boolean => {
  if (expected === 'MADE_FG')
    return type === EventType.MADE_FG || type === EventType.MADE_3
  if (expected === 'ATTEMPT_3')
    return type === EventType.MADE_3 || type === EventType.MISSED_3
  return String(type) === expected
}

const isMissForExpected = (type: EventType, expected: string): boolean => {
  if (expected === 'MADE_FG')
    return type === EventType.MISSED_FG || type === EventType.MISSED_3
  if (expected === 'MADE_3') return type === EventType.MISSED_3
  if (expected === 'MADE_FT') return type === EventType.MISSED_FT
  if (expected === 'ATTEMPT_3')
    return type === EventType.MADE_FG || type === EventType.MISSED_FG
  return false
}

const isShotAttemptExpectation = (expected: string): boolean =>
  expected === 'MADE_FG' || expected === 'MADE_3' || expected === 'ATTEMPT_3'

const isFinalStatus = (boxScore: BoxScore | null): boolean => {
  const status = boxScore?.gameStatus ?? boxScore?.game?.gameStatus
  const statusText = String(
    boxScore?.gameStatusText ?? boxScore?.game?.gameStatusText ?? ''
  ).toLowerCase()
  const numeric = typeof status === 'number' ? status : Number(status)
  if (numeric === 3) return true
  if (statusText.includes('final')) return true
  if (statusText.includes('game over')) return true
  return false
}

export const resolveQuestionForEvent = (
  question: QuestionRecord,
  event: EngineEvent,
  boxScore: BoxScore | null,
  derivedStats?: DerivedStatsSnapshot
): QuestionResolutionDecision | null => {
  const context = question?.resolutionContext ?? {}
  const type = asString(context.type) ?? ''
  if (!type) return null

  const startEventId = asNumber(context.startEventId)
  if (startEventId !== null && event.eventId <= startEventId) return null

  const currentPeriod = event.gameState?.period ?? null
  const currentClockMs = event.gameState?.clockMs ?? null
  const startPeriod = asNumber(context.startPeriod)
  const startClockMs = asNumber(context.startClockMs)
  const windowMs =
    typeof question?.resolutionWindowMs === 'number'
      ? question.resolutionWindowMs
      : asNumber(context.windowMs)

  const windowExpired =
    windowMs !== null &&
    !!startPeriod &&
    !!currentPeriod &&
    (currentPeriod > startPeriod ||
      (currentPeriod === startPeriod &&
        startClockMs !== null &&
        currentClockMs !== null &&
        startClockMs - currentClockMs >= windowMs))

  // Some feeds do not emit a reliable final event, but the box score can
  // already report a final status. We still treat that as end-of-game for
  // game-wide questions, but period questions should only resolve on an actual
  // PERIOD_END/GAME_END event to avoid resolving early against a later shared
  // box score snapshot.
  const gameEnded = event.type === EventType.GAME_END || isFinalStatus(boxScore)
  const periodFinished =
    event.type === EventType.GAME_END ||
    (!!startPeriod &&
      !!currentPeriod &&
      (currentPeriod > startPeriod ||
        (event.type === EventType.PERIOD_END && currentPeriod >= startPeriod)))
  const hasOfficialPeriodSnapshot =
    event.context?.raw &&
    typeof event.context.raw === 'object' &&
    (event.context.raw as { officialPeriodSnapshot?: unknown })
      .officialPeriodSnapshot === '1'
  const hasDerivedStats = Boolean(derivedStats)
  // Stat-based period resolutions should resolve at period boundary only when we
  // know the period snapshot is authoritative. Otherwise wait for next period.
  const periodStatsReady =
    event.type === EventType.GAME_END ||
    (!!startPeriod &&
      !!currentPeriod &&
      (currentPeriod > startPeriod ||
        (event.type === EventType.PERIOD_END &&
          currentPeriod >= startPeriod &&
          (hasDerivedStats || hasOfficialPeriodSnapshot))))
  const deferPeriodFinalization = periodFinished && !gameEnded

  const homeScore = getCurrentScore(event, boxScore, 'HOME')
  const awayScore = getCurrentScore(event, boxScore, 'AWAY')

  switch (type) {
    case 'TOTAL_POINTS_NEXT_N': {
      const currentTotal = (homeScore ?? 0) + (awayScore ?? 0)
      const minTotalScore = asNumber(context.minTotalScore)
      if (minTotalScore !== null && currentTotal >= minTotalScore)
        return { state: 'resolved', answer: 'yes' }
      if (windowExpired || gameEnded) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'TEAM_POINTS_NEXT_N':
    case 'TEAM_POINTS_REST_PERIOD':
    case 'TEAM_POINTS_THIS_PERIOD': {
      const tricode = asString(context.teamTricode)
      const teamContext = asString(context.team)
      const teamSide =
        resolveTeamSideByTricode(boxScore, tricode) ??
        (teamContext === 'HOME' || teamContext === 'AWAY' ? teamContext : null)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const current = getCurrentScore(event, boxScore, teamSide)
      const minTeamScore = asNumber(context.minTeamScore)
      if (minTeamScore !== null && current !== null && current >= minTeamScore)
        return { state: 'resolved', answer: 'yes' }
      if (periodFinished || windowExpired)
        return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'TEAM_STAT_THIS_PERIOD': {
      const tricode = asString(context.teamTricode)
      const teamContext = asString(context.team)
      const teamSide =
        resolveTeamSideByTricode(boxScore, tricode) ??
        (teamContext === 'HOME' || teamContext === 'AWAY' ? teamContext : null)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const statType = asString(context.statType) ?? ''
      const current =
        (USE_OFFICIAL_CUMULATIVE_RESOLUTION
          ? getOfficialCumulativeTeamStat(event, tricode, statType)
          : null) ??
        getComparableTeamValue(event, boxScore, teamSide, statType) ??
        getDerivedTeamStat(derivedStats, tricode, statType)
      const minTeamStat = asNumber(context.minTeamStat)
      if (minTeamStat === null || current === null) {
        if (periodStatsReady && deferPeriodFinalization) return null
        if (periodStatsReady) return { state: 'cancelled', answer: null }
        return null
      }
      if (minTeamStat !== null && current !== null && current >= minTeamStat)
        return { state: 'resolved', answer: 'yes' }
      if (periodStatsReady) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'BOTH_TEAMS_10_REST_PERIOD': {
      const minHomeScore = asNumber(context.minHomeScore)
      const minAwayScore = asNumber(context.minAwayScore)
      if (
        minHomeScore !== null &&
        minAwayScore !== null &&
        homeScore !== null &&
        awayScore !== null &&
        homeScore >= minHomeScore &&
        awayScore >= minAwayScore
      )
        return { state: 'resolved', answer: 'yes' }
      if (periodFinished) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'MADE_3_COUNT_NEXT_N': {
      const homeThrees =
        getDerivedTeamStat(
          derivedStats,
          asString(context.homeTricode),
          'THREES'
        ) ?? getTeamStat(boxScore, 'HOME', 'THREES')
      const awayThrees =
        getDerivedTeamStat(
          derivedStats,
          asString(context.awayTricode),
          'THREES'
        ) ?? getTeamStat(boxScore, 'AWAY', 'THREES')
      const startHomeThrees = asNumber(context.startHomeThrees)
      const startAwayThrees = asNumber(context.startAwayThrees)
      if (
        homeThrees === null ||
        awayThrees === null ||
        startHomeThrees === null ||
        startAwayThrees === null
      ) {
        if (windowExpired || gameEnded)
          return { state: 'cancelled', answer: null }
        return null
      }
      const delta = homeThrees + awayThrees - startHomeThrees - startAwayThrees
      const minMade3Count = asNumber(context.minMade3Count)
      if (minMade3Count !== null && delta >= minMade3Count)
        return { state: 'resolved', answer: 'yes' }
      if (windowExpired || gameEnded) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'MADE_FG_BEFORE_PERIOD_END':
    case 'MADE_3_BEFORE_PERIOD_END':
    case 'MADE_FT_BEFORE_PERIOD_END': {
      const expected =
        type === 'MADE_3_BEFORE_PERIOD_END'
          ? 'MADE_3'
          : type === 'MADE_FT_BEFORE_PERIOD_END'
            ? 'MADE_FT'
            : 'MADE_FG'
      if (matchesExpectedEvent(event.type, expected))
        return { state: 'resolved', answer: 'yes' }
      if (periodFinished) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'ANY_3_THIS_PERIOD':
    case 'THREE_COUNT_THIS_PERIOD': {
      const homeThrees =
        getDerivedTeamStat(
          derivedStats,
          asString(context.homeTricode),
          'THREES'
        ) ?? getTeamStat(boxScore, 'HOME', 'THREES')
      const awayThrees =
        getDerivedTeamStat(
          derivedStats,
          asString(context.awayTricode),
          'THREES'
        ) ?? getTeamStat(boxScore, 'AWAY', 'THREES')
      const startHomeThrees = asNumber(context.startHomeThrees)
      const startAwayThrees = asNumber(context.startAwayThrees)
      if (
        homeThrees === null ||
        awayThrees === null ||
        startHomeThrees === null ||
        startAwayThrees === null
      ) {
        if (periodFinished && deferPeriodFinalization) return null
        if (periodFinished) return { state: 'cancelled', answer: null }
        return null
      }
      const delta = homeThrees + awayThrees - startHomeThrees - startAwayThrees
      const minMade3Count = asNumber(context.minMade3Count)
      if (minMade3Count !== null && delta >= minMade3Count)
        return { state: 'resolved', answer: 'yes' }
      if (periodFinished) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'LEADER_END_OF_PERIOD': {
      if (!periodFinished) return null
      if (homeScore === null || awayScore === null)
        return { state: 'cancelled', answer: null }
      const leader =
        homeScore === awayScore
          ? 'TIE'
          : homeScore > awayScore
            ? 'HOME'
            : 'AWAY'
      const leaderTricode =
        leader === 'HOME'
          ? normalizeTricode(asString(context.homeTricode))
          : leader === 'AWAY'
            ? normalizeTricode(asString(context.awayTricode))
            : null
      if (asBoolean(context.requiresTrailing)) {
        if (leader === 'TIE') return { state: 'resolved', answer: 'no' }
        return {
          state: 'resolved',
          answer:
            leaderTricode && leaderTricode === asString(context.trailingTricode)
              ? 'yes'
              : 'no',
        }
      }
      if (asBoolean(context.requiresLeading)) {
        if (leader === 'TIE') return { state: 'resolved', answer: 'no' }
        return {
          state: 'resolved',
          answer:
            leaderTricode && leaderTricode === asString(context.leadingTricode)
              ? 'yes'
              : 'no',
        }
      }
      if (leader === 'TIE')
        return { state: 'cancelled', answer: null, reason: 'TIE' }
      return {
        state: 'resolved',
        answer: leaderTricode ?? null,
      }
    }
    case 'TEAM_COMPARE_PERIOD': {
      if (!periodStatsReady) return null
      const statType = asString(context.statType) ?? ''
      const homeStat =
        (USE_OFFICIAL_CUMULATIVE_RESOLUTION
          ? getOfficialCumulativeTeamStat(
              event,
              asString(context.homeTricode),
              statType
            )
          : null) ??
        getComparableTeamValue(event, boxScore, 'HOME', statType) ??
        getDerivedTeamStat(
          derivedStats,
          asString(context.homeTricode),
          statType
        )
      const awayStat =
        (USE_OFFICIAL_CUMULATIVE_RESOLUTION
          ? getOfficialCumulativeTeamStat(
              event,
              asString(context.awayTricode),
              statType
            )
          : null) ??
        getComparableTeamValue(event, boxScore, 'AWAY', statType) ??
        getDerivedTeamStat(
          derivedStats,
          asString(context.awayTricode),
          statType
        )
      const minHomeStat = asNumber(context.minHomeStat)
      const minAwayStat = asNumber(context.minAwayStat)
      if (
        homeStat === null ||
        awayStat === null ||
        minHomeStat === null ||
        minAwayStat === null
      )
        return periodFinished && deferPeriodFinalization
          ? null
          : { state: 'cancelled', answer: null }
      const homeDelta = homeStat - minHomeStat
      const awayDelta = awayStat - minAwayStat
      if (homeDelta === awayDelta)
        return { state: 'cancelled', answer: null, reason: 'TIE' }
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        state: 'resolved',
        answer: homeDelta > awayDelta ? homeTricode : awayTricode,
      }
    }
    case 'PLAYER_MILESTONE_PERIOD': {
      const playerId = asNumber(context.playerId) ?? 0
      const period = asNumber(context.endPeriod) ?? startPeriod ?? currentPeriod
      const statType = asString(context.statType) ?? 'POINTS'
      const eventPlayerId = getEventPlayerId(event)
      if (
        playerId &&
        statType === 'THREES' &&
        event.type === EventType.MADE_3 &&
        eventPlayerId === playerId
      ) {
        return { state: 'resolved', answer: 'yes' }
      }
      if (
        playerId &&
        statType === 'STEALS' &&
        event.type === EventType.STEAL &&
        eventPlayerId === playerId
      ) {
        return { state: 'resolved', answer: 'yes' }
      }
      if (!playerId || !period) {
        if (statType === 'THREES' && event.type === EventType.MADE_3)
          return { state: 'resolved', answer: 'yes' }
        if (statType === 'STEALS' && event.type === EventType.STEAL)
          return { state: 'resolved', answer: 'yes' }
        if (periodStatsReady) return { state: 'resolved', answer: 'no' }
        return null
      }
      const player = getPlayerFromBoxScore(boxScore, playerId)
      const currentGameStat =
        (USE_OFFICIAL_CUMULATIVE_RESOLUTION
          ? getOfficialCumulativePlayerStat(event, playerId, statType)
          : null) ??
        getPlayerGameStat(player, statType) ??
        getDerivedPlayerStat(derivedStats, playerId, statType)
      const startGameStat =
        asNumber(context.startGameStat) ?? asNumber(context.initialValue)
      const deltaStat =
        currentGameStat !== null &&
        startGameStat !== null &&
        Number.isFinite(currentGameStat) &&
        Number.isFinite(startGameStat)
          ? Math.max(0, currentGameStat - startGameStat)
          : null
      const target = asNumber(context.target)
      if (target !== null && deltaStat !== null && deltaStat >= target)
        return { state: 'resolved', answer: 'yes' }
      if (periodStatsReady) {
        if (deltaStat !== null) return { state: 'resolved', answer: 'no' }
        if (deferPeriodFinalization) return null
        return { state: 'cancelled', answer: null }
      }
      return null
    }
    case 'PLAYER_COMPARE_PERIOD': {
      if (!periodStatsReady) return null
      const statType = asString(context.statType) ?? ''
      const playerIds = asNumberArray(context.playerIds) ?? []
      const startPlayerGameStats = asRecordNumber(context.startPlayerGameStats)
      const period = asNumber(context.endPeriod) ?? startPeriod ?? currentPeriod
      if (!period || playerIds.length < 2)
        return { state: 'cancelled', answer: null }
      let bestId: string | null = null
      let bestValue: number | null = null
      let tie = false
      for (const id of playerIds) {
        const player = getPlayerFromBoxScore(boxScore, Number(id))
        const currentGameStat =
          (USE_OFFICIAL_CUMULATIVE_RESOLUTION
            ? getOfficialCumulativePlayerStat(event, Number(id), statType)
            : null) ??
          getPlayerGameStat(player, statType) ??
          getDerivedPlayerStat(derivedStats, Number(id), statType)
        const startGameStat = startPlayerGameStats?.[String(id)]
        const deltaStat =
          currentGameStat !== null &&
          startGameStat !== undefined &&
          Number.isFinite(currentGameStat) &&
          Number.isFinite(startGameStat)
            ? Math.max(0, currentGameStat - startGameStat)
            : null
        if (deltaStat === null || Number.isNaN(deltaStat)) continue
        const stat = deltaStat
        if (bestValue === null || stat > bestValue) {
          bestValue = stat
          bestId = String(id)
          tie = false
        } else if (stat === bestValue) {
          tie = true
        }
      }
      if (!bestId || bestValue === null)
        return deferPeriodFinalization
          ? null
          : { state: 'cancelled', answer: null }
      if (tie) return { state: 'cancelled', answer: null, reason: 'TIE' }
      return { state: 'resolved', answer: bestId }
    }
    case 'PLAYER_COMPARE_NEXT_N': {
      if (!windowExpired && !gameEnded) return null
      const statType = asString(context.statType) ?? ''
      const playerIds = asNumberArray(context.playerIds) ?? []
      const startStats = asRecordNumber(context.startPlayerStats)
      if (playerIds.length < 2) return { state: 'cancelled', answer: null }
      let bestId: string | null = null
      let bestValue: number | null = null
      let tie = false
      for (const id of playerIds) {
        const player = getPlayerFromBoxScore(boxScore, Number(id))
        const current =
          getDerivedPlayerStat(derivedStats, Number(id), statType) ??
          getPlayerGameStat(player, statType)
        if (current === null || Number.isNaN(current)) continue
        const start = startStats?.[String(id)]
        const delta =
          typeof start === 'number' && Number.isFinite(start)
            ? current - start
            : current
        if (bestValue === null || delta > bestValue) {
          bestValue = delta
          bestId = String(id)
          tie = false
        } else if (delta === bestValue) {
          tie = true
        }
      }
      if (!bestId || bestValue === null)
        return { state: 'cancelled', answer: null }
      if (tie) return { state: 'cancelled', answer: null, reason: 'TIE' }
      return { state: 'resolved', answer: bestId }
    }
    case 'TEAM_SCORE_AFTER_TIMEOUT': {
      if (windowExpired) return { state: 'resolved', answer: 'no' }
      if (!isScoringEvent(event.type)) return null
      const teamSide = resolveTeamSide(event, boxScore, context)
      if (!teamSide) return null
      const expectedTeam = resolveTeamSideByTricode(
        boxScore,
        asString(context.teamTricode)
      )
      if (expectedTeam && teamSide !== expectedTeam) return null
      return { state: 'resolved', answer: 'yes' }
    }
    case 'TEAM_SCORE_AFTER_FREETHROWS': {
      if (!isScoringEvent(event.type)) return null
      const teamSide = resolveTeamSide(event, boxScore, context)
      if (!teamSide) return null
      const expectedTeam = resolveTeamSideByTricode(
        boxScore,
        asString(context.teamTricode)
      )
      if (!expectedTeam) return null
      return {
        state: 'resolved',
        answer: teamSide === expectedTeam ? 'yes' : 'no',
      }
    }
    case 'NEXT_SCORE_TEAM': {
      if (!isScoringEvent(event.type)) {
        if (windowExpired) return { state: 'cancelled', answer: null }
        return null
      }
      if (
        asBoolean(context.ignoreFreeThrows) &&
        event.type === EventType.MADE_FT
      ) {
        return null
      }
      const teamSide = resolveTeamSide(event, boxScore, context)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        state: 'resolved',
        answer: teamSide === 'HOME' ? homeTricode : awayTricode,
      }
    }
    case 'BUZZER_BEATER_TIMEOUT': {
      if (periodFinished) return { state: 'resolved', answer: 'no' }
      const teamSide = resolveTeamSideByTricode(
        boxScore,
        asString(context.teamTricode)
      )
      if (!teamSide) return { state: 'cancelled', answer: null }
      if (event.type !== EventType.MADE_FG && event.type !== EventType.MADE_3)
        return null
      const scoringSide = resolveTeamSide(event, boxScore, context)
      if (!scoringSide) return null
      return scoringSide === teamSide
        ? { state: 'resolved', answer: 'yes' }
        : null
    }
    case 'NEXT_DUNK_TEAM': {
      if (gameEnded) return { state: 'cancelled', answer: null }
      if (windowExpired) return { state: 'cancelled', answer: null }
      if (event.type !== EventType.MADE_FG && event.type !== EventType.MADE_3) {
        return null
      }
      if (event.subType !== NbaEventSubType.DUNK) return null
      const teamSide = resolveTeamSide(event, boxScore, context)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        state: 'resolved',
        answer: teamSide === 'HOME' ? homeTricode : awayTricode,
      }
    }
    case 'NEXT_DUNK_PLAYER': {
      if (gameEnded) return { state: 'cancelled', answer: null }
      if (windowExpired) return { state: 'cancelled', answer: null }
      if (event.type !== EventType.MADE_FG && event.type !== EventType.MADE_3) {
        return null
      }
      if (event.subType !== NbaEventSubType.DUNK) return null
      const playerId = getEventPlayerId(event)
      if (!playerId) return null
      const choices = asChoiceArray(context.choices)
      if (choices && !choices.some((choice) => Number(choice.id) === playerId))
        return null
      return { state: 'resolved', answer: String(playerId) }
    }
    case 'NEXT_EVENT': {
      const expected = asString(context.expectedEventType) ?? ''
      if (!expected) return null
      if (asBoolean(context.cancelOnGameEnd) && gameEnded) {
        if (event.type !== EventType.GAME_END) return null
        return {
          state: isShotAttemptExpectation(expected) ? 'cancelled' : 'resolved',
          answer: isShotAttemptExpectation(expected) ? null : 'no',
          reason: isShotAttemptExpectation(expected) ? 'NO_ATTEMPT' : undefined,
        }
      }
      const expectedSubType = asString(context.expectedSubType)
      const eventSubType =
        typeof event.subType === 'string' ? event.subType : null
      const subTypeMatches =
        !expectedSubType || expectedSubType === eventSubType
      const playerId = asNumber(context.playerId)
      const teamTricode = asString(context.teamTricode)
      if (playerId) {
        const evtPlayerId = getEventPlayerId(event)
        if (evtPlayerId !== playerId) return null
      }
      if (teamTricode) {
        const evtTeamTricode = normalizeCode(getEventTeamTricode(event))
        if (normalizeCode(teamTricode) !== evtTeamTricode) return null
      }
      if (matchesExpectedEvent(event.type, expected)) {
        if (!subTypeMatches) return { state: 'resolved', answer: 'no' }
        return { state: 'resolved', answer: 'yes' }
      }
      if (isMissForExpected(event.type, expected))
        return { state: 'resolved', answer: 'no' }
      if (windowExpired) {
        if (isShotAttemptExpectation(expected)) {
          return { state: 'cancelled', answer: null, reason: 'NO_ATTEMPT' }
        }
        return { state: 'resolved', answer: 'no' }
      }
      return null
    }
    case 'LEAD_CHANGE_REST_GAME': {
      const startLeader = asString(context.leader)
      if (!startLeader || startLeader === 'TIE') {
        if (gameEnded) return { state: 'cancelled', answer: null }
        return null
      }
      if (homeScore === null || awayScore === null) return null
      const leader =
        homeScore === awayScore
          ? 'TIE'
          : homeScore > awayScore
            ? 'HOME'
            : 'AWAY'
      if (leader !== 'TIE' && leader !== startLeader)
        return { state: 'resolved', answer: 'yes' }
      if (gameEnded) return { state: 'resolved', answer: 'no' }
      return null
    }
    case 'GAME_POINTS_PACE': {
      if (event.type !== EventType.GAME_END) return null
      if (!gameEnded) return null
      const currentTotal = (homeScore ?? 0) + (awayScore ?? 0)
      const paceTotal = asNumber(context.paceTotal)
      if (paceTotal === null) return { state: 'cancelled', answer: null }
      return {
        state: 'resolved',
        answer: currentTotal >= paceTotal ? 'yes' : 'no',
      }
    }
    case 'OVERTIME': {
      if (event.type !== EventType.GAME_END) return null
      if (!gameEnded) return null
      const period = boxScore?.period ?? boxScore?.game?.period ?? null
      const statusText = String(
        boxScore?.gameStatusText ?? boxScore?.game?.gameStatusText ?? ''
      ).toLowerCase()
      const wentToOt =
        (typeof period === 'number' && period > 4) || statusText.includes('ot')
      return {
        state: 'resolved',
        answer: wentToOt ? 'yes' : 'no',
      }
    }
    case 'GAME_WINNER': {
      if (!gameEnded) return null
      if (homeScore === null || awayScore === null)
        return { state: 'cancelled', answer: null }
      if (homeScore === awayScore)
        return { state: 'cancelled', answer: null, reason: 'TIE' }
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        state: 'resolved',
        answer: homeScore > awayScore ? homeTricode : awayTricode,
      }
    }
    case 'TEAM_WINS_GAME': {
      if (!gameEnded) return null
      if (homeScore === null || awayScore === null)
        return { state: 'cancelled', answer: null }
      if (homeScore === awayScore)
        return { state: 'cancelled', answer: null, reason: 'TIE' }
      const teamTricode = normalizeTricode(asString(context.teamTricode))
      if (!teamTricode) return { state: 'cancelled', answer: null }
      const teamSide = resolveTeamSideByTricode(boxScore, teamTricode)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const winner = homeScore > awayScore ? 'HOME' : 'AWAY'
      return { state: 'resolved', answer: winner === teamSide ? 'yes' : 'no' }
    }
    case 'JUMP_BALL_WINNER': {
      if (event.type !== EventType.JUMP_BALL) return null
      const teamSide = resolveTeamSide(event, boxScore, context)
      if (!teamSide) return { state: 'cancelled', answer: null }
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        state: 'resolved',
        answer: teamSide === 'HOME' ? homeTricode : awayTricode,
      }
    }
    default:
      break
  }
  if (gameEnded) return { state: 'cancelled', answer: null }
  return null
}
