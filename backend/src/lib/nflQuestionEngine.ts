import type { EngineQuestionPayload, ResolutionContext } from './engine'
import type { EspnNflAthleteName, EspnNflPlay } from './nfl'

export const NFL_QUESTION_RESPONSE_MS = 30_000
export const NFL_QUESTION_MIN_INTERVAL_MS = 180_000
export const NFL_QUESTION_MAX_SOURCE_AGE_MS = 15_000
export const NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS = 90_000
export const NFL_DRIVE_QUESTION_MIN_AGE_MS = 60_000
export const NFL_MAX_QUESTIONS_PER_GAME = 20
export const NFL_MAX_TEMPLATE_USES_PER_GAME = 2
export const NFL_TEMPLATE_COOLDOWN_MS = 6 * 60_000

export type NflQuestionPriority =
  | 'GAME'
  | 'PERIOD_TEAM'
  | 'PERIOD_PLAYER'
  | 'RED_ZONE'
  | 'FOURTH_DOWN'
  | 'NEXT_COMPLETION_RECEIVER'
  | 'DRIVE_OUTCOME'
  | 'NEXT_FIRST_DOWN'
  | 'TIMEOUT_NEXT_PLAY'

export type NflQuestionSourceAgePolicy = 'OBSERVE' | 'ENFORCE'

export type NflQuestionCandidate = {
  payload: EngineQuestionPayload
  priority: NflQuestionPriority
  redZoneDriveId: string | null
  redZonePeriodKey: string | null
  receiverQuestionKey: string | null
  completionReceiverHalfKey: string | null
  timeoutQuestionDriveId: string | null
  gameQuestionKey: string | null
  periodQuestionKey: string | null
}

export type NflQuestionCandidateSkipReason =
  | 'NO_LATEST_PLAY'
  | 'ANCHOR_NOT_LATEST'
  | 'NO_CANDIDATE'
  | 'MISSING_SOURCE_WALLCLOCK'
  | 'SOURCE_CLOCK_IN_FUTURE'
  | 'SOURCE_TOO_OLD'

export type NflQuestionCandidateDecision = {
  candidate: NflQuestionCandidate | null
  priority: NflQuestionPriority | null
  sourceAgeMs: number | null
  maxSourceAgeMs: number | null
  skipReason: NflQuestionCandidateSkipReason | null
}

export type NflActiveQuestion = {
  id: string
  templateId: string
  windowType: EngineQuestionPayload['windowType']
  resolutionContext: ResolutionContext
  createdAtMs: number
}

export type NflQuestionDecision =
  | { state: 'resolved'; answer: string; reason: null }
  | { state: 'cancelled'; answer: null; reason: string }

type BuildCandidateInput = {
  plays: EspnNflPlay[]
  anchorPlay: EspnNflPlay
  homeTeam: string
  awayTeam: string
  nowMs: number
  redZoneAskedDriveIds: readonly string[]
  redZoneAskedPeriodKeys: readonly string[]
  receiverQuestionKeys: readonly string[]
  completionReceiverHalfKeys: readonly string[]
  timeoutQuestionDriveIds: readonly string[]
  gameQuestionKeys: readonly string[]
  periodQuestionKeys: readonly string[]
  athletes: readonly EspnNflAthleteName[]
  templateUseCounts?: Readonly<Record<string, number>>
  templateLastUsedAtMs?: Readonly<Record<string, number>>
  allowShortHorizonQuestions?: boolean
  sourceAgePolicy?: NflQuestionSourceAgePolicy
}

type NflPeriodTeamStat = {
  points: number
  passingYards: number
  rushingYards: number
}

type NflPeriodPlayerStat = {
  token: string
  passingAttempts: number
  passingYards: number
  rushingAttempts: number
  rushingYards: number
  receivingTargets: number
  receptions: number
}

export type NflPeriodStats = {
  teams: Map<string, NflPeriodTeamStat>
  players: Map<string, NflPeriodPlayerStat>
}

export type NflPeriodPlayerThresholdStatType =
  | 'PASSING_YARDS'
  | 'RUSHING_YARDS'
  | 'RECEPTIONS'

export type NflPeriodPlayerThresholdProjection = {
  target: number
  projectedPeriodTotal: number
  priorSeasonYear: number | null
  priorSeasonGames: number | null
  priorSeasonAveragePerGame: number | null
  historicalExpectedRemaining: number | null
  fallbackExpectedRemaining: number | null
  liveExpectedRemaining: number
  projectionSource: 'PRIOR_SEASON_LIVE_BLEND' | 'POSITION_BASELINE_LIVE_BLEND'
}

export type NflPeriodPlayerThresholdProjectionInput = {
  statType: NflPeriodPlayerThresholdStatType
  currentValue: number
  clockRemainingMs: number
  athlete: EspnNflAthleteName
}

export type NflStatRange = {
  choices: { id: string; value: string }[]
  cutoffs: number[]
  bucketWidth: number
}

const TERMINAL_PLAY_PATTERN =
  /touchdown|field goal|punt|interception|end period|end of game/i
const STOPPAGE_PLAY_PATTERN = /timeout|two-minute warning/i
const PASS_PLAY_PATTERN = /pass|sack|interception/i
const RUSH_PLAY_PATTERN = /rush/i
const FIELD_GOAL_GOOD_PATTERN = /field goal good/i
const PASS_COMPLETION_PATTERN = /pass reception|passing touchdown/i
const PASS_INCOMPLETE_PATTERN = /pass incompletion|interception/i
const NO_PLAY_PATTERN = /no play/i
const TARGET_PATTERN =
  /\bpass\b[\s\S]*?\bto\s+([A-Za-z]{1,3}\.[A-Za-z][A-Za-z.'-]*(?:\s+(?:Jr\.|Sr\.|II|III|IV))?)/i
const LEADING_PLAYER_PATTERN =
  /^\s*(?:\([^)]*\)\s*)*([A-Za-z]{1,3}\.[A-Za-z][A-Za-z.'-]*(?:\s+(?:Jr\.|Sr\.|II|III|IV))?)/i

const asContextString = (
  context: ResolutionContext,
  key: string
): string | null => {
  const value = context[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const asContextNumber = (
  context: ResolutionContext,
  key: string
): number | null => {
  const value = context[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const asContextStringRecord = (
  context: ResolutionContext,
  key: string
): Record<string, string> | null => {
  const value = context[key]
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const entries = Object.entries(value)
  if (!entries.every((entry) => typeof entry[1] === 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

const asContextNumberArray = (
  context: ResolutionContext,
  key: string
): number[] | null => {
  const value = context[key]
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? (value as number[])
    : null
}

const parseClockMs = (clock: string | null): number => {
  if (!clock) return 0
  const match = /^(\d+):(\d{2})$/.exec(clock.trim())
  if (!match) return 0
  return Number(match[1]) * 60_000 + Number(match[2]) * 1_000
}

const NFL_PERIOD_MS = 15 * 60_000

const getPriorSeasonStatBaseline = (
  athlete: EspnNflAthleteName,
  statType: NflPeriodPlayerThresholdStatType
): {
  seasonYear: number
  games: number
  averagePerGame: number
} | null => {
  const profile = athlete.priorSeasonProfile
  if (!profile) return null
  if (statType === 'PASSING_YARDS') {
    return {
      seasonYear: profile.seasonYear,
      games: profile.passingGames,
      averagePerGame: profile.passingYardsPerGame,
    }
  }
  if (statType === 'RUSHING_YARDS') {
    return {
      seasonYear: profile.seasonYear,
      games: profile.rushingGames,
      averagePerGame: profile.rushingYardsPerGame,
    }
  }
  return {
    seasonYear: profile.seasonYear,
    games: profile.receivingGames,
    averagePerGame: profile.receptionsPerGame,
  }
}

const getPeriodProjectionCeiling = (
  statType: NflPeriodPlayerThresholdStatType
): number => {
  if (statType === 'PASSING_YARDS') return 125
  if (statType === 'RUSHING_YARDS') return 60
  return 5
}

const getMinimumExpectedRemaining = (
  statType: NflPeriodPlayerThresholdStatType
): number => {
  if (statType === 'PASSING_YARDS') return 8
  if (statType === 'RUSHING_YARDS') return 3
  return 0.45
}

const getFallbackAveragePerGame = (
  statType: NflPeriodPlayerThresholdStatType
): number => {
  if (statType === 'PASSING_YARDS') return 200
  if (statType === 'RUSHING_YARDS') return 45
  return 3
}

const roundPeriodPlayerTarget = (
  statType: NflPeriodPlayerThresholdStatType,
  currentValue: number,
  projectedPeriodTotal: number
): number => {
  if (statType === 'RECEPTIONS') {
    return Math.max(currentValue + 1, Math.floor(projectedPeriodTotal))
  }
  const increment = 5
  const minimumIncrease = statType === 'PASSING_YARDS' ? 10 : 5
  const minimumTarget =
    Math.ceil((currentValue + minimumIncrease) / increment) * increment
  const rounded = Math.floor(projectedPeriodTotal / increment) * increment
  return Math.max(rounded, minimumTarget)
}

export const projectNflPeriodPlayerThreshold = (
  input: NflPeriodPlayerThresholdProjectionInput
): NflPeriodPlayerThresholdProjection | null => {
  const clockRemainingMs = Math.min(
    NFL_PERIOD_MS,
    Math.max(0, input.clockRemainingMs)
  )
  const remainingFraction = clockRemainingMs / NFL_PERIOD_MS
  const elapsedFraction = Math.max(0.25, 1 - remainingFraction)
  const livePeriodProjection = Math.min(
    input.currentValue / elapsedFraction,
    getPeriodProjectionCeiling(input.statType)
  )
  const liveExpectedRemaining = Math.max(
    0,
    livePeriodProjection - input.currentValue
  )
  const priorSeason = getPriorSeasonStatBaseline(input.athlete, input.statType)
  const usePriorSeason =
    priorSeason !== null &&
    priorSeason.games >= 4 &&
    priorSeason.averagePerGame > 0
  const historicalExpectedRemaining = usePriorSeason
    ? (priorSeason.averagePerGame / 4) * remainingFraction
    : null
  const fallbackExpectedRemaining = usePriorSeason
    ? null
    : (getFallbackAveragePerGame(input.statType) / 4) * remainingFraction
  const expectedRemaining = historicalExpectedRemaining
    ? historicalExpectedRemaining * 0.65 + liveExpectedRemaining * 0.35
    : (fallbackExpectedRemaining ?? 0) * 0.75 + liveExpectedRemaining * 0.25
  if (expectedRemaining < getMinimumExpectedRemaining(input.statType)) {
    return null
  }

  const projectedPeriodTotal = input.currentValue + expectedRemaining
  const targetBasis = input.currentValue + expectedRemaining * 0.8
  return {
    target: roundPeriodPlayerTarget(
      input.statType,
      input.currentValue,
      targetBasis
    ),
    projectedPeriodTotal,
    priorSeasonYear: priorSeason?.seasonYear ?? null,
    priorSeasonGames: priorSeason?.games ?? null,
    priorSeasonAveragePerGame: priorSeason?.averagePerGame ?? null,
    historicalExpectedRemaining,
    fallbackExpectedRemaining,
    liveExpectedRemaining,
    projectionSource: usePriorSeason
      ? 'PRIOR_SEASON_LIVE_BLEND'
      : 'POSITION_BASELINE_LIVE_BLEND',
  }
}

const getStatRangeBucketWidth = (
  statType: NflPeriodPlayerThresholdStatType,
  expectedRemaining: number
): number => {
  if (statType === 'RECEPTIONS') return 1
  const minimum = statType === 'PASSING_YARDS' ? 10 : 5
  const maximum = statType === 'PASSING_YARDS' ? 25 : 15
  const rounded = Math.ceil(expectedRemaining / 2 / 5) * 5
  return Math.min(maximum, Math.max(minimum, rounded))
}

export const buildNflStatRange = (
  statType: NflPeriodPlayerThresholdStatType,
  currentValue: number,
  projectedTotal: number
): NflStatRange => {
  const normalizedCurrent = Math.max(0, Math.floor(currentValue))
  const expectedRemaining = Math.max(0, projectedTotal - normalizedCurrent)
  const bucketWidth = getStatRangeBucketWidth(statType, expectedRemaining)
  const firstCutoff =
    Math.floor(normalizedCurrent / bucketWidth) * bucketWidth + bucketWidth - 1
  const cutoffs = [
    firstCutoff,
    firstCutoff + bucketWidth,
    firstCutoff + bucketWidth * 2,
  ]
  const pluralize = (value: number): string =>
    `${value} ${
      statType === 'RECEPTIONS'
        ? value === 1
          ? 'catch'
          : 'catches'
        : value === 1
          ? 'yard'
          : 'yards'
    }`
  const rangeUnit = statType === 'RECEPTIONS' ? 'catches' : 'yards'
  const formatRange = (lower: number, upper: number): string =>
    lower === upper ? pluralize(lower) : `${lower}-${upper} ${rangeUnit}`
  return {
    bucketWidth,
    cutoffs,
    choices: [
      { id: 'range_0', value: `${pluralize(cutoffs[0])} or fewer` },
      {
        id: 'range_1',
        value: formatRange(cutoffs[0] + 1, cutoffs[1]),
      },
      {
        id: 'range_2',
        value: formatRange(cutoffs[1] + 1, cutoffs[2]),
      },
      {
        id: 'range_3',
        value: `${pluralize(cutoffs[2] + 1)} or more`,
      },
    ],
  }
}

const getRangeAnswer = (value: number, cutoffs: readonly number[]): string => {
  const bucketIndex = cutoffs.findIndex((cutoff) => value <= cutoff)
  return `range_${bucketIndex < 0 ? cutoffs.length : bucketIndex}`
}

export const getNflPlayWallclockMs = (play: EspnNflPlay): number | null => {
  if (!play.wallclock) return null
  const parsed = Date.parse(play.wallclock)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeTarget = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')

const stripNameSuffix = (value: string): string =>
  value.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV)$/i, '')

const formatTarget = (value: string): string => {
  const trimmed = value.replace(/[.,]+$/, '')
  const dotIndex = trimmed.indexOf('.')
  if (dotIndex < 0) return trimmed
  return `${trimmed.slice(0, dotIndex + 1)} ${trimmed.slice(dotIndex + 1)}`
}

const findAthleteForToken = (
  target: string,
  teamId: string | null,
  athletes: readonly EspnNflAthleteName[]
): EspnNflAthleteName | null => {
  const trimmed = target.replace(/[.,]+$/, '')
  const dotIndex = trimmed.indexOf('.')
  if (dotIndex <= 0) return null
  const firstNamePrefix = normalizeTarget(trimmed.slice(0, dotIndex))
  const targetLastName = normalizeTarget(
    stripNameSuffix(trimmed.slice(dotIndex + 1))
  )
  const matches = athletes.filter(
    (athlete) =>
      (!teamId || athlete.teamId === teamId) &&
      normalizeTarget(stripNameSuffix(athlete.lastName)) === targetLastName &&
      normalizeTarget(athlete.firstName).startsWith(firstNamePrefix)
  )
  return matches.length === 1 ? matches[0] : null
}

const findTargetDisplayName = (
  target: string,
  teamId: string | null,
  athletes: readonly EspnNflAthleteName[]
): string => {
  const athlete = findAthleteForToken(target, teamId, athletes)
  return athlete?.displayName ?? formatTarget(target)
}

export const extractNflPassTarget = (play: EspnNflPlay): string | null => {
  if (!PASS_PLAY_PATTERN.test(play.type)) return null
  const match = TARGET_PATTERN.exec(play.text)
  return match?.[1]?.replace(/[.,]+$/, '') ?? null
}

export const extractNflPasser = (play: EspnNflPlay): string | null => {
  if (
    !/pass reception|pass incompletion|passing touchdown|interception/i.test(
      play.type
    )
  ) {
    return null
  }
  return (
    LEADING_PLAYER_PATTERN.exec(play.text)?.[1]?.replace(/[.,]+$/, '') ?? null
  )
}

export const extractNflRusher = (play: EspnNflPlay): string | null => {
  if (!RUSH_PLAY_PATTERN.test(play.type)) return null
  return (
    LEADING_PLAYER_PATTERN.exec(play.text)?.[1]?.replace(/[.,]+$/, '') ?? null
  )
}

const ensureTeamPeriodStat = (
  stats: Map<string, NflPeriodTeamStat>,
  teamCode: string
): NflPeriodTeamStat => {
  const existing = stats.get(teamCode)
  if (existing) return existing
  const created = { points: 0, passingYards: 0, rushingYards: 0 }
  stats.set(teamCode, created)
  return created
}

const ensurePlayerPeriodStat = (
  stats: Map<string, NflPeriodPlayerStat>,
  token: string
): NflPeriodPlayerStat => {
  const key = normalizeTarget(token)
  const existing = stats.get(key)
  if (existing) return existing
  const created = {
    token,
    passingAttempts: 0,
    passingYards: 0,
    rushingAttempts: 0,
    rushingYards: 0,
    receivingTargets: 0,
    receptions: 0,
  }
  stats.set(key, created)
  return created
}

export const getNflPeriodStats = (
  plays: readonly EspnNflPlay[],
  period: number,
  homeTeam: string,
  awayTeam: string
): NflPeriodStats => {
  const teams = new Map<string, NflPeriodTeamStat>()
  const players = new Map<string, NflPeriodPlayerStat>()
  const homeStats = ensureTeamPeriodStat(teams, homeTeam)
  const awayStats = ensureTeamPeriodStat(teams, awayTeam)
  let baselineHomeScore = 0
  let baselineAwayScore = 0
  let finalHomeScore = 0
  let finalAwayScore = 0

  for (const play of plays) {
    if (
      typeof play.period === 'number' &&
      play.period < period &&
      typeof play.homeScore === 'number' &&
      typeof play.awayScore === 'number'
    ) {
      baselineHomeScore = play.homeScore
      baselineAwayScore = play.awayScore
      finalHomeScore = play.homeScore
      finalAwayScore = play.awayScore
    }
    if (play.period !== period) continue
    if (typeof play.homeScore === 'number') finalHomeScore = play.homeScore
    if (typeof play.awayScore === 'number') finalAwayScore = play.awayScore
    if (
      play.penalty ||
      NO_PLAY_PATTERN.test(play.text) ||
      !play.driveTeamAbbreviation
    ) {
      continue
    }

    const teamStats = ensureTeamPeriodStat(teams, play.driveTeamAbbreviation)
    const yards = play.statYardage ?? 0
    const passer = extractNflPasser(play)
    const target = extractNflPassTarget(play)
    if (passer) ensurePlayerPeriodStat(players, passer).passingAttempts += 1
    if (target) ensurePlayerPeriodStat(players, target).receivingTargets += 1
    if (PASS_COMPLETION_PATTERN.test(play.type)) {
      teamStats.passingYards += yards
      if (passer) ensurePlayerPeriodStat(players, passer).passingYards += yards
      if (target) ensurePlayerPeriodStat(players, target).receptions += 1
    } else if (RUSH_PLAY_PATTERN.test(play.type)) {
      teamStats.rushingYards += yards
      const rusher = extractNflRusher(play)
      if (rusher) {
        const rusherStat = ensurePlayerPeriodStat(players, rusher)
        rusherStat.rushingAttempts += 1
        rusherStat.rushingYards += yards
      }
    }
  }

  homeStats.points = Math.max(0, finalHomeScore - baselineHomeScore)
  awayStats.points = Math.max(0, finalAwayScore - baselineAwayScore)
  return { teams, players }
}

export const getNflDrivePlayerStats = (
  plays: readonly EspnNflPlay[],
  driveId: string
): Map<string, NflPeriodPlayerStat> => {
  const players = new Map<string, NflPeriodPlayerStat>()
  for (const play of plays) {
    if (
      play.driveId !== driveId ||
      play.penalty ||
      NO_PLAY_PATTERN.test(play.text)
    ) {
      continue
    }
    const yards = play.statYardage ?? 0
    const passer = extractNflPasser(play)
    const target = extractNflPassTarget(play)
    if (passer) ensurePlayerPeriodStat(players, passer).passingAttempts += 1
    if (target) ensurePlayerPeriodStat(players, target).receivingTargets += 1
    if (PASS_COMPLETION_PATTERN.test(play.type)) {
      if (passer) ensurePlayerPeriodStat(players, passer).passingYards += yards
      if (target) ensurePlayerPeriodStat(players, target).receptions += 1
    } else if (RUSH_PLAY_PATTERN.test(play.type)) {
      const rusher = extractNflRusher(play)
      if (rusher) {
        const rusherStat = ensurePlayerPeriodStat(players, rusher)
        rusherStat.rushingAttempts += 1
        rusherStat.rushingYards += yards
      }
    }
  }
  return players
}

const getPreviousDrivePlay = (
  plays: EspnNflPlay[],
  anchorPlay: EspnNflPlay
): EspnNflPlay | null => {
  if (!anchorPlay.driveId) return null
  const anchorIndex = plays.findIndex((play) => play.id === anchorPlay.id)
  if (anchorIndex <= 0) return null
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const play = plays[index]
    if (play.driveId === anchorPlay.driveId) return play
  }
  return null
}

const getDriveAgeMs = (
  plays: readonly EspnNflPlay[],
  anchorPlay: EspnNflPlay
): number | null => {
  if (!anchorPlay.driveId) return null
  const anchorWallclockMs = getNflPlayWallclockMs(anchorPlay)
  if (anchorWallclockMs === null) return null
  const firstDriveWallclockMs = plays
    .filter((play) => play.driveId === anchorPlay.driveId)
    .map(getNflPlayWallclockMs)
    .find((wallclockMs) => wallclockMs !== null)
  return firstDriveWallclockMs === undefined || firstDriveWallclockMs === null
    ? null
    : anchorWallclockMs - firstDriveWallclockMs
}

const hasStableDriveContext = (input: BuildCandidateInput): boolean => {
  const ageMs = getDriveAgeMs(input.plays, input.anchorPlay)
  return ageMs !== null && ageMs >= NFL_DRIVE_QUESTION_MIN_AGE_MS
}

const getDriveTeamCode = (play: EspnNflPlay): string | null =>
  play.driveTeamAbbreviation || null

const possessionStayedWithDriveTeam = (
  play: EspnNflPlay,
  previousPlay: EspnNflPlay
): boolean => {
  const driveTeamId = play.driveTeamId
  const nextPossessionTeamId = previousPlay.end?.teamId
  return !(
    driveTeamId &&
    nextPossessionTeamId &&
    driveTeamId !== nextPossessionTeamId
  )
}

const getMaxSourceAgeMs = (priority: NflQuestionPriority): number => {
  if (
    priority === 'GAME' ||
    priority === 'PERIOD_TEAM' ||
    priority === 'PERIOD_PLAYER'
  ) {
    return NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS
  }
  return NFL_QUESTION_MAX_SOURCE_AGE_MS
}

const isLongHorizonPriority = (priority: NflQuestionPriority): boolean =>
  priority === 'GAME' ||
  priority === 'PERIOD_TEAM' ||
  priority === 'PERIOD_PLAYER'

const isDriveTerminalPlay = (play: EspnNflPlay): boolean =>
  play.turnover || play.scoringPlay || TERMINAL_PLAY_PATTERN.test(play.type)

const buildBaseContext = (
  input: BuildCandidateInput,
  type: string
): ResolutionContext => ({
  type,
  anchorPlayId: input.anchorPlay.id,
  driveId: input.anchorPlay.driveId,
  teamId:
    input.anchorPlay.driveTeamId ?? input.anchorPlay.possessionTeamId ?? null,
  teamCode: getDriveTeamCode(input.anchorPlay),
  homeTricode: input.homeTeam,
  awayTricode: input.awayTeam,
})

const buildPayload = (
  input: BuildCandidateInput,
  candidate: {
    templateId: string
    question: string
    windowType: EngineQuestionPayload['windowType']
    resolutionWindowMs: number
    resolutionContext: ResolutionContext
    trigger: string
  }
): EngineQuestionPayload => ({
  ...candidate,
  timeoutMs: NFL_QUESTION_RESPONSE_MS,
  selectionReason: [
    { code: 'NFL_LATEST_PROVIDER_PLAY', detail: input.anchorPlay.id },
  ],
  period: input.anchorPlay.period ?? 0,
  clockMs: parseClockMs(input.anchorPlay.clock),
})

const getPeriodLabel = (period: number): string => {
  if (period === 1) return 'first quarter'
  if (period === 2) return 'second quarter'
  if (period === 3) return 'third quarter'
  if (period === 4) return 'fourth quarter'
  return `period ${period}`
}

const getTemplateUseCount = (
  input: BuildCandidateInput,
  templateId: string
): number => input.templateUseCounts?.[templateId] ?? 0

const isTemplateCoolingDown = (
  input: BuildCandidateInput,
  templateId: string
): boolean => {
  const lastUsedAtMs = input.templateLastUsedAtMs?.[templateId]
  return (
    typeof lastUsedAtMs === 'number' &&
    input.nowMs - lastUsedAtMs < NFL_TEMPLATE_COOLDOWN_MS
  )
}

const hasPeriodQuestion = (
  input: BuildCandidateInput,
  period: number
): boolean =>
  input.periodQuestionKeys.some(
    (key) =>
      key === `period:${period}` ||
      key === `team:${period}` ||
      key === `player:${period}`
  )

const getMatchupRotation = (input: BuildCandidateInput): number => {
  const value = `${input.awayTeam}:${input.homeTeam}`
  let hash = 0
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647
  }
  return hash
}

const isTeamPeriodSlot = (
  input: BuildCandidateInput,
  period: number
): boolean => (period + getMatchupRotation(input)) % 2 === 0

const chooseLeastUsedTemplate = <Template extends { templateId: string }>(
  input: BuildCandidateInput,
  templates: readonly Template[],
  rotation = 0
): Template | null => {
  const available = templates.filter(
    (template) =>
      getTemplateUseCount(input, template.templateId) <
        NFL_MAX_TEMPLATE_USES_PER_GAME &&
      !isTemplateCoolingDown(input, template.templateId)
  )
  if (available.length === 0) return null
  const lowestUseCount = Math.min(
    ...available.map((template) =>
      getTemplateUseCount(input, template.templateId)
    )
  )
  const leastUsed = available.filter(
    (template) =>
      getTemplateUseCount(input, template.templateId) === lowestUseCount
  )
  return leastUsed[Math.abs(rotation) % leastUsed.length] ?? null
}

export const buildNflPregameGameWinnerPayload = (
  homeTeam: string,
  awayTeam: string
): EngineQuestionPayload => ({
  templateId: 'NFL_GAME_WINNER',
  question: 'What will the game result be?',
  windowType: 'GAME',
  timeoutMs: NFL_QUESTION_RESPONSE_MS,
  resolutionWindowMs: 4 * 60 * 60_000,
  resolutionContext: {
    type: 'NFL_GAME_WINNER',
    anchorPlayId: 'pregame',
    homeTricode: homeTeam,
    awayTricode: awayTeam,
    choices: [
      { id: homeTeam, value: homeTeam },
      { id: awayTeam, value: awayTeam },
      { id: 'tie', value: 'Tie' },
    ],
  },
  selectionReason: [{ code: 'NFL_PREGAME_WINDOW' }],
  trigger: 'nfl:game_start',
  period: 0,
  clockMs: 0,
})

const buildGameWinnerCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  if (
    input.gameQuestionKeys.includes('winner') ||
    (input.anchorPlay.period ?? 1) > 1 ||
    !input.homeTeam ||
    !input.awayTeam
  ) {
    return null
  }
  return {
    priority: 'GAME',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: null,
    gameQuestionKey: 'winner',
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_GAME_WINNER',
      question: 'What will the game result be?',
      windowType: 'GAME',
      resolutionWindowMs: 4 * 60 * 60_000,
      resolutionContext: {
        type: 'NFL_GAME_WINNER',
        anchorPlayId: input.anchorPlay.id,
        homeTricode: input.homeTeam,
        awayTricode: input.awayTeam,
        choices: [
          { id: input.homeTeam, value: input.homeTeam },
          { id: input.awayTeam, value: input.awayTeam },
          { id: 'tie', value: 'Tie' },
        ],
      },
      trigger: 'nfl:game_start',
    }),
  }
}

const buildPeriodTeamCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const period = input.anchorPlay.period
  const clockRemainingMs = parseClockMs(input.anchorPlay.clock)
  if (
    period === null ||
    period < 1 ||
    period > 4 ||
    clockRemainingMs < 6 * 60_000 ||
    !input.homeTeam ||
    !input.awayTeam
  ) {
    return null
  }
  if (hasPeriodQuestion(input, period)) return null
  if (!isTeamPeriodSlot(input, period) && clockRemainingMs > 9 * 60_000) {
    return null
  }

  const periodQuestionKey = `period:${period}`
  const periodLabel = getPeriodLabel(period)
  const variant = chooseLeastUsedTemplate(
    input,
    [
      {
        templateId: 'NFL_PERIOD_TEAM_COMPARE_POINTS',
        kind: 'TEAM_COMPARE',
        statType: 'POINTS',
        statLabel: 'points',
      },
      {
        templateId: 'NFL_PERIOD_TEAM_COMPARE_PASSING_YARDS',
        kind: 'TEAM_COMPARE',
        statType: 'PASSING_YARDS',
        statLabel: 'passing yards',
      },
      {
        templateId: 'NFL_PERIOD_TEAM_COMPARE_RUSHING_YARDS',
        kind: 'TEAM_COMPARE',
        statType: 'RUSHING_YARDS',
        statLabel: 'rushing yards',
      },
      {
        templateId: 'NFL_PERIOD_TOTAL_POINTS_RANGE',
        kind: 'TOTAL_POINTS_RANGE',
        statType: 'POINTS',
        statLabel: 'points',
      },
    ] as const,
    getMatchupRotation(input) + period
  )
  if (!variant) return null

  const totalPointsChoices = [
    { id: 'range_0', value: '6 points or fewer' },
    { id: 'range_1', value: '7-13 points' },
    { id: 'range_2', value: '14-20 points' },
    { id: 'range_3', value: '21 points or more' },
  ]
  const isTotalPointsRange = variant.kind === 'TOTAL_POINTS_RANGE'
  const choices = isTotalPointsRange
    ? totalPointsChoices
    : [
        { id: input.homeTeam, value: input.homeTeam },
        { id: input.awayTeam, value: input.awayTeam },
        { id: 'tie', value: 'Tie' },
      ]
  return {
    priority: 'PERIOD_TEAM',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: null,
    gameQuestionKey: null,
    periodQuestionKey,
    payload: buildPayload(input, {
      templateId: variant.templateId,
      question: isTotalPointsRange
        ? `How many total points will be scored in the ${periodLabel}?`
        : `Which team will have more ${variant.statLabel} in the ${periodLabel}?`,
      windowType: 'PERIOD',
      resolutionWindowMs: 20 * 60_000,
      resolutionContext: {
        type: isTotalPointsRange
          ? 'NFL_PERIOD_TOTAL_POINTS_RANGE'
          : 'NFL_PERIOD_TEAM_COMPARE',
        anchorPlayId: input.anchorPlay.id,
        period,
        statType: variant.statType,
        homeTricode: input.homeTeam,
        awayTricode: input.awayTeam,
        choices,
        ...(isTotalPointsRange ? { rangeCutoffs: [6, 13, 20] } : {}),
      },
      trigger: isTotalPointsRange
        ? 'nfl:period_total_points'
        : 'nfl:period_team_compare',
    }),
  }
}

const buildPeriodPlayerCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const period = input.anchorPlay.period
  const clockRemainingMs = parseClockMs(input.anchorPlay.clock)
  if (
    period === null ||
    period < 1 ||
    period > 4 ||
    clockRemainingMs < 4 * 60_000 ||
    isTeamPeriodSlot(input, period)
  ) {
    return null
  }
  const periodQuestionKey = `period:${period}`
  if (hasPeriodQuestion(input, period)) return null
  const periodStats = getNflPeriodStats(
    input.plays,
    period,
    input.homeTeam,
    input.awayTeam
  )
  const teamId = input.anchorPlay.driveTeamId
  const periodLabel = getPeriodLabel(period)

  const receiverToken = PASS_COMPLETION_PATTERN.test(input.anchorPlay.type)
    ? extractNflPassTarget(input.anchorPlay)
    : null
  const receiver = receiverToken
    ? findAthleteForToken(receiverToken, teamId, input.athletes)
    : null
  const receiverStats = receiverToken
    ? periodStats.players.get(normalizeTarget(receiverToken))
    : null
  const receiverProjection =
    receiverToken &&
    receiver?.roles.includes('RECEIVER') &&
    receiverStats &&
    receiverStats.receivingTargets >= 2 &&
    receiverStats.receptions > 0
      ? projectNflPeriodPlayerThreshold({
          statType: 'RECEPTIONS',
          currentValue: receiverStats.receptions,
          clockRemainingMs,
          athlete: receiver,
        })
      : null
  if (receiverToken && receiver && receiverStats && receiverProjection) {
    const range = buildNflStatRange(
      'RECEPTIONS',
      receiverStats.receptions,
      receiverProjection.projectedPeriodTotal
    )
    return {
      priority: 'PERIOD_PLAYER',
      redZoneDriveId: null,
      redZonePeriodKey: null,
      receiverQuestionKey: null,
      completionReceiverHalfKey: null,
      timeoutQuestionDriveId: null,
      gameQuestionKey: null,
      periodQuestionKey,
      payload: buildPayload(input, {
        templateId: 'NFL_PERIOD_PLAYER_RECEPTIONS_RANGE',
        question: `How many catches will ${receiver.displayName} finish the ${periodLabel} with?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_RANGE',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: receiverToken,
          playerDisplayName: receiver.displayName,
          statType: 'RECEPTIONS',
          target: receiverProjection.target,
          choices: range.choices,
          rangeCutoffs: range.cutoffs,
          rangeBucketWidth: range.bucketWidth,
          currentValueAtAsk: receiverStats.receptions,
          clockRemainingMs,
          projectedPeriodTotal: receiverProjection.projectedPeriodTotal,
          priorSeasonYear: receiverProjection.priorSeasonYear,
          priorSeasonGames: receiverProjection.priorSeasonGames,
          priorSeasonAveragePerGame:
            receiverProjection.priorSeasonAveragePerGame,
          historicalExpectedRemaining:
            receiverProjection.historicalExpectedRemaining,
          fallbackExpectedRemaining:
            receiverProjection.fallbackExpectedRemaining,
          liveExpectedRemaining: receiverProjection.liveExpectedRemaining,
          projectionSource: receiverProjection.projectionSource,
          homeTricode: input.homeTeam,
          awayTricode: input.awayTeam,
        },
        trigger: 'nfl:period_receiver_usage',
      }),
    }
  }

  const rusherToken = extractNflRusher(input.anchorPlay)
  const rusher = rusherToken
    ? findAthleteForToken(rusherToken, teamId, input.athletes)
    : null
  const rusherStats = rusherToken
    ? periodStats.players.get(normalizeTarget(rusherToken))
    : null
  const rusherProjection =
    rusherToken &&
    rusher?.roles.includes('RUSHER') &&
    rusherStats &&
    rusherStats.rushingAttempts >= 2 &&
    rusherStats.rushingYards >= 5
      ? projectNflPeriodPlayerThreshold({
          statType: 'RUSHING_YARDS',
          currentValue: rusherStats.rushingYards,
          clockRemainingMs,
          athlete: rusher,
        })
      : null
  if (rusherToken && rusher && rusherStats && rusherProjection) {
    const range = buildNflStatRange(
      'RUSHING_YARDS',
      rusherStats.rushingYards,
      rusherProjection.projectedPeriodTotal
    )
    return {
      priority: 'PERIOD_PLAYER',
      redZoneDriveId: null,
      redZonePeriodKey: null,
      receiverQuestionKey: null,
      completionReceiverHalfKey: null,
      timeoutQuestionDriveId: null,
      gameQuestionKey: null,
      periodQuestionKey,
      payload: buildPayload(input, {
        templateId: 'NFL_PERIOD_PLAYER_RUSHING_YARDS_RANGE',
        question: `How many rushing yards will ${rusher.displayName} finish the ${periodLabel} with?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_RANGE',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: rusherToken,
          playerDisplayName: rusher.displayName,
          statType: 'RUSHING_YARDS',
          target: rusherProjection.target,
          choices: range.choices,
          rangeCutoffs: range.cutoffs,
          rangeBucketWidth: range.bucketWidth,
          currentValueAtAsk: rusherStats.rushingYards,
          clockRemainingMs,
          projectedPeriodTotal: rusherProjection.projectedPeriodTotal,
          priorSeasonYear: rusherProjection.priorSeasonYear,
          priorSeasonGames: rusherProjection.priorSeasonGames,
          priorSeasonAveragePerGame: rusherProjection.priorSeasonAveragePerGame,
          historicalExpectedRemaining:
            rusherProjection.historicalExpectedRemaining,
          fallbackExpectedRemaining: rusherProjection.fallbackExpectedRemaining,
          liveExpectedRemaining: rusherProjection.liveExpectedRemaining,
          projectionSource: rusherProjection.projectionSource,
          homeTricode: input.homeTeam,
          awayTricode: input.awayTeam,
        },
        trigger: 'nfl:period_rusher_usage',
      }),
    }
  }

  const passerToken = extractNflPasser(input.anchorPlay)
  const passer = passerToken
    ? findAthleteForToken(passerToken, teamId, input.athletes)
    : null
  const passerStats = passerToken
    ? periodStats.players.get(normalizeTarget(passerToken))
    : null
  const passerProjection =
    passerToken &&
    passer?.roles.includes('PASSER') &&
    passerStats &&
    passerStats.passingAttempts >= 3 &&
    passerStats.passingYards >= 10
      ? projectNflPeriodPlayerThreshold({
          statType: 'PASSING_YARDS',
          currentValue: passerStats.passingYards,
          clockRemainingMs,
          athlete: passer,
        })
      : null
  if (passerToken && passer && passerStats && passerProjection) {
    const range = buildNflStatRange(
      'PASSING_YARDS',
      passerStats.passingYards,
      passerProjection.projectedPeriodTotal
    )
    return {
      priority: 'PERIOD_PLAYER',
      redZoneDriveId: null,
      redZonePeriodKey: null,
      receiverQuestionKey: null,
      completionReceiverHalfKey: null,
      timeoutQuestionDriveId: null,
      gameQuestionKey: null,
      periodQuestionKey,
      payload: buildPayload(input, {
        templateId: 'NFL_PERIOD_PLAYER_PASSING_YARDS_RANGE',
        question: `How many passing yards will ${passer.displayName} finish the ${periodLabel} with?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_RANGE',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: passerToken,
          playerDisplayName: passer.displayName,
          statType: 'PASSING_YARDS',
          target: passerProjection.target,
          choices: range.choices,
          rangeCutoffs: range.cutoffs,
          rangeBucketWidth: range.bucketWidth,
          currentValueAtAsk: passerStats.passingYards,
          clockRemainingMs,
          projectedPeriodTotal: passerProjection.projectedPeriodTotal,
          priorSeasonYear: passerProjection.priorSeasonYear,
          priorSeasonGames: passerProjection.priorSeasonGames,
          priorSeasonAveragePerGame: passerProjection.priorSeasonAveragePerGame,
          historicalExpectedRemaining:
            passerProjection.historicalExpectedRemaining,
          fallbackExpectedRemaining: passerProjection.fallbackExpectedRemaining,
          liveExpectedRemaining: passerProjection.liveExpectedRemaining,
          projectionSource: passerProjection.projectionSource,
          homeTricode: input.homeTeam,
          awayTricode: input.awayTeam,
        },
        trigger: 'nfl:period_passer_usage',
      }),
    }
  }

  return null
}

const buildRedZoneCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  const driveId = play.driveId
  const teamCode = getDriveTeamCode(play)
  const periodKey = typeof play.period === 'number' ? String(play.period) : null
  if (
    !driveId ||
    !teamCode ||
    !periodKey ||
    input.redZoneAskedDriveIds.includes(driveId) ||
    input.redZoneAskedPeriodKeys.includes(periodKey) ||
    !hasStableDriveContext(input) ||
    typeof play.end?.yardsToEndzone !== 'number' ||
    play.end.yardsToEndzone > 20 ||
    isDriveTerminalPlay(play) ||
    STOPPAGE_PLAY_PATTERN.test(play.type)
  ) {
    return null
  }

  const variant = chooseLeastUsedTemplate(
    input,
    [
      {
        templateId: 'NFL_RED_ZONE_OUTCOME',
        contextType: 'NFL_RED_ZONE_OUTCOME',
      },
      {
        templateId: 'NFL_RED_ZONE_SCORING_METHOD',
        contextType: 'NFL_RED_ZONE_SCORING_METHOD',
      },
    ] as const,
    getMatchupRotation(input) + Number(periodKey)
  )
  if (!variant) return null

  const isScoringMethod = variant.contextType === 'NFL_RED_ZONE_SCORING_METHOD'
  const choices = isScoringMethod
    ? [
        { id: 'passing_touchdown', value: 'Passing touchdown' },
        { id: 'rushing_touchdown', value: 'Rushing touchdown' },
        { id: 'other_touchdown', value: 'Other touchdown' },
        { id: 'field_goal', value: 'Made field goal' },
        { id: 'no_score', value: 'No score' },
      ]
    : [
        { id: 'touchdown', value: 'Touchdown' },
        { id: 'field_goal', value: 'Made field goal' },
        { id: 'turnover', value: 'Turnover or failed fourth down' },
        { id: 'no_score', value: 'No score' },
      ]
  const resolutionContext = {
    ...buildBaseContext(input, variant.contextType),
    choices,
  }

  return {
    priority: 'RED_ZONE',
    redZoneDriveId: driveId,
    redZonePeriodKey: periodKey,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: null,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: variant.templateId,
      question: isScoringMethod
        ? `What will happen on ${teamCode}'s red-zone possession?`
        : `How will ${teamCode}'s red-zone possession end?`,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 8 * 60_000,
      resolutionContext,
      trigger: 'nfl:red_zone_entry',
    }),
  }
}

const buildFourthDownCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  const periodKey =
    typeof play.period === 'number' ? `fourth:${play.period}` : null
  if (
    !STOPPAGE_PLAY_PATTERN.test(play.type) ||
    !play.driveId ||
    !periodKey ||
    input.periodQuestionKeys.includes(periodKey) ||
    input.timeoutQuestionDriveIds.includes(play.driveId) ||
    !hasStableDriveContext(input)
  ) {
    return null
  }

  const previousPlay = getPreviousDrivePlay(input.plays, play)
  const teamCode = getDriveTeamCode(play)
  const nextDown = previousPlay?.end?.down
  const distance = previousPlay?.end?.distance
  if (
    !previousPlay ||
    !teamCode ||
    nextDown !== 4 ||
    typeof distance !== 'number' ||
    distance < 1 ||
    distance > 15 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  const downLabel = /goal/i.test(previousPlay.end?.downDistanceText ?? '')
    ? '4th & goal'
    : `4th & ${distance}`

  return {
    priority: 'FOURTH_DOWN',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: play.driveId,
    gameQuestionKey: null,
    periodQuestionKey: periodKey,
    payload: buildPayload(input, {
      templateId: 'NFL_FOURTH_DOWN_RESULT',
      question: `How will ${teamCode}'s ${downLabel} end?`,
      windowType: 'NFL_NEXT_PLAY',
      resolutionWindowMs: 4 * 60_000,
      resolutionContext: {
        ...buildBaseContext(input, 'NFL_FOURTH_DOWN_RESULT'),
        choices: [
          { id: 'first_down', value: 'First down or touchdown' },
          { id: 'field_goal', value: 'Made field goal' },
          { id: 'punt', value: 'Punt' },
          { id: 'stopped', value: 'Stopped or missed kick' },
        ],
      },
      trigger: 'nfl:stoppage_fourth_down',
    }),
  }
}

type ReceiverUsage = {
  athlete: EspnNflAthleteName
  targetKey: string
  targets: number
  currentDriveTargets: number
  receptions: number
  lastTargetIndex: number
}

const isSameNflHalf = (
  leftPeriod: number | null,
  rightPeriod: number | null
): boolean => {
  if (leftPeriod === null || rightPeriod === null) return false
  return leftPeriod <= 2 === rightPeriod <= 2
}

const getRecentOffensiveDriveIds = (
  input: BuildCandidateInput,
  limit: number
): Set<string> => {
  const teamId = input.anchorPlay.driveTeamId
  const driveIds: string[] = []
  for (let index = input.plays.length - 1; index >= 0; index -= 1) {
    const play = input.plays[index]
    if (
      play.driveTeamId !== teamId ||
      !play.driveId ||
      !isSameNflHalf(play.period, input.anchorPlay.period) ||
      driveIds.includes(play.driveId)
    ) {
      continue
    }
    driveIds.push(play.driveId)
    if (driveIds.length >= limit) break
  }
  return new Set(driveIds)
}

const getReceiverUsage = (input: BuildCandidateInput): ReceiverUsage[] => {
  const teamId = input.anchorPlay.driveTeamId
  const currentDriveId = input.anchorPlay.driveId
  const recentDriveIds = getRecentOffensiveDriveIds(input, 3)
  const usageByAthleteId = new Map<string, ReceiverUsage>()
  input.plays.forEach((play, playIndex) => {
    if (
      play.driveTeamId !== teamId ||
      !play.driveId ||
      !recentDriveIds.has(play.driveId) ||
      !isSameNflHalf(play.period, input.anchorPlay.period)
    ) {
      return
    }
    const targetToken = extractNflPassTarget(play)
    if (!targetToken) return
    const athlete = findAthleteForToken(targetToken, teamId, input.athletes)
    if (!athlete || !athlete.roles.includes('RECEIVER')) return
    const existing = usageByAthleteId.get(athlete.id)
    usageByAthleteId.set(athlete.id, {
      athlete,
      targetKey: normalizeTarget(targetToken),
      targets: (existing?.targets ?? 0) + 1,
      currentDriveTargets:
        (existing?.currentDriveTargets ?? 0) +
        (play.driveId === currentDriveId ? 1 : 0),
      receptions:
        (existing?.receptions ?? 0) +
        (PASS_COMPLETION_PATTERN.test(play.type) ? 1 : 0),
      lastTargetIndex: playIndex,
    })
  })
  return [...usageByAthleteId.values()].sort(
    (left, right) =>
      right.currentDriveTargets - left.currentDriveTargets ||
      right.targets - left.targets ||
      right.receptions - left.receptions ||
      right.lastTargetIndex - left.lastTargetIndex
  )
}

const buildNextCompletionReceiverCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  const driveId = play.driveId
  const teamCode = getDriveTeamCode(play)
  const period = play.period
  const halfKey =
    typeof period === 'number'
      ? period <= 2
        ? 'first_half'
        : 'second_half'
      : null
  if (
    !STOPPAGE_PLAY_PATTERN.test(play.type) ||
    !driveId ||
    !teamCode ||
    !halfKey ||
    input.completionReceiverHalfKeys.includes(halfKey) ||
    input.timeoutQuestionDriveIds.includes(driveId) ||
    !hasStableDriveContext(input)
  ) {
    return null
  }

  const previousPlay = getPreviousDrivePlay(input.plays, play)
  const nextDown = previousPlay?.end?.down
  const currentDrivePassAttempts = input.plays.filter(
    (candidate) =>
      candidate.driveId === driveId &&
      !candidate.penalty &&
      !NO_PLAY_PATTERN.test(candidate.text) &&
      PASS_PLAY_PATTERN.test(candidate.type)
  ).length
  if (
    !previousPlay ||
    typeof nextDown !== 'number' ||
    nextDown < 1 ||
    nextDown > 2 ||
    typeof previousPlay.end?.yardsToEndzone !== 'number' ||
    previousPlay.end.yardsToEndzone <= 20 ||
    currentDrivePassAttempts < 2 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  const recentDriveIds = getRecentOffensiveDriveIds(input, 3)
  const totalRecentTargets = input.plays.filter(
    (candidate) =>
      candidate.driveTeamId === play.driveTeamId &&
      Boolean(candidate.driveId && recentDriveIds.has(candidate.driveId)) &&
      isSameNflHalf(candidate.period, play.period) &&
      extractNflPassTarget(candidate) !== null
  ).length
  const receivers = getReceiverUsage(input).slice(0, 4)
  if (receivers.length < 3) return null
  const namedTargetCoverage =
    totalRecentTargets > 0
      ? receivers.reduce((sum, receiver) => sum + receiver.targets, 0) /
        totalRecentTargets
      : 0
  if (namedTargetCoverage < 0.75) return null
  const choices = [
    ...receivers.map(({ athlete }) => ({
      id: athlete.id,
      value: athlete.displayName,
    })),
    { id: 'other', value: 'Someone else' },
    { id: 'no_completion', value: 'No completed pass' },
  ]
  const receiverChoiceByTarget = Object.fromEntries(
    receivers.map(({ athlete, targetKey }) => [targetKey, athlete.id])
  )

  return {
    priority: 'NEXT_COMPLETION_RECEIVER',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: halfKey,
    timeoutQuestionDriveId: driveId,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_NEXT_COMPLETION_RECEIVER',
      question: `Who will catch ${teamCode}'s next completed pass on this drive?`,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 5 * 60_000,
      resolutionContext: {
        ...buildBaseContext(input, 'NFL_NEXT_COMPLETION_RECEIVER'),
        choices,
        receiverChoiceByTarget,
      },
      trigger: 'nfl:timeout_next_completion_receiver',
    }),
  }
}

const buildDriveOutcomeCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  if (
    !STOPPAGE_PLAY_PATTERN.test(play.type) ||
    !play.driveId ||
    input.timeoutQuestionDriveIds.includes(play.driveId) ||
    !hasStableDriveContext(input)
  ) {
    return null
  }
  const previousPlay = getPreviousDrivePlay(input.plays, play)
  const teamCode = getDriveTeamCode(play)
  const nextDown = previousPlay?.end?.down
  const yardsToEndzone = previousPlay?.end?.yardsToEndzone
  if (
    !previousPlay ||
    !teamCode ||
    typeof nextDown !== 'number' ||
    nextDown < 1 ||
    nextDown > 3 ||
    typeof yardsToEndzone !== 'number' ||
    yardsToEndzone <= 20 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  return {
    priority: 'DRIVE_OUTCOME',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: play.driveId,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_DRIVE_OUTCOME',
      question: `How will ${teamCode}'s current drive end?`,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 8 * 60_000,
      resolutionContext: {
        ...buildBaseContext(input, 'NFL_DRIVE_OUTCOME'),
        choices: [
          { id: 'touchdown', value: 'Touchdown' },
          { id: 'field_goal', value: 'Made field goal' },
          { id: 'punt', value: 'Punt' },
          { id: 'turnover', value: 'Turnover or failed fourth down' },
          { id: 'no_score', value: 'Missed field goal or end of period' },
        ],
      },
      trigger: 'nfl:timeout_drive_outcome',
    }),
  }
}

const buildNextFirstDownCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  if (
    !STOPPAGE_PLAY_PATTERN.test(play.type) ||
    !play.driveId ||
    input.timeoutQuestionDriveIds.includes(play.driveId) ||
    !hasStableDriveContext(input)
  ) {
    return null
  }
  const previousPlay = getPreviousDrivePlay(input.plays, play)
  const teamCode = getDriveTeamCode(play)
  const nextDown = previousPlay?.end?.down
  const yardsToEndzone = previousPlay?.end?.yardsToEndzone
  if (
    !previousPlay ||
    !teamCode ||
    typeof nextDown !== 'number' ||
    nextDown < 1 ||
    nextDown > 2 ||
    typeof yardsToEndzone !== 'number' ||
    yardsToEndzone <= 20 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  return {
    priority: 'NEXT_FIRST_DOWN',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: play.driveId,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_NEXT_FIRST_DOWN_METHOD',
      question: `How will ${teamCode} get its next first down on this drive?`,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 6 * 60_000,
      resolutionContext: {
        ...buildBaseContext(input, 'NFL_NEXT_FIRST_DOWN_METHOD'),
        choices: [
          { id: 'pass', value: 'Completed pass' },
          { id: 'run', value: 'Run' },
          { id: 'penalty', value: 'Penalty' },
          { id: 'other', value: 'Something else' },
          { id: 'no_first_down', value: 'No more first downs' },
        ],
      },
      trigger: 'nfl:timeout_next_first_down',
    }),
  }
}

const buildTimeoutNextPlayCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  if (
    !STOPPAGE_PLAY_PATTERN.test(play.type) ||
    !play.driveId ||
    input.timeoutQuestionDriveIds.includes(play.driveId) ||
    !hasStableDriveContext(input)
  ) {
    return null
  }
  const previousPlay = getPreviousDrivePlay(input.plays, play)
  const teamCode = getDriveTeamCode(play)
  const nextDown = previousPlay?.end?.down
  if (
    !previousPlay ||
    !teamCode ||
    typeof nextDown !== 'number' ||
    nextDown < 1 ||
    nextDown > 3 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  return {
    priority: 'TIMEOUT_NEXT_PLAY',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: play.driveId,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_NEXT_OFFENSIVE_PLAY_RESULT',
      question: `What will ${teamCode}'s next offensive play be?`,
      windowType: 'NFL_NEXT_PLAY',
      resolutionWindowMs: 2 * 60_000,
      resolutionContext: {
        ...buildBaseContext(input, 'NFL_NEXT_PLAY_RESULT'),
        choices: [
          { id: 'run', value: 'Run' },
          { id: 'completed_pass', value: 'Completed pass' },
          {
            id: 'unsuccessful_pass',
            value: 'Incomplete pass, sack, or interception',
          },
          { id: 'penalty', value: 'Penalty or no play' },
          { id: 'kick_or_other', value: 'Kick or something else' },
        ],
      },
      trigger: 'nfl:timeout_next_play',
    }),
  }
}

const getPriorityRank = (priority: NflQuestionPriority): number => {
  if (priority === 'GAME') return 0
  if (priority === 'RED_ZONE') return 1
  if (priority === 'FOURTH_DOWN') return 2
  if (priority === 'PERIOD_TEAM' || priority === 'PERIOD_PLAYER') return 3
  return 4
}

const sortCandidatesByPriorityAndUse = (
  input: BuildCandidateInput,
  candidates: readonly NflQuestionCandidate[]
): NflQuestionCandidate[] =>
  candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        getTemplateUseCount(input, candidate.payload.templateId) <
          NFL_MAX_TEMPLATE_USES_PER_GAME &&
        !isTemplateCoolingDown(input, candidate.payload.templateId)
    )
    .sort(
      (left, right) =>
        getPriorityRank(left.candidate.priority) -
          getPriorityRank(right.candidate.priority) ||
        getTemplateUseCount(input, left.candidate.payload.templateId) -
          getTemplateUseCount(input, right.candidate.payload.templateId) ||
        left.index - right.index
    )
    .map(({ candidate }) => candidate)

export const buildNflQuestionCandidateDecision = (
  input: BuildCandidateInput
): NflQuestionCandidateDecision => {
  const latestPlay = input.plays[input.plays.length - 1]
  if (!latestPlay) {
    return {
      candidate: null,
      priority: null,
      sourceAgeMs: null,
      maxSourceAgeMs: null,
      skipReason: 'NO_LATEST_PLAY',
    }
  }
  if (latestPlay.id !== input.anchorPlay.id) {
    return {
      candidate: null,
      priority: null,
      sourceAgeMs: null,
      maxSourceAgeMs: null,
      skipReason: 'ANCHOR_NOT_LATEST',
    }
  }

  const candidates = sortCandidatesByPriorityAndUse(
    input,
    [
      buildGameWinnerCandidate(input),
      buildRedZoneCandidate(input),
      buildFourthDownCandidate(input),
      buildPeriodTeamCandidate(input),
      buildPeriodPlayerCandidate(input),
      buildNextCompletionReceiverCandidate(input),
      buildDriveOutcomeCandidate(input),
      buildNextFirstDownCandidate(input),
      buildTimeoutNextPlayCandidate(input),
    ].filter(
      (candidate): candidate is NflQuestionCandidate => candidate !== null
    )
  ).filter(
    (candidate) =>
      input.allowShortHorizonQuestions !== false ||
      isLongHorizonPriority(candidate.priority)
  )

  if (candidates.length === 0) {
    return {
      candidate: null,
      priority: null,
      sourceAgeMs: null,
      maxSourceAgeMs: null,
      skipReason: 'NO_CANDIDATE',
    }
  }

  const wallclockMs = getNflPlayWallclockMs(input.anchorPlay)
  const sourceAgePolicy = input.sourceAgePolicy ?? 'ENFORCE'
  if (wallclockMs === null && sourceAgePolicy === 'ENFORCE') {
    return {
      candidate: null,
      priority: candidates[0].priority,
      sourceAgeMs: null,
      maxSourceAgeMs: getMaxSourceAgeMs(candidates[0].priority),
      skipReason: 'MISSING_SOURCE_WALLCLOCK',
    }
  }

  const sourceAgeMs = wallclockMs === null ? null : input.nowMs - wallclockMs
  if (
    sourceAgePolicy === 'ENFORCE' &&
    sourceAgeMs !== null &&
    sourceAgeMs < -5_000
  ) {
    return {
      candidate: null,
      priority: candidates[0].priority,
      sourceAgeMs,
      maxSourceAgeMs: getMaxSourceAgeMs(candidates[0].priority),
      skipReason: 'SOURCE_CLOCK_IN_FUTURE',
    }
  }

  const candidate =
    sourceAgePolicy === 'OBSERVE'
      ? candidates[0]
      : candidates.find(
          (possibleCandidate) =>
            sourceAgeMs !== null &&
            sourceAgeMs <= getMaxSourceAgeMs(possibleCandidate.priority)
        )
  if (!candidate) {
    return {
      candidate: null,
      priority: candidates[0].priority,
      sourceAgeMs,
      maxSourceAgeMs: getMaxSourceAgeMs(candidates[0].priority),
      skipReason: 'SOURCE_TOO_OLD',
    }
  }
  const maxSourceAgeMs = getMaxSourceAgeMs(candidate.priority)

  return {
    candidate: {
      ...candidate,
      payload: {
        ...candidate.payload,
        selectionReason: [
          ...(candidate.payload.selectionReason ?? []),
          {
            code: 'NFL_SOURCE_AGE_MS',
            detail: sourceAgeMs === null ? 'unknown' : `${sourceAgeMs}`,
          },
          { code: 'NFL_SOURCE_AGE_GUARD', detail: `${maxSourceAgeMs}` },
          { code: 'NFL_SOURCE_AGE_POLICY', detail: sourceAgePolicy },
          {
            code: 'NFL_TEMPLATE_USE_COUNT_BEFORE',
            detail: `${getTemplateUseCount(input, candidate.payload.templateId)}`,
          },
          {
            code: 'NFL_TEMPLATE_LAST_USED_AT_MS',
            detail: `${input.templateLastUsedAtMs?.[candidate.payload.templateId] ?? 'none'}`,
          },
        ],
      },
    },
    priority: candidate.priority,
    sourceAgeMs,
    maxSourceAgeMs,
    skipReason: null,
  }
}

export const buildNflQuestionCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null =>
  buildNflQuestionCandidateDecision(input).candidate

const isSameDrive = (
  context: ResolutionContext,
  play: EspnNflPlay
): boolean => {
  const driveId = asContextString(context, 'driveId')
  return Boolean(driveId && play.driveId === driveId)
}

const isTouchdown = (play: EspnNflPlay): boolean =>
  play.scoringPlay && /touchdown/i.test(play.type)

const getLastDrivePlay = (
  context: ResolutionContext,
  playsThroughCurrent: readonly EspnNflPlay[]
): EspnNflPlay | null => {
  const driveId = asContextString(context, 'driveId')
  if (!driveId) return null
  for (let index = playsThroughCurrent.length - 1; index >= 0; index -= 1) {
    const candidate = playsThroughCurrent[index]
    if (
      candidate.driveId === driveId &&
      !candidate.penalty &&
      !NO_PLAY_PATTERN.test(candidate.text)
    ) {
      return candidate
    }
  }
  return null
}

const getRedZoneOutcome = (
  context: ResolutionContext,
  finalDrivePlay: EspnNflPlay
): 'touchdown' | 'field_goal' | 'turnover' | 'no_score' => {
  const offenseTeamId = asContextString(context, 'teamId')
  if (finalDrivePlay.turnover || /interception/i.test(finalDrivePlay.type)) {
    return 'turnover'
  }
  if (isTouchdown(finalDrivePlay)) return 'touchdown'
  if (FIELD_GOAL_GOOD_PATTERN.test(finalDrivePlay.type)) return 'field_goal'
  if (
    finalDrivePlay.start?.down === 4 &&
    offenseTeamId &&
    finalDrivePlay.end?.teamId &&
    finalDrivePlay.end.teamId !== offenseTeamId
  ) {
    return 'turnover'
  }
  return 'no_score'
}

const getRedZoneScoringMethod = (
  finalDrivePlay: EspnNflPlay
):
  | 'passing_touchdown'
  | 'rushing_touchdown'
  | 'other_touchdown'
  | 'field_goal'
  | 'no_score' => {
  if (isTouchdown(finalDrivePlay)) {
    if (/passing touchdown/i.test(finalDrivePlay.type)) {
      return 'passing_touchdown'
    }
    if (/rushing touchdown/i.test(finalDrivePlay.type)) {
      return 'rushing_touchdown'
    }
    return 'other_touchdown'
  }
  return FIELD_GOAL_GOOD_PATTERN.test(finalDrivePlay.type)
    ? 'field_goal'
    : 'no_score'
}

const getDriveOutcome = (
  context: ResolutionContext,
  finalDrivePlay: EspnNflPlay
): 'touchdown' | 'field_goal' | 'punt' | 'turnover' | 'no_score' => {
  if (isTouchdown(finalDrivePlay)) return 'touchdown'
  if (FIELD_GOAL_GOOD_PATTERN.test(finalDrivePlay.type)) return 'field_goal'
  if (/punt/i.test(finalDrivePlay.type)) return 'punt'
  const offenseTeamId = asContextString(context, 'teamId')
  if (
    finalDrivePlay.turnover ||
    /interception/i.test(finalDrivePlay.type) ||
    (finalDrivePlay.start?.down === 4 &&
      Boolean(offenseTeamId) &&
      Boolean(finalDrivePlay.end?.teamId) &&
      finalDrivePlay.end?.teamId !== offenseTeamId)
  ) {
    return 'turnover'
  }
  return 'no_score'
}

const getConfirmedDriveTerminalPlay = (
  context: ResolutionContext,
  currentPlay: EspnNflPlay,
  playsThroughCurrent: readonly EspnNflPlay[],
  gameCompleted: boolean
): EspnNflPlay | null => {
  const driveId = asContextString(context, 'driveId')
  const anchorPlayId = asContextString(context, 'anchorPlayId')
  if (!driveId) return null
  let terminalPlay: EspnNflPlay | null = null
  for (const candidate of playsThroughCurrent) {
    if (
      candidate.driveId === driveId &&
      candidate.id !== anchorPlayId &&
      isDriveTerminalPlay(candidate)
    ) {
      terminalPlay = candidate
    }
  }
  if (!terminalPlay) return null
  const hasLaterProviderPlay = terminalPlay.id !== currentPlay.id
  return hasLaterProviderPlay || gameCompleted ? terminalPlay : null
}

export const resolveNflQuestionForPlay = (
  question: NflActiveQuestion,
  play: EspnNflPlay,
  playsThroughCurrent: readonly EspnNflPlay[] = [],
  gameCompleted = false
): NflQuestionDecision | null => {
  const context = question.resolutionContext
  const contextType = asContextString(context, 'type')
  const anchorPlayId = asContextString(context, 'anchorPlayId')
  if (
    play.id === anchorPlayId &&
    contextType !== 'NFL_GAME_WINNER' &&
    contextType !== 'NFL_PERIOD_TEAM_COMPARE' &&
    contextType !== 'NFL_PERIOD_TOTAL_POINTS_RANGE' &&
    contextType !== 'NFL_PERIOD_PLAYER_THRESHOLD' &&
    contextType !== 'NFL_PERIOD_PLAYER_RANGE'
  ) {
    return null
  }

  const sameDrive = isSameDrive(context, play)
  if (contextType === 'NFL_GAME_WINNER') {
    if (!gameCompleted) return null
    const homeTeam = asContextString(context, 'homeTricode')
    const awayTeam = asContextString(context, 'awayTricode')
    let homeScore = play.homeScore
    let awayScore = play.awayScore
    for (
      let index = playsThroughCurrent.length - 1;
      index >= 0 && (homeScore === null || awayScore === null);
      index -= 1
    ) {
      const scorePlay = playsThroughCurrent[index]
      if (homeScore === null) homeScore = scorePlay.homeScore
      if (awayScore === null) awayScore = scorePlay.awayScore
    }
    if (!homeTeam || !awayTeam || homeScore === null || awayScore === null) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
    }
    return {
      state: 'resolved',
      answer:
        homeScore === awayScore
          ? 'tie'
          : homeScore > awayScore
            ? homeTeam
            : awayTeam,
      reason: null,
    }
  }

  if (
    contextType === 'NFL_PERIOD_TEAM_COMPARE' ||
    contextType === 'NFL_PERIOD_TOTAL_POINTS_RANGE' ||
    contextType === 'NFL_PERIOD_PLAYER_THRESHOLD' ||
    contextType === 'NFL_PERIOD_PLAYER_RANGE'
  ) {
    const period = asContextNumber(context, 'period')
    if (period === null) {
      return { state: 'cancelled', answer: null, reason: 'INVALID_PERIOD' }
    }
    const periodEnded =
      gameCompleted ||
      (typeof play.period === 'number' && play.period > period) ||
      (play.period === period && /end period/i.test(play.type))
    if (!periodEnded) return null
    const homeTeam = asContextString(context, 'homeTricode')
    const awayTeam = asContextString(context, 'awayTricode')
    if (!homeTeam || !awayTeam) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_TEAMS' }
    }
    const periodStats = getNflPeriodStats(
      playsThroughCurrent,
      period,
      homeTeam,
      awayTeam
    )
    if (
      contextType === 'NFL_PERIOD_TEAM_COMPARE' ||
      contextType === 'NFL_PERIOD_TOTAL_POINTS_RANGE'
    ) {
      const statType = asContextString(context, 'statType')
      const homeStats = periodStats.teams.get(homeTeam)
      const awayStats = periodStats.teams.get(awayTeam)
      if (!homeStats || !awayStats || !statType) {
        return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
      }
      if (contextType === 'NFL_PERIOD_TOTAL_POINTS_RANGE') {
        const cutoffs = asContextNumberArray(context, 'rangeCutoffs')
        if (!cutoffs || cutoffs.length !== 3) {
          return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
        }
        return {
          state: 'resolved',
          answer: getRangeAnswer(homeStats.points + awayStats.points, cutoffs),
          reason: null,
        }
      }
      const homeValue =
        statType === 'PASSING_YARDS'
          ? homeStats.passingYards
          : statType === 'RUSHING_YARDS'
            ? homeStats.rushingYards
            : homeStats.points
      const awayValue =
        statType === 'PASSING_YARDS'
          ? awayStats.passingYards
          : statType === 'RUSHING_YARDS'
            ? awayStats.rushingYards
            : awayStats.points
      if (homeValue === awayValue) {
        return { state: 'resolved', answer: 'tie', reason: null }
      }
      return {
        state: 'resolved',
        answer: homeValue > awayValue ? homeTeam : awayTeam,
        reason: null,
      }
    }

    const playerToken = asContextString(context, 'playerToken')
    const statType = asContextString(context, 'statType')
    const target = asContextNumber(context, 'target')
    if (!playerToken || !statType) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
    }
    const playerStats = periodStats.players.get(normalizeTarget(playerToken))
    const value =
      statType === 'RECEPTIONS'
        ? (playerStats?.receptions ?? 0)
        : statType === 'RUSHING_YARDS'
          ? (playerStats?.rushingYards ?? 0)
          : (playerStats?.passingYards ?? 0)
    if (contextType === 'NFL_PERIOD_PLAYER_RANGE') {
      const cutoffs = asContextNumberArray(context, 'rangeCutoffs')
      if (!cutoffs || cutoffs.length !== 3) {
        return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
      }
      return {
        state: 'resolved',
        answer: getRangeAnswer(value, cutoffs),
        reason: null,
      }
    }
    if (target === null) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
    }
    return {
      state: 'resolved',
      answer: value >= target ? 'yes' : 'no',
      reason: null,
    }
  }

  if (contextType === 'NFL_RED_ZONE_OUTCOME') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay) {
      return {
        state: 'resolved',
        answer: getRedZoneOutcome(context, terminalPlay),
        reason: null,
      }
    }
    if (!sameDrive || gameCompleted) {
      const finalDrivePlay = getLastDrivePlay(context, playsThroughCurrent)
      return {
        state: 'resolved',
        answer: finalDrivePlay
          ? getRedZoneOutcome(context, finalDrivePlay)
          : 'no_score',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_RED_ZONE_SCORING_METHOD') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay) {
      return {
        state: 'resolved',
        answer: getRedZoneScoringMethod(terminalPlay),
        reason: null,
      }
    }
    if (!sameDrive || gameCompleted) {
      const finalDrivePlay = getLastDrivePlay(context, playsThroughCurrent)
      return {
        state: 'resolved',
        answer: finalDrivePlay
          ? getRedZoneScoringMethod(finalDrivePlay)
          : 'no_score',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_DRIVE_OUTCOME') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay) {
      return {
        state: 'resolved',
        answer: getDriveOutcome(context, terminalPlay),
        reason: null,
      }
    }
    if (!sameDrive || gameCompleted) {
      const finalDrivePlay = getLastDrivePlay(context, playsThroughCurrent)
      return {
        state: 'resolved',
        answer: finalDrivePlay
          ? getDriveOutcome(context, finalDrivePlay)
          : 'no_score',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_RED_ZONE') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay && isTouchdown(terminalPlay)) {
      const variant = asContextString(context, 'redZoneVariant')
      const answer =
        variant === 'PASSING_TOUCHDOWN'
          ? /passing touchdown/i.test(terminalPlay.type)
          : variant === 'RUSHING_TOUCHDOWN'
            ? /rushing touchdown/i.test(terminalPlay.type)
            : true
      return { state: 'resolved', answer: answer ? 'yes' : 'no', reason: null }
    }
    if (terminalPlay || !sameDrive) {
      return { state: 'resolved', answer: 'no', reason: null }
    }
    return null
  }

  if (contextType === 'NFL_DRIVE_PLAYER_RANGE') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (!terminalPlay && sameDrive && !gameCompleted) return null
    const driveId = asContextString(context, 'driveId')
    const playerToken = asContextString(context, 'playerToken')
    const statType = asContextString(context, 'statType')
    const cutoffs = asContextNumberArray(context, 'rangeCutoffs')
    if (!driveId || !playerToken || !statType || cutoffs?.length !== 3) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
    }
    const playerStats = getNflDrivePlayerStats(
      playsThroughCurrent,
      driveId
    ).get(normalizeTarget(playerToken))
    const value =
      statType === 'RECEPTIONS'
        ? (playerStats?.receptions ?? 0)
        : statType === 'RUSHING_YARDS'
          ? (playerStats?.rushingYards ?? 0)
          : (playerStats?.passingYards ?? 0)
    return {
      state: 'resolved',
      answer: getRangeAnswer(value, cutoffs),
      reason: null,
    }
  }

  if (contextType === 'NFL_FIELD_GOAL') {
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay && FIELD_GOAL_GOOD_PATTERN.test(terminalPlay.type)) {
      return { state: 'resolved', answer: 'yes', reason: null }
    }
    if (terminalPlay || !sameDrive) {
      return { state: 'resolved', answer: 'no', reason: null }
    }
    return null
  }

  if (contextType === 'NFL_FOURTH_DOWN_RESULT') {
    const teamId = asContextString(context, 'teamId')
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const fourthDownPlay =
      anchorIndex >= 0
        ? playsThroughCurrent.slice(anchorIndex + 1).find((candidate) => {
            const penaltyFirstDown =
              candidate.penalty &&
              Boolean(teamId) &&
              candidate.end?.teamId === teamId &&
              candidate.end.down === 1
            return (
              isSameDrive(context, candidate) &&
              !STOPPAGE_PLAY_PATTERN.test(candidate.type) &&
              (penaltyFirstDown ||
                (candidate.start?.down === 4 &&
                  !NO_PLAY_PATTERN.test(candidate.text)))
            )
          })
        : null
    if (fourthDownPlay && (fourthDownPlay.id !== play.id || gameCompleted)) {
      if (/punt/i.test(fourthDownPlay.type)) {
        return { state: 'resolved', answer: 'punt', reason: null }
      }
      if (FIELD_GOAL_GOOD_PATTERN.test(fourthDownPlay.type)) {
        return { state: 'resolved', answer: 'field_goal', reason: null }
      }
      const converted =
        Boolean(teamId) &&
        (isTouchdown(fourthDownPlay) ||
          (fourthDownPlay.end?.teamId === teamId &&
            fourthDownPlay.end.down === 1))
      return {
        state: 'resolved',
        answer: converted ? 'first_down' : 'stopped',
        reason: null,
      }
    }
    if (!sameDrive || gameCompleted) {
      return { state: 'resolved', answer: 'stopped', reason: null }
    }
    return null
  }

  if (contextType === 'NFL_FOURTH_DOWN_CONVERSION') {
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const fourthDownPlay =
      anchorIndex >= 0
        ? playsThroughCurrent.slice(anchorIndex + 1).find((candidate) => {
            return (
              isSameDrive(context, candidate) &&
              candidate.start?.down === 4 &&
              !STOPPAGE_PLAY_PATTERN.test(candidate.type) &&
              !NO_PLAY_PATTERN.test(candidate.text)
            )
          })
        : null
    if (fourthDownPlay && (fourthDownPlay.id !== play.id || gameCompleted)) {
      const teamId = asContextString(context, 'teamId')
      const converted =
        Boolean(teamId) &&
        (isTouchdown(fourthDownPlay) ||
          (fourthDownPlay.end?.teamId === teamId &&
            fourthDownPlay.end.down === 1))
      return {
        state: 'resolved',
        answer: converted ? 'yes' : 'no',
        reason: null,
      }
    }
    if (!sameDrive) {
      return {
        state: 'resolved',
        answer: 'no',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_NEXT_FIRST_DOWN_METHOD') {
    const teamId = asContextString(context, 'teamId')
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const firstDownPlay =
      anchorIndex >= 0
        ? playsThroughCurrent.slice(anchorIndex + 1).find((candidate) => {
            if (!isSameDrive(context, candidate)) return false
            const retainedPossession =
              Boolean(teamId) && candidate.end?.teamId === teamId
            const penaltyFirstDown =
              candidate.penalty &&
              retainedPossession &&
              candidate.end?.down === 1
            const scrimmageFirstDown =
              !STOPPAGE_PLAY_PATTERN.test(candidate.type) &&
              !NO_PLAY_PATTERN.test(candidate.text) &&
              ((retainedPossession && candidate.end?.down === 1) ||
                (isTouchdown(candidate) && candidate.driveTeamId === teamId))
            return penaltyFirstDown || scrimmageFirstDown
          })
        : null
    if (firstDownPlay && (firstDownPlay.id !== play.id || gameCompleted)) {
      const answer = firstDownPlay.penalty
        ? 'penalty'
        : PASS_COMPLETION_PATTERN.test(firstDownPlay.type)
          ? 'pass'
          : RUSH_PLAY_PATTERN.test(firstDownPlay.type)
            ? 'run'
            : 'other'
      return { state: 'resolved', answer, reason: null }
    }
    const terminalPlay = getConfirmedDriveTerminalPlay(
      context,
      play,
      playsThroughCurrent,
      gameCompleted
    )
    if (terminalPlay || !sameDrive || gameCompleted) {
      return {
        state: 'resolved',
        answer: 'no_first_down',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_NEXT_PLAY_RESULT') {
    if (!sameDrive) {
      return { state: 'resolved', answer: 'kick_or_other', reason: null }
    }
    if (STOPPAGE_PLAY_PATTERN.test(play.type)) return null
    if (play.penalty || NO_PLAY_PATTERN.test(play.text)) {
      return { state: 'resolved', answer: 'penalty', reason: null }
    }
    if (PASS_COMPLETION_PATTERN.test(play.type)) {
      return { state: 'resolved', answer: 'completed_pass', reason: null }
    }
    if (PASS_PLAY_PATTERN.test(play.type)) {
      return { state: 'resolved', answer: 'unsuccessful_pass', reason: null }
    }
    if (RUSH_PLAY_PATTERN.test(play.type)) {
      return { state: 'resolved', answer: 'run', reason: null }
    }
    return { state: 'resolved', answer: 'kick_or_other', reason: null }
  }

  if (contextType === 'NFL_NEXT_PLAY_PASS') {
    if (!sameDrive) {
      return {
        state: 'cancelled',
        answer: null,
        reason: 'NO_NEXT_OFFENSIVE_PLAY',
      }
    }
    if (
      STOPPAGE_PLAY_PATTERN.test(play.type) ||
      play.penalty ||
      NO_PLAY_PATTERN.test(play.text)
    ) {
      return null
    }
    if (PASS_PLAY_PATTERN.test(play.type)) {
      return { state: 'resolved', answer: 'yes', reason: null }
    }
    if (RUSH_PLAY_PATTERN.test(play.type)) {
      return { state: 'resolved', answer: 'no', reason: null }
    }
    return null
  }

  if (contextType === 'NFL_NEXT_COMPLETION_RECEIVER') {
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const completion =
      anchorIndex >= 0
        ? playsThroughCurrent
            .slice(anchorIndex + 1)
            .find(
              (candidate) =>
                isSameDrive(context, candidate) &&
                !candidate.penalty &&
                !NO_PLAY_PATTERN.test(candidate.text) &&
                PASS_COMPLETION_PATTERN.test(candidate.type)
            )
        : null
    if (completion && (completion.id !== play.id || gameCompleted)) {
      const target = extractNflPassTarget(completion)
      if (!target) {
        return {
          state: 'resolved',
          answer: 'other',
          reason: null,
        }
      }
      const choiceByTarget = asContextStringRecord(
        context,
        'receiverChoiceByTarget'
      )
      return {
        state: 'resolved',
        answer: choiceByTarget?.[normalizeTarget(target)] ?? 'other',
        reason: null,
      }
    }
    if (!sameDrive) {
      return {
        state: 'resolved',
        answer: 'no_completion',
        reason: null,
      }
    }
    if (gameCompleted) {
      return {
        state: 'resolved',
        answer: 'no_completion',
        reason: null,
      }
    }
    return null
  }

  if (contextType === 'NFL_RECEIVER_ANOTHER_CATCH_DRIVE') {
    const expectedTarget = asContextString(context, 'targetToken')
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const catchPlay =
      expectedTarget && anchorIndex >= 0
        ? playsThroughCurrent.slice(anchorIndex + 1).find((candidate) => {
            const actualTarget = extractNflPassTarget(candidate)
            return (
              actualTarget !== null &&
              normalizeTarget(expectedTarget) ===
                normalizeTarget(actualTarget) &&
              PASS_COMPLETION_PATTERN.test(candidate.type)
            )
          })
        : null
    if (catchPlay && (catchPlay.id !== play.id || gameCompleted)) {
      return { state: 'resolved', answer: 'yes', reason: null }
    }
    if (!sameDrive || gameCompleted) {
      return { state: 'resolved', answer: 'no', reason: null }
    }
    return null
  }

  if (contextType === 'NFL_NEXT_TARGET') {
    const expectedTarget = asContextString(context, 'targetToken')
    const anchorIndex = playsThroughCurrent.findIndex(
      (candidate) => candidate.id === anchorPlayId
    )
    const targetPlay =
      expectedTarget && anchorIndex >= 0
        ? playsThroughCurrent.slice(anchorIndex + 1).find((candidate) => {
            const actualTarget = extractNflPassTarget(candidate)
            return (
              actualTarget !== null &&
              normalizeTarget(expectedTarget) === normalizeTarget(actualTarget)
            )
          })
        : null
    if (targetPlay && (targetPlay.id !== play.id || gameCompleted)) {
      if (PASS_COMPLETION_PATTERN.test(targetPlay.type)) {
        return { state: 'resolved', answer: 'yes', reason: null }
      }
      if (PASS_INCOMPLETE_PATTERN.test(targetPlay.type)) {
        return { state: 'resolved', answer: 'no', reason: null }
      }
    }
    if (!sameDrive) {
      return { state: 'cancelled', answer: null, reason: 'NO_NEXT_TARGET' }
    }
    if (isDriveTerminalPlay(play)) {
      if (gameCompleted) {
        return { state: 'cancelled', answer: null, reason: 'NO_NEXT_TARGET' }
      }
      return null
    }
  }

  if (gameCompleted) {
    return { state: 'cancelled', answer: null, reason: 'GAME_ENDED' }
  }
  return null
}
