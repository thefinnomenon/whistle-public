import type { Timestamp } from 'firebase/firestore'

export type FirestoreTimestamp = Timestamp

export type LoginType = 'Google' | 'Apple'

export type UserGame = {
  score: number
  predictions: {
    [questionId: string]: { prediction: string; createdAt: Timestamp }
  }
  updatedAt: FirestoreTimestamp
}

export type GamePlayer = {
  score: number
  username: string
  platform?: string
  updatedAt: FirestoreTimestamp
}

export type User = {
  id: string
  email?: string
  username?: string
  loginMethod?: LoginType
  isAdmin?: boolean
  winnings?: number
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
  prizeType?: 'USD' | 'POINTS'
  playerCount: number
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  leaderboard?: LeaderboardItem[]
  statistics?: GameStatistics
  sport?: Sport
  league?: League
}

export type LeaderboardItem = {
  place: number
  username: string
  score: number
}

export type QuestionType = 'YESNO' | 'MULTIPLE_CHOICE'
export type QuestionState = 'open' | 'closed' | 'resolved' | 'cancelled'
export type QuestionWindowType = 'PERIOD' | 'NEXT_N_MIN' | 'GAME' | 'JUMP_BALL'
export type QuestionCancelReason = 'MANUAL' | 'VOID' | 'RESOLVED_WHILE_OPEN'

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
