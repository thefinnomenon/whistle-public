import type { EngineQuestionPayload, ResolutionContext } from './engine'
import type { EspnNflAthleteName, EspnNflPlay } from './nfl'

export const NFL_QUESTION_RESPONSE_MS = 30_000
export const NFL_QUESTION_MIN_INTERVAL_MS = 180_000
export const NFL_QUESTION_MAX_SOURCE_AGE_MS = 15_000
export const NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS = 90_000
export const NFL_RECEIVER_TARGET_QUIET_MS = 120_000
export const NFL_DRIVE_QUESTION_MIN_AGE_MS = 120_000
export const NFL_MAX_QUESTIONS_PER_GAME = 20

export type NflQuestionPriority =
  | 'GAME'
  | 'PERIOD_TEAM'
  | 'PERIOD_PLAYER'
  | 'RED_ZONE'
  | 'FIELD_GOAL'
  | 'FOURTH_DOWN'
  | 'NEXT_COMPLETION_RECEIVER'
  | 'TIMEOUT_NEXT_PLAY'
  | 'RECEIVER_TARGET'

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

const parseClockMs = (clock: string | null): number => {
  if (!clock) return 0
  const match = /^(\d+):(\d{2})$/.exec(clock.trim())
  if (!match) return 0
  return Number(match[1]) * 60_000 + Number(match[2]) * 1_000
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
    priority === 'PERIOD_PLAYER' ||
    priority === 'RED_ZONE'
  ) {
    return NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS
  }
  return NFL_QUESTION_MAX_SOURCE_AGE_MS
}

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

const chooseRedZoneVariant = (
  driveId: string
): 'TOUCHDOWN' | 'PASSING_TOUCHDOWN' | 'RUSHING_TOUCHDOWN' => {
  const bucket = [...driveId].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0
  )
  if (bucket % 4 < 2) return 'TOUCHDOWN'
  return bucket % 4 === 2 ? 'PASSING_TOUCHDOWN' : 'RUSHING_TOUCHDOWN'
}

const getPeriodLabel = (period: number): string => {
  if (period === 1) return 'first quarter'
  if (period === 2) return 'second quarter'
  if (period === 3) return 'third quarter'
  if (period === 4) return 'fourth quarter'
  return `period ${period}`
}

export const buildNflPregameGameWinnerPayload = (
  homeTeam: string,
  awayTeam: string
): EngineQuestionPayload => ({
  templateId: 'NFL_GAME_WINNER',
  question: 'Who will win the game?',
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
      question: 'Who will win the game?',
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
  if (
    period === null ||
    period < 1 ||
    period > 4 ||
    parseClockMs(input.anchorPlay.clock) < 6 * 60_000 ||
    !input.homeTeam ||
    !input.awayTeam
  ) {
    return null
  }
  const periodQuestionKey = `team:${period}`
  if (input.periodQuestionKeys.includes(periodQuestionKey)) return null

  const statType =
    period === 2 ? 'PASSING_YARDS' : period === 3 ? 'RUSHING_YARDS' : 'POINTS'
  const statLabel =
    statType === 'PASSING_YARDS'
      ? 'passing yards'
      : statType === 'RUSHING_YARDS'
        ? 'rushing yards'
        : 'points'
  const periodLabel = getPeriodLabel(period)
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
      templateId: `NFL_PERIOD_TEAM_COMPARE_${statType}`,
      question: `Which team will have more ${statLabel} in the ${periodLabel}?`,
      windowType: 'PERIOD',
      resolutionWindowMs: 20 * 60_000,
      resolutionContext: {
        type: 'NFL_PERIOD_TEAM_COMPARE',
        anchorPlayId: input.anchorPlay.id,
        period,
        statType,
        homeTricode: input.homeTeam,
        awayTricode: input.awayTeam,
        choices: [
          { id: input.homeTeam, value: input.homeTeam },
          { id: input.awayTeam, value: input.awayTeam },
        ],
      },
      trigger: 'nfl:period_team_compare',
    }),
  }
}

const buildPeriodPlayerCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const period = input.anchorPlay.period
  if (
    period === null ||
    period < 1 ||
    period > 4 ||
    parseClockMs(input.anchorPlay.clock) < 4 * 60_000
  ) {
    return null
  }
  const periodQuestionKey = `player:${period}`
  if (input.periodQuestionKeys.includes(periodQuestionKey)) return null
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
  if (
    receiverToken &&
    receiver?.roles.includes('RECEIVER') &&
    receiverStats &&
    receiverStats.receivingTargets >= 2 &&
    receiverStats.receptions > 0 &&
    receiverStats.receptions < 3
  ) {
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
        templateId: 'NFL_PERIOD_PLAYER_RECEPTIONS',
        question: `Will ${receiver.displayName} have at least 3 catches in the ${periodLabel}?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_THRESHOLD',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: receiverToken,
          playerDisplayName: receiver.displayName,
          statType: 'RECEPTIONS',
          target: 3,
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
  if (
    rusherToken &&
    rusher?.roles.includes('RUSHER') &&
    rusherStats &&
    rusherStats.rushingAttempts >= 2 &&
    rusherStats.rushingYards >= 5 &&
    rusherStats.rushingYards < 25
  ) {
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
        templateId: 'NFL_PERIOD_PLAYER_RUSHING_YARDS',
        question: `Will ${rusher.displayName} rush for at least 25 yards in the ${periodLabel}?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_THRESHOLD',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: rusherToken,
          playerDisplayName: rusher.displayName,
          statType: 'RUSHING_YARDS',
          target: 25,
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
  if (
    passerToken &&
    passer?.roles.includes('PASSER') &&
    passerStats &&
    passerStats.passingAttempts >= 3 &&
    passerStats.passingYards >= 10 &&
    passerStats.passingYards < 75
  ) {
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
        templateId: 'NFL_PERIOD_PLAYER_PASSING_YARDS',
        question: `Will ${passer.displayName} throw for at least 75 yards in the ${periodLabel}?`,
        windowType: 'PERIOD',
        resolutionWindowMs: 20 * 60_000,
        resolutionContext: {
          type: 'NFL_PERIOD_PLAYER_THRESHOLD',
          anchorPlayId: input.anchorPlay.id,
          period,
          playerToken: passerToken,
          playerDisplayName: passer.displayName,
          statType: 'PASSING_YARDS',
          target: 75,
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

  const variant = chooseRedZoneVariant(driveId)
  const question =
    variant === 'PASSING_TOUCHDOWN'
      ? `Will ${teamCode} score a passing touchdown on this red-zone trip?`
      : variant === 'RUSHING_TOUCHDOWN'
        ? `Will ${teamCode} score a rushing touchdown on this red-zone trip?`
        : `Will ${teamCode} score a touchdown on this red-zone trip?`
  const resolutionContext = {
    ...buildBaseContext(input, 'NFL_RED_ZONE'),
    redZoneVariant: variant,
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
      templateId: `NFL_RED_ZONE_${variant}`,
      question,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 8 * 60_000,
      resolutionContext,
      trigger: 'nfl:red_zone_entry',
    }),
  }
}

const buildFieldGoalCandidate = (
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
  const fieldPosition = previousPlay?.end
  if (
    !previousPlay ||
    !teamCode ||
    fieldPosition?.down !== 4 ||
    fieldPosition.yardsToEndzone === null ||
    fieldPosition.yardsToEndzone > 45 ||
    !possessionStayedWithDriveTeam(play, previousPlay) ||
    isDriveTerminalPlay(previousPlay)
  ) {
    return null
  }

  return {
    priority: 'FIELD_GOAL',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey: null,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: play.driveId,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_POSSESSION_FIELD_GOAL',
      question: `Will ${teamCode} make a field goal on this possession?`,
      windowType: 'NFL_DRIVE',
      resolutionWindowMs: 3 * 60_000,
      resolutionContext: buildBaseContext(input, 'NFL_FIELD_GOAL'),
      trigger: 'nfl:timeout_field_goal_range',
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
    distance > 3 ||
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
      templateId: 'NFL_FOURTH_DOWN_CONVERSION',
      question: `Will ${teamCode} convert this ${downLabel}?`,
      windowType: 'NFL_NEXT_PLAY',
      resolutionWindowMs: 4 * 60_000,
      resolutionContext: buildBaseContext(input, 'NFL_FOURTH_DOWN_CONVERSION'),
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

  const receivers = getReceiverUsage(input).slice(0, 4)
  if (receivers.length < 3) return null
  const choices = [
    ...receivers.map(({ athlete }) => ({
      id: athlete.id,
      value: athlete.displayName,
    })),
    { id: 'other', value: 'Someone else' },
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
      windowType: 'NFL_NEXT_TARGET',
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
      templateId: 'NFL_NEXT_OFFENSIVE_PLAY_PASS',
      question: `Will ${teamCode}'s next offensive play be a pass?`,
      windowType: 'NFL_NEXT_PLAY',
      resolutionWindowMs: 2 * 60_000,
      resolutionContext: buildBaseContext(input, 'NFL_NEXT_PLAY_PASS'),
      trigger: 'nfl:timeout_next_play',
    }),
  }
}

const isFinalTwoMinutesOfHalf = (play: EspnNflPlay): boolean =>
  (play.period === 2 || play.period === 4) &&
  parseClockMs(play.clock) <= 120_000

const buildReceiverTargetCandidate = (
  input: BuildCandidateInput
): NflQuestionCandidate | null => {
  const play = input.anchorPlay
  const driveId = play.driveId
  const teamCode = getDriveTeamCode(play)
  const anchorWallclockMs = getNflPlayWallclockMs(play)
  if (
    !driveId ||
    !teamCode ||
    anchorWallclockMs === null ||
    isDriveTerminalPlay(play) ||
    play.end?.down === 4 ||
    STOPPAGE_PLAY_PATTERN.test(play.type) ||
    /no huddle/i.test(`${play.type} ${play.text}`) ||
    !hasStableDriveContext(input) ||
    isFinalTwoMinutesOfHalf(play)
  ) {
    return null
  }

  const anchorIndex = input.plays.findIndex(
    (candidate) => candidate.id === play.id
  )
  if (anchorIndex <= 0) return null
  const latestTargetByPlayer = new Map<
    string,
    { token: string; wallclockMs: number; targetCount: number }
  >()
  for (const previousPlay of input.plays.slice(0, anchorIndex)) {
    if (previousPlay.driveId !== driveId) continue
    const target = extractNflPassTarget(previousPlay)
    const wallclockMs = getNflPlayWallclockMs(previousPlay)
    if (!target || wallclockMs === null) continue
    const targetKey = normalizeTarget(target)
    const existing = latestTargetByPlayer.get(targetKey)
    latestTargetByPlayer.set(targetKey, {
      token: target,
      wallclockMs,
      targetCount: (existing?.targetCount ?? 0) + 1,
    })
  }

  const currentTarget = extractNflPassTarget(play)
  if (currentTarget) {
    const targetKey = normalizeTarget(currentTarget)
    const existing = latestTargetByPlayer.get(targetKey)
    latestTargetByPlayer.set(targetKey, {
      token: currentTarget,
      wallclockMs: anchorWallclockMs,
      targetCount: (existing?.targetCount ?? 0) + 1,
    })
  }

  const eligibleTargets = [...latestTargetByPlayer.values()]
    .filter(
      (target) =>
        target.targetCount >= 2 &&
        anchorWallclockMs - target.wallclockMs >= NFL_RECEIVER_TARGET_QUIET_MS
    )
    .sort(
      (left, right) =>
        right.targetCount - left.targetCount ||
        right.wallclockMs - left.wallclockMs
    )
  const target = eligibleTargets.find(
    (candidate) =>
      !input.receiverQuestionKeys.includes(
        `${driveId}:${normalizeTarget(candidate.token)}`
      )
  )
  if (!target) return null

  const receiverQuestionKey = `${driveId}:${normalizeTarget(target.token)}`
  const targetDisplayName = findTargetDisplayName(
    target.token,
    play.driveTeamId,
    input.athletes
  )
  const resolutionContext = {
    ...buildBaseContext(input, 'NFL_NEXT_TARGET'),
    targetToken: target.token,
    targetDisplayName,
    targetLastSeenAtMs: target.wallclockMs,
    targetQuietWindowMs: NFL_RECEIVER_TARGET_QUIET_MS,
  }
  return {
    priority: 'RECEIVER_TARGET',
    redZoneDriveId: null,
    redZonePeriodKey: null,
    receiverQuestionKey,
    completionReceiverHalfKey: null,
    timeoutQuestionDriveId: null,
    gameQuestionKey: null,
    periodQuestionKey: null,
    payload: buildPayload(input, {
      templateId: 'NFL_RECEIVER_NEXT_TARGET_CAUGHT',
      question: `On ${teamCode}'s current drive, will ${targetDisplayName} catch his next target?`,
      windowType: 'NFL_NEXT_TARGET',
      resolutionWindowMs: 5 * 60_000,
      resolutionContext,
      trigger: 'nfl:receiver_target_quiet_window',
    }),
  }
}

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

  const candidates = [
    buildGameWinnerCandidate(input),
    buildRedZoneCandidate(input),
    buildFourthDownCandidate(input),
    buildFieldGoalCandidate(input),
    buildPeriodTeamCandidate(input),
    buildNextCompletionReceiverCandidate(input),
    buildTimeoutNextPlayCandidate(input),
    buildPeriodPlayerCandidate(input),
    buildReceiverTargetCandidate(input),
  ].filter((candidate): candidate is NflQuestionCandidate => candidate !== null)

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
    contextType !== 'NFL_PERIOD_PLAYER_THRESHOLD'
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
    if (
      !homeTeam ||
      !awayTeam ||
      homeScore === null ||
      awayScore === null ||
      homeScore === awayScore
    ) {
      return { state: 'cancelled', answer: null, reason: 'TIE_OR_NO_SCORE' }
    }
    return {
      state: 'resolved',
      answer: homeScore > awayScore ? homeTeam : awayTeam,
      reason: null,
    }
  }

  if (
    contextType === 'NFL_PERIOD_TEAM_COMPARE' ||
    contextType === 'NFL_PERIOD_PLAYER_THRESHOLD'
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
    if (contextType === 'NFL_PERIOD_TEAM_COMPARE') {
      const statType = asContextString(context, 'statType')
      const homeStats = periodStats.teams.get(homeTeam)
      const awayStats = periodStats.teams.get(awayTeam)
      if (!homeStats || !awayStats || !statType) {
        return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
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
        return { state: 'cancelled', answer: null, reason: 'TIE' }
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
    if (!playerToken || !statType || target === null) {
      return { state: 'cancelled', answer: null, reason: 'MISSING_STATS' }
    }
    const playerStats = periodStats.players.get(normalizeTarget(playerToken))
    const value =
      statType === 'RECEPTIONS'
        ? (playerStats?.receptions ?? 0)
        : statType === 'RUSHING_YARDS'
          ? (playerStats?.rushingYards ?? 0)
          : (playerStats?.passingYards ?? 0)
    return {
      state: 'resolved',
      answer: value >= target ? 'yes' : 'no',
      reason: null,
    }
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
        state: 'cancelled',
        answer: null,
        reason: 'NO_FOURTH_DOWN_PLAY',
      }
    }
    return null
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
          state: 'cancelled',
          answer: null,
          reason: 'UNRESOLVED_PASS_TARGET',
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
        state: 'cancelled',
        answer: null,
        reason: 'NO_COMPLETED_PASS',
      }
    }
    if (gameCompleted) {
      return {
        state: 'cancelled',
        answer: null,
        reason: 'NO_COMPLETED_PASS',
      }
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
