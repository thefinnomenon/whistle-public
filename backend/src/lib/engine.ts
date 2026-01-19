import { createHmac } from 'crypto'
import type { EngineEvent, EngineGameState } from '../types/engine'
import { EngineEventSource, EventType, NbaEventSubType } from '../types/engine'
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

type QuestionTemplate = {
  id: string
  text: string
  weight: number
  windowType: QuestionWindowType
  resolutionWindowMs?: number | null
  resolutionContext?: Record<string, any>
}

export type EngineQuestionPayload = {
  templateId: string
  question: string
  windowType: QuestionWindowType
  timeoutMs: number
  resolutionWindowMs?: number | null
  resolutionContext?: Record<string, any>
  trigger: string
  period: number
  clockMs: number
}

type TriggerOptions = {
  nowMs?: number
  bypassMarginConditions?: boolean
  bypassCooldown?: boolean
  suppressLogs?: boolean
  delayMs?: number
  persistQuestions?: boolean
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
    teamsById: Map<string, TeamSeasonProfile>
  }
}

const LAST_QUESTION_AT_BY_GAME = new Map<string, number>()
const GAME_START_ASKED_BY_GAME = new Set<string>()
const PERIOD_GROUPS_BY_GAME = new Map<string, Map<number, Set<string>>>()
const HALF_GROUPS_BY_GAME = new Map<string, Map<number, Set<string>>>()
const GAME_GROUPS_BY_GAME = new Map<string, Set<string>>()
const PLAYER_IDS_BY_GAME = new Map<string, Map<number, Set<number>>>()
const QUESTION_SIGNATURE_SECRET = process.env.WHISTLE_JWT_SECRET
const QUESTION_PAYLOAD_VERSION = 1
const MIN_QUESTION_INTERVAL_MS = 5 * 60 * 1000
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
  players: any[],
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
    if (statType === 'BLOCKS') return profile.isBlocksCandidate
    return profile.isScoringCandidate
  })
  return filtered.length ? filtered : players
}

const MULTI_CHOICE_TEMPLATE_IDS = new Set([
  'GAME_WINNER',
  'JUMP_BALL_WINNER',
  'PERIOD_LEADER',
])

const buildSignedQuestionPayload = (payload: Record<string, any>) => {
  if (!QUESTION_SIGNATURE_SECRET) {
    throw new Error('Missing WHISTLE_JWT_SECRET')
  }
  const payloadString = JSON.stringify(payload)
  const signature = createHmac('sha256', QUESTION_SIGNATURE_SECRET)
    .update(payloadString)
    .digest('hex')
  return { payloadString, signature }
}

const buildQuestionChoices = (
  question: EngineQuestionPayload
): { id: string; value: string }[] => {
  if (MULTI_CHOICE_TEMPLATE_IDS.has(question.templateId)) {
    const home = question.resolutionContext?.homeTricode ?? 'HOME'
    const away = question.resolutionContext?.awayTricode ?? 'AWAY'
    return [
      { id: 'home', value: String(home) },
      { id: 'away', value: String(away) },
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
    windowType: question.windowType,
    resolutionWindowMs: question.resolutionWindowMs ?? null,
    resolutionContext: question.resolutionContext ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
  }

  const qRef = await db
    .collection('games')
    .doc(gameId)
    .collection('questions')
    .add(questionPayload)

  const baseQuestionPayload = {
    version: QUESTION_PAYLOAD_VERSION,
    gameId,
    questionId: qRef.id,
    question: question.question,
    choices,
    timeoutAt,
    engineTag: question.templateId,
    windowType: question.windowType,
    resolutionWindowMs: question.resolutionWindowMs ?? null,
    resolutionContext: question.resolutionContext ?? null,
  }
  const { payloadString, signature } =
    buildSignedQuestionPayload(baseQuestionPayload)

  const topic = `game_${gameId}`
  const collapseId = topic
  const message = {
    topic,
    data: {
      type: 'question',
      gameId,
      questionId: qRef.id,
      question: question.question,
      sentAt: now.toString(),
      engineTag: question.templateId,
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
            title: 'New Question',
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

  await admin.messaging().send(message as any)
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
  TIMEOUT_TEAM_SCORE_AFTER: { name: 'TIMEOUT_TEAM_SCORE', scope: 'PERIOD' },
  TIMEOUT_FIRST_PLAY: { name: 'TIMEOUT_FIRST_PLAY', scope: 'PERIOD' },
  FOUL_TEAM_SCORE_AFTER_FT: { name: 'FOUL_TEAM_SCORE', scope: 'PERIOD' },
  FOUL_FIRST_PLAY_AFTER_FT: { name: 'FOUL_FIRST_PLAY', scope: 'PERIOD' },
  PERIOD_TEAM_REBOUNDS: { name: 'TEAM_REBOUNDS', scope: 'PERIOD' },
  PERIOD_TEAM_ASSISTS: { name: 'TEAM_ASSISTS', scope: 'PERIOD' },
  PERIOD_TEAM_STEALS: { name: 'TEAM_STEALS', scope: 'PERIOD' },
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

const getPeriodPlayerSet = (gameId: string, period: number): Set<number> => {
  const gamePeriods = PLAYER_IDS_BY_GAME.get(gameId)
  const periodPlayers = gamePeriods?.get(period)
  return periodPlayers ?? new Set()
}

const markPlayerAsked = (
  gameId: string,
  period: number,
  playerId: number | null
): void => {
  if (!playerId) return
  let gamePeriods = PLAYER_IDS_BY_GAME.get(gameId)
  if (!gamePeriods) {
    gamePeriods = new Map()
    PLAYER_IDS_BY_GAME.set(gameId, gamePeriods)
  }
  let periodPlayers = gamePeriods.get(period)
  if (!periodPlayers) {
    periodPlayers = new Set()
    gamePeriods.set(period, periodPlayers)
  }
  periodPlayers.add(playerId)
}

const TIMEOUT_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'TIMEOUT_TEAM_SCORE_AFTER',
    text: 'After the timeout, will the home team score?',
    weight: 2,
    windowType: 'NEXT_N_MIN',
    resolutionWindowMs: 90_000,
    resolutionContext: { type: 'TEAM_SCORE_AFTER_TIMEOUT', team: 'HOME' },
  },
  {
    id: 'TIMEOUT_FIRST_PLAY',
    text: 'After the timeout, will the first play be a made field goal?',
    weight: 2,
    windowType: 'NEXT_EVENT',
    resolutionWindowMs: null,
    resolutionContext: { type: 'NEXT_EVENT', expectedEventType: 'MADE_FG' },
  },
]

const FOUL_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'FOUL_TEAM_SCORE_AFTER_FT',
    text: 'After the free throws, will the away team score on their next possession?',
    weight: 2,
    windowType: 'NEXT_EVENT',
    resolutionWindowMs: null,
    resolutionContext: { type: 'TEAM_SCORE_AFTER_FREETHROWS', team: 'AWAY' },
  },
  {
    id: 'FOUL_FIRST_PLAY_AFTER_FT',
    text: 'After the free throws, will the first play be a made field goal?',
    weight: 2,
    windowType: 'NEXT_EVENT',
    resolutionWindowMs: null,
    resolutionContext: { type: 'NEXT_EVENT', expectedEventType: 'MADE_FG' },
  },
]

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
]

const PLAYER_TEMPLATES: QuestionTemplate[] = [
  {
    id: 'PERIOD_PLAYER_MILESTONE',
    text: 'Will a player reach 10+ points this quarter?',
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
    text: 'Will a player record 3+ assists this quarter?',
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
    text: 'Will a player record 4+ rebounds this quarter?',
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
    text: 'Will a player record 2+ steals this quarter?',
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

const isShootingFoulWithShots = (event: EngineEvent): boolean => {
  const desc = String(event.description || '').toLowerCase()
  const hasShots =
    desc.includes('2 shots') ||
    desc.includes('two shots') ||
    desc.includes('3 shots') ||
    desc.includes('three shots')
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

const getBoxScoreTeams = (boxScore: Record<string, any> | null) => {
  const game = boxScore?.game
  return {
    homeTeam: game?.homeTeam ?? boxScore?.homeTeam ?? null,
    awayTeam: game?.awayTeam ?? boxScore?.awayTeam ?? null,
  }
}

const buildTeamStatTemplate = (
  template: QuestionTemplate
): QuestionTemplate => {
  const statType = template.resolutionContext?.statType ?? 'REBOUNDS'
  const team = pickFrom(['HOME', 'AWAY'] as const)
  const target =
    statType === 'ASSISTS'
      ? pickFrom([6, 8, 10])
      : statType === 'STEALS'
        ? pickFrom([3, 4, 5])
        : pickFrom([10, 12, 14])
  const label =
    statType === 'ASSISTS'
      ? 'assists'
      : statType === 'STEALS'
        ? 'steals'
        : 'rebounds'
  return {
    ...template,
    text: `Will the ${team === 'HOME' ? 'home team' : 'away team'} record ${target}+ ${label} this quarter?`,
    resolutionContext: {
      ...(template.resolutionContext ?? {}),
      team,
      target,
    },
  }
}

const buildPlayerMilestoneTemplate = (
  template: QuestionTemplate,
  boxScore: Record<string, any> | null,
  excludeIds?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  }
): QuestionTemplate => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: any[] = []
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
    ? pool.filter((player) => !excludeIds.has(player?.personId))
    : pool
  const pickPool = filteredPool.length ? filteredPool : excludeIds ? [] : pool
  const statType = template.resolutionContext?.statType ?? 'POINTS'
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
  const teamTricode =
    typeof choice?.teamTricode === 'string'
      ? choice.teamTricode
      : typeof choice?.teamAbbreviation === 'string'
        ? choice.teamAbbreviation
        : choice?.teamId === homeTeam?.teamId
          ? (homeTeam?.teamTricode ?? null)
          : choice?.teamId === awayTeam?.teamId
            ? (awayTeam?.teamTricode ?? null)
            : null
  const target = template.resolutionContext?.target ?? 10
  const baseLabel =
    statType === 'ASSISTS'
      ? 'assists'
      : statType === 'REBOUNDS'
        ? 'rebounds'
        : statType === 'STEALS'
          ? 'steals'
          : 'points'
  const questionText = playerName
    ? `Will ${playerName} record ${target}+ ${baseLabel} this quarter?`
    : template.text
  return {
    ...template,
    text: questionText,
    resolutionContext: {
      ...(template.resolutionContext ?? {}),
      playerId,
      playerName,
      teamTricode,
      statType,
      target,
    },
  }
}

const resolveTeamText = (
  text: string,
  boxScore: Record<string, any> | null
): string => {
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
  boxScore: Record<string, any> | null,
  playerExclude?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  }
): QuestionTemplate => {
  let resolvedTemplate = template
  if (PLAYER_TEMPLATE_IDS.has(template.id)) {
    resolvedTemplate = buildPlayerMilestoneTemplate(
      template,
      boxScore,
      playerExclude,
      seasonProfiles
    )
  }
  if (template.id === 'PERIOD_ANY_3') {
    resolvedTemplate = buildPeriodThreeTemplate(resolvedTemplate)
  }
  if (template.resolutionContext?.type === 'TEAM_STAT_THIS_PERIOD') {
    resolvedTemplate = buildTeamStatTemplate(resolvedTemplate)
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
  boxScore: Record<string, any> | null,
  triggerReason: string,
  playerExclude?: Set<number>,
  seasonProfiles?: {
    playersById: Map<string, PlayerSeasonProfile>
  }
): EngineQuestionPayload => {
  const resolvedTemplate = resolveTemplate(
    template,
    boxScore,
    playerExclude,
    seasonProfiles
  )
  const resolutionWindowMs = computeResolutionWindowMs(resolvedTemplate, event)
  const resolutionContext = buildResolutionContext(
    resolvedTemplate,
    event,
    boxScore,
    resolutionWindowMs
  )
  return {
    templateId: resolvedTemplate.id,
    question: resolvedTemplate.text,
    windowType: resolvedTemplate.windowType,
    timeoutMs: QUESTION_TIMEOUT_MS,
    resolutionWindowMs,
    resolutionContext,
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
  boxScore: Record<string, any> | null,
  opts?: TriggerOptions
): EngineQuestionPayload[] => {
  if (GAME_START_ASKED_BY_GAME.has(gameId)) return []
  const templates: QuestionTemplate[] = [
    {
      id: 'GAME_WINNER',
      text: 'Who will win the game?',
      weight: 1,
      windowType: 'GAME',
    },
    {
      id: 'JUMP_BALL_WINNER',
      text: 'Who will win the opening jump ball?',
      weight: 1,
      windowType: 'JUMP_BALL',
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
  boxScore: Record<string, any> | null,
  team: 'HOME' | 'AWAY',
  statType: string
): number | null => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const teamData = team === 'HOME' ? homeTeam : awayTeam
  const stats = teamData?.statistics
  if (!stats) return null
  const key = String(statType || '').toUpperCase()
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'REBOUNDS') return Number(stats.reboundsTotal ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  return null
}

const buildResolutionContext = (
  template: QuestionTemplate,
  event: EngineEvent,
  boxScore: Record<string, any> | null,
  resolutionWindowMs: number | null
): Record<string, any> => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeTricode =
    homeTeam?.teamTricode ??
    event.gameState?.boxScore?.homeTeam?.teamTricode ??
    null
  const awayTricode =
    awayTeam?.teamTricode ??
    event.gameState?.boxScore?.awayTeam?.teamTricode ??
    null
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

  switch (template.resolutionContext?.type) {
    case 'TOTAL_POINTS_NEXT_N': {
      const home = coerceScore(event.gameState?.scoreHome) ?? 0
      const away = coerceScore(event.gameState?.scoreAway) ?? 0
      const currentTotal = home + away
      return {
        ...base,
        minTotalScore: currentTotal + (template.resolutionContext?.target ?? 0),
      }
    }
    case 'TEAM_POINTS_NEXT_N':
    case 'TEAM_POINTS_REST_PERIOD':
    case 'TEAM_POINTS_THIS_PERIOD': {
      const team = template.resolutionContext?.team ?? 'HOME'
      const current = getTeamScore(event, team) ?? 0
      return {
        ...base,
        team,
        minTeamScore: current + (template.resolutionContext?.target ?? 0),
      }
    }
    case 'TEAM_STAT_THIS_PERIOD': {
      const team = template.resolutionContext?.team ?? 'HOME'
      const statType = template.resolutionContext?.statType ?? null
      const current = getTeamStat(boxScore, team, statType) ?? 0
      return {
        ...base,
        team,
        statType,
        minTeamStat: current + (template.resolutionContext?.target ?? 0),
      }
    }
    case 'BOTH_TEAMS_10_REST_PERIOD': {
      const home = getTeamScore(event, 'HOME') ?? 0
      const away = getTeamScore(event, 'AWAY') ?? 0
      return {
        ...base,
        minHomeScore: home + (template.resolutionContext?.target ?? 0),
        minAwayScore: away + (template.resolutionContext?.target ?? 0),
      }
    }
    case 'MADE_3_COUNT_NEXT_N': {
      return {
        ...base,
        minMade3Count: template.resolutionContext?.target ?? 0,
        windowMs: resolutionWindowMs,
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
      return {
        ...base,
        endPeriod: base.startPeriod,
        minMade3Count: template.resolutionContext?.target ?? 0,
      }
    }
    case 'LEADER_END_OF_PERIOD': {
      return {
        ...base,
        endPeriod: base.startPeriod,
      }
    }
    case 'PLAYER_MILESTONE_PERIOD': {
      return {
        ...base,
        endPeriod: base.startPeriod,
        target: template.resolutionContext?.target ?? null,
        playerId: template.resolutionContext?.playerId ?? null,
      }
    }
    case 'TEAM_SCORE_AFTER_TIMEOUT':
    case 'TEAM_SCORE_AFTER_FREETHROWS': {
      const team = template.resolutionContext?.team ?? 'HOME'
      const current = getTeamScore(event, team) ?? 0
      return {
        ...base,
        team,
        minTeamScore: current + 1,
        windowMs: resolutionWindowMs,
      }
    }
    case 'NEXT_EVENT': {
      return {
        ...base,
        expectedEventType:
          template.resolutionContext?.expectedEventType ?? null,
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
      }
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
  boxScore: Record<string, any> | null,
  opts?: TriggerOptions
): Promise<EngineQuestionPayload | null> => {
  const now = opts?.nowMs ?? Date.now()
  const lastAskedAt = LAST_QUESTION_AT_BY_GAME.get(gameId)
  if (
    !opts?.bypassCooldown &&
    lastAskedAt &&
    now - lastAskedAt < MIN_QUESTION_INTERVAL_MS
  )
    return null

  const period = event.gameState?.period ?? null
  const clockMs = event.gameState?.clockMs ?? null
  if (!period || clockMs === null) return null

  const window = getPeriodWindow(clockMs)
  const isTimeout = event.type === EventType.TIMEOUT
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

  const canAsk = shouldAskQuestion(triggerProbability)

  if (!canAsk) return null

  LAST_QUESTION_AT_BY_GAME.set(gameId, now)
  void window

  const thresholdTemplates = getThresholdQuestionTemplates(event, opts)
  let candidates: QuestionTemplate[] = [
    ...QUESTION_TEMPLATES,
    ...thresholdTemplates,
    ...PLAYER_TEMPLATES,
  ]

  if (triggerReason === 'timeout') {
    candidates = [...TIMEOUT_TEMPLATES, ...PLAYER_TEMPLATES]
  } else if (triggerReason === 'foul') {
    candidates = [...FOUL_TEMPLATES, ...PLAYER_TEMPLATES]
  } else if (triggerReason === 'period_start') {
    candidates = [...PERIOD_START_TEMPLATES, ...candidates]
  }

  candidates = candidates.filter((template) => {
    if (!template.resolutionWindowMs) return true
    return template.resolutionWindowMs >= MIN_RESOLUTION_WINDOW_MS
  })
  candidates = candidates.filter((template) => {
    const group = QUESTION_GROUPS[template.id]
    return !hasGroup(gameId, period, group)
  })
  const template = weightedPick(candidates)
  if (!template) return null

  void boxScore
  const questionPayload = buildQuestionPayload(
    template,
    event,
    boxScore,
    triggerReason,
    getPeriodPlayerSet(gameId, period),
    opts?.seasonProfiles
  )
  if (
    PLAYER_TEMPLATE_IDS.has(template.id) &&
    !questionPayload.resolutionContext?.playerId
  ) {
    return null
  }
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
  if (PLAYER_TEMPLATE_IDS.has(template.id)) {
    markPlayerAsked(gameId, period, questionPayload.resolutionContext?.playerId)
  }
  markGroup(gameId, period, QUESTION_GROUPS[template.id])
  return questionPayload
}
