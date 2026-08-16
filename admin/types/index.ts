import type { Timestamp } from 'firebase/firestore'

export type FirestoreTimestamp = Timestamp

export type LoginType = 'Google' | 'Apple'

export type UserGame = {
  score: number
  predictions?: {
    [questionId: string]: { prediction: string; createdAt: Timestamp }
  }
  joinedAt?: FirestoreTimestamp
  updatedAt: FirestoreTimestamp
}

export type GamePlayer = {
  score: number
  username: string
  platform?: string
  joinedAt?: FirestoreTimestamp
  answersSubmitted?: number
  predictionsByQuestionId?: Record<string, string>
  scoreByQuestionId?: Record<string, number>
  cashEligibility?: {
    qualified: boolean
    answered: number
    requiredAnswers: number
    reason: 'qualified' | 'minimum_answers'
  }
  updatedAt: FirestoreTimestamp
}

export type User = {
  id: string
  email?: string
  username?: string
  loginMethod?: LoginType
  isAdmin?: boolean
  winnings?: number
  winningsCents?: number
  points?: number
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
}

export type Username = {
  user: string
}

export type GameState = 'scheduled' | 'open' | 'resolved' | 'cancelled'
export type Sport = 'BASKETBALL' | 'FOOTBALL'
export type League = 'NBA' | 'NFL'

export type Game = {
  id: string
  state: GameState
  homeTeam: string
  awayTeam: string
  startTime: FirestoreTimestamp
  prizeAmount: number
  prizeAmountCents?: number
  prizeType?: 'USD' | 'POINTS'
  playerCount: number
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  leaderboard?: LeaderboardItem[]
  statistics?: GameStatistics
  playerCountByPlatform?: PlayerCountByPlatform
  sport?: Sport
  league?: League
  isFeatured?: boolean
  featuredWeekKey?: string
  featuredDayKey?: string
  featuredPoolAmount?: number
  featuredPoolAnnouncements?: Partial<
    Record<'25' | '50' | '100', FirestoreTimestamp>
  >
  featuredPool50UnlockedAt?: FirestoreTimestamp
  featuredPool100UnlockedAt?: FirestoreTimestamp
  payoutStatus?: 'processing' | 'completed'
  payoutPrizeType?: 'USD' | 'POINTS'
  payoutTotalUnits?: number
  payoutWinnerCount?: number
  cashWinnerUserIds?: string[]
  payoutEligiblePlayerCount?: number
  payoutTopScore?: number | null
  payoutStartedAt?: FirestoreTimestamp
  payoutCompletedAt?: FirestoreTimestamp
  cashEligibilityMinAnswers?: number
}

export type PlayerCountByPlatform = {
  ios: number
  android: number
  web?: number
  unknown?: number
}

export type LeaderboardItem = {
  userId?: string
  place: number
  username: string
  score: number
}

export type QuestionType = 'YESNO' | 'MULTIPLE_CHOICE'
export type QuestionState = 'open' | 'closed' | 'resolved' | 'cancelled'
export type QuestionWindowType =
  | 'PERIOD'
  | 'NEXT_N_MIN'
  | 'NEXT_EVENT'
  | 'GAME'
  | 'JUMP_BALL'
  | 'NFL_NEXT_PLAY'
  | 'NFL_DRIVE'
  | 'NFL_NEXT_TARGET'
export type QuestionCancelReason =
  | 'MANUAL'
  | 'VOID'
  | 'RESOLVED_WHILE_OPEN'
  | 'NO_NEXT_OFFENSIVE_PLAY'
  | 'NO_FOURTH_DOWN_PLAY'
  | 'NO_NEXT_TARGET'
  | 'NO_COMPLETED_PASS'
  | 'UNRESOLVED_PASS_TARGET'
  | 'RED_ZONE_PRIORITY'
  | 'TIE'
  | 'TIE_OR_NO_SCORE'
  | 'INVALID_PERIOD'
  | 'MISSING_TEAMS'
  | 'MISSING_STATS'
  | 'GAME_ENDED'

export type Choice = {
  id: string
  value: string
}

export type MetricSummary = {
  avg: number
  p50: number
  p95: number
}

export type PlatformResponseStats = {
  totalResponses: number
  correctCount: number
  incorrectCount: number
  delivery?: MetricSummary
  open?: MetricSummary
  respond?: MetricSummary
  timeRemainingAtReceive?: MetricSummary
  timeRemainingAtOpen?: MetricSummary
}

export type QuestionStatistics = {
  totalResponses: number
  correctCount: number
  incorrectCount: number
  playerCount?: number
  responseRate?: number
  responseSourceCounts?: Record<string, number>
  responseByPlatform?: Record<string, PlatformResponseStats>
  unanswered?: number
  nseMissingCount?: number
  delivery?: MetricSummary
  open?: MetricSummary
  respond?: MetricSummary
  timeRemainingAtReceive?: MetricSummary
  timeRemainingAtOpen?: MetricSummary
  choiceCounts?: Record<string, number>
}

export type Question = {
  id: string
  state: QuestionState
  type: QuestionType
  question: string
  choices: Choice[]
  points?: number
  answer?: string
  timeoutAt: string
  windowType?: QuestionWindowType
  cancelReason?: QuestionCancelReason
  triggeredAt: FirestoreTimestamp
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  closedAt?: FirestoreTimestamp
  resolvedAt?: FirestoreTimestamp
  cancelledAt?: FirestoreTimestamp
  changedAt?: FirestoreTimestamp
  engineTag?: string
  nflDedupe?: {
    redZoneDriveId?: string
    redZonePeriodKey?: string
    receiverQuestionKey?: string
    completionReceiverHalfKey?: string
    timeoutQuestionDriveId?: string
    gameQuestionKey?: string
    periodQuestionKey?: string
  }
  engineVersion?: string
  avgResponseTimeMs?: number
  statistics?: QuestionStatistics
}

export type GameStatistics = {
  totalQuestionsAsked: number
  totalResolved: number
  totalCancelled: number
  totalResponses: number
  totalCorrect: number
  totalIncorrect: number
  accuracyRate?: number
  platformResponses?: Record<string, number>
  playerCountByPlatform?: Record<string, number>
  highestPlayerCount?: number
  avgResponsesPerQuestion?: number
  delivery?: MetricSummary
  open?: MetricSummary
  respond?: MetricSummary
  responseRateMetric?: MetricSummary
}

export type Prediction = {
  receivedAt: number
  prediction: string
  createdAt: FirestoreTimestamp
}

export type SimulationResolvedEvent = {
  eventId: number
  type: string
  description: string
  period: number | null
  clockMs: number | null
  timeActual: string | null
  rawActionPeriod: number | null
  rawActionClock: string | null
}

export type SimulationJsonPrimitive = string | number | boolean | null
export type SimulationJsonValue =
  | SimulationJsonPrimitive
  | SimulationJsonValue[]
  | { [key: string]: SimulationJsonValue }

export type SimulationQuestion = {
  id: string
  engineVersion: string
  templateId: string
  question: string
  windowType: string
  timeoutMs: number
  trigger: string
  period: number
  clockMs: number
  state: 'open' | 'closed' | 'resolved' | 'cancelled'
  choices: Choice[]
  points?: number
  resolutionContext?: { [key: string]: SimulationJsonValue }
  answer?: string | null
  cancelReason?: string
  resolvedAtEventId?: number
  resolvedEvent?: SimulationResolvedEvent
  result?: { [key: string]: SimulationJsonValue } | null
  createdAtMs?: number
  timeoutAtMs?: number
}

export type SimulatedGameResult = {
  gameId: string
  questions: SimulationQuestion[]
  counts: {
    open: number
    resolved: number
    cancelled: number
  }
  eventCount: number
}

export type OriginalSimComparisonQuestion = {
  id: string
  state: string
  question: string
  answer: string | null
  timeoutAtMs: number | null
  engineTag: string | null
  engineVersion: string | null
  templateId: string | null
  trigger: string | null
  windowType: string | null
  cancelReason: string | null
  createdAtMs: number | null
  triggeredAtMs: number | null
  closedAtMs: number | null
  resolvedAtMs: number | null
  cancelledAtMs: number | null
}

export type GameSimulationResponse = {
  ok: true
  gameId: string
  simulation: SimulatedGameResult
  originalQuestions: OriginalSimComparisonQuestion[]
  originalCounts: {
    total: number
    resolved: number
    cancelled: number
    openOrClosed: number
  }
  simulatedAtMs: number
}

export type NFL_Team =
  | 'ARI'
  | 'ATL'
  | 'BAL'
  | 'BUF'
  | 'CAR'
  | 'CHI'
  | 'CIN'
  | 'CLE'
  | 'DAL'
  | 'DEN'
  | 'DET'
  | 'GB'
  | 'HOU'
  | 'IND'
  | 'JAX'
  | 'KC'
  | 'LAC'
  | 'LAR'
  | 'LV'
  | 'MIA'
  | 'MIN'
  | 'NE'
  | 'NO'
  | 'NYG'
  | 'NYJ'
  | 'PHI'
  | 'PIT'
  | 'SEA'
  | 'SF'
  | 'TB'
  | 'TEN'
  | 'WAS'
