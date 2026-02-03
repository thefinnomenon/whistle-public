export enum EngineEventSource {
  NBA_COM = 'NBA_COM',
}

export enum EventType {
  MADE_FG = 'MADE_FG',
  MISSED_FG = 'MISSED_FG',
  MADE_3 = 'MADE_3',
  MISSED_3 = 'MISSED_3',
  MADE_FT = 'MADE_FT',
  MISSED_FT = 'MISSED_FT',
  FOUL = 'FOUL',
  TURNOVER = 'TURNOVER',
  REBOUND = 'REBOUND',
  STEAL = 'STEAL',
  BLOCK = 'BLOCK',
  SUBSTITUTION = 'SUBSTITUTION',
  TIMEOUT = 'TIMEOUT',
  PERIOD_START = 'PERIOD_START',
  PERIOD_END = 'PERIOD_END',
  GAME_END = 'GAME_END',
  JUMP_BALL = 'JUMP_BALL',
  REVIEW = 'REVIEW',
  ATTEMPT_3 = 'ATTEMPT_3',
  OTHER = 'OTHER',
}

export enum NbaEventSubType {
  ONE_OF_ONE = '1_OF_1',
  ONE_OF_TWO = '1_OF_2',
  TWO_OF_TWO = '2_OF_2',
  START = 'START',
  END = 'END',
  DEFENSIVE = 'DEFENSIVE',
  OFFENSIVE = 'OFFENSIVE',
  BAD_PASS = 'BAD_PASS',
  BACKCOURT = 'BACKCOURT',
  DELAY_OF_GAME = 'DELAY_OF_GAME',
  FULL = 'FULL',
  IN = 'IN',
  KICKED_BALL = 'KICKED_BALL',
  LOST_BALL = 'LOST_BALL',
  OFFENSIVE_FOUL = 'OFFENSIVE_FOUL',
  OFFENSIVE_KICKED_BALL = 'OFFENSIVE_KICKED_BALL',
  OUT = 'OUT',
  OUT_OF_BOUNDS = 'OUT_OF_BOUNDS',
  PERSONAL = 'PERSONAL',
  RECOVERED = 'RECOVERED',
  SHOT_CLOCK = 'SHOT_CLOCK',
  DUNK = 'DUNK',
  HOOK = 'HOOK',
  JUMP_SHOT = 'JUMP_SHOT',
  LAYUP = 'LAYUP',
  TECHNICAL = 'TECHNICAL',
  FLAGRANT = 'FLAGRANT',
  SHOOTING = 'SHOOTING',
  LOOSE_BALL = 'LOOSE_BALL',
  CHARGE = 'CHARGE',
  UNKNOWN = 'UNKNOWN',
  OTHER = 'OTHER',
}

export enum NbaEventResult {
  MADE = 'MADE',
  MISSED = 'MISSED',
  NA = 'NA',
  UNKNOWN = 'UNKNOWN',
}

export type BoxScorePeriod = {
  period?: number
  periodType?: string
  score?: number
}

export type BoxScoreTeamStats = {
  points?: number
  assists?: number
  reboundsTotal?: number
  rebounds?: number
  steals?: number
  blocks?: number
  threePointersMade?: number
  fg3m?: number
}

export type BoxScorePlayerPeriodStats = {
  period?: number
  statistics?: BoxScorePlayerPeriodStats
  points?: number
  reboundsTotal?: number
  rebounds?: number
  assists?: number
  steals?: number
  blocks?: number
  threePointersMade?: number
  fg3m?: number
  freeThrowsMade?: number
  ftm?: number
}

export type BoxScorePlayerStats = {
  points?: number
  reboundsTotal?: number
  rebounds?: number
  assists?: number
  steals?: number
  blocks?: number
  threePointersMade?: number
  fg3m?: number
  freeThrowsMade?: number
  ftm?: number
  periods?: BoxScorePlayerPeriodStats[]
}

export type BoxScorePlayer = {
  personId?: number
  playerId?: number
  teamId?: number | string
  teamTricode?: string
  teamAbbreviation?: string
  team?: { teamId?: number | string }
  name?: string
  firstName?: string
  lastName?: string
  isOnCourt?: boolean
  oncourt?: string | number
  status?: string
  statistics?: BoxScorePlayerStats
  periods?: BoxScorePlayerPeriodStats[]
  stats?: { periods?: BoxScorePlayerPeriodStats[] }
}

export type BoxScoreTeam = {
  teamId?: number
  teamName?: string
  teamCity?: string
  teamTricode?: string
  score?: number
  inBonus?: string | number
  timeoutsRemaining?: number
  statistics?: BoxScoreTeamStats
  periods?: BoxScorePeriod[]
  players?: BoxScorePlayer[]
}

export type BoxScoreGame = {
  gameId?: string | number | null
  gameStatus?: number | string | null
  gameStatusText?: string | null
  period?: number | null
  gameClock?: string | null
  homeTeam?: BoxScoreTeam | null
  awayTeam?: BoxScoreTeam | null
}

export type BoxScore = {
  gameId?: string | number | null
  gameStatus?: number | string | null
  gameStatusText?: string | null
  period?: number | null
  gamePeriod?: number | null
  gameClock?: string | null
  homeTeam?: BoxScoreTeam | null
  awayTeam?: BoxScoreTeam | null
  game?: BoxScoreGame | null
}

export type FirestoreTimestampLike = {
  toDate?: () => Date
}

export type EngineIngestedAt =
  | FirestoreTimestampLike
  | object
  | number
  | string
  | null

export type EngineGameState = {
  period: number | null
  clockMs: number | null
  scoreHome: number | null
  scoreAway: number | null
  possession: number | string | null
  boxScore: BoxScore | null
}

export type NbaFreeThrowContext = {
  shooterId: number | null
  teamId: number | null
  teamTricode: string | null
  result: NbaEventResult
  attemptsTotal: number | null
  attemptNumber: number | null
}

export type NbaShotContext = {
  shooterId: number | null
  teamId: number | null
  teamTricode: string | null
  result: NbaEventResult
  shotType: NbaEventSubType | null
}

export type NbaEventContext = {
  freeThrow?: NbaFreeThrowContext
  shot?: NbaShotContext
  primaryPlayerId?: number | null
  secondaryPlayerIds?: number[]
  teamId?: number | null
  teamTricode?: string | null
  raw?: Record<string, string>
}

export type EngineEvent = {
  eventId: number
  source: EngineEventSource
  type: EventType
  subType: NbaEventSubType
  context: NbaEventContext | null
  description: string
  questionId: string | null
  gameState: EngineGameState
  ingestedAt: EngineIngestedAt
}
