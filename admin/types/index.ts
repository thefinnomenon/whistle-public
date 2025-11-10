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
  updatedAt: FirestoreTimestamp
}

export type User = {
  id: string
  email?: string
  username?: string
  loginMethod?: LoginType
  isAdmin?: boolean
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
}

export type Username = {
  user: string
}

export type GameState = 'scheduled' | 'open' | 'resolved' | 'cancelled'

export type Game = {
  id: string
  state: GameState
  homeTeam: string
  awayTeam: string
  startTime: FirestoreTimestamp
  prize: number
  userCount: number
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  leaderboard?: LeaderboardItem[]
}

export type LeaderboardItem = {
  place: number
  username: string
  score: number
}

export type QuestionType = 'YESNO' | 'MULTIPLE_CHOICE'
export type QuestionState = 'open' | 'closed' | 'resolved' | 'cancelled'

export type Question = {
  id: string
  state: QuestionState
  type: QuestionType
  question: string
  choices: string[]
  answer?: boolean
  triggeredAt: FirestoreTimestamp
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  closedAt?: FirestoreTimestamp
  resolvedAt?: FirestoreTimestamp
  cancelledAt?: FirestoreTimestamp
  changedAt?: FirestoreTimestamp

  // Statistics fields (set when question is closed/resolved/cancelled)
  totalResponses?: number
  totalPlayers?: number
  responseRate?: number
  yesCount?: number
  noCount?: number
  correctCount?: number
  incorrectCount?: number
  questionOpenTimeMs?: number
  questionResolutionTimeMs?: number
  avgResponseTimeMs?: number
  medianResponseTimeMs?: number
  p95ResponseTimeMs?: number
  minResponseTimeMs?: number
  maxResponseTimeMs?: number
  avgDeliveryTimeMs?: number
  medianDeliveryTimeMs?: number
  p95DeliveryTimeMs?: number
  minDeliveryTimeMs?: number
  maxDeliveryTimeMs?: number
}

export type Prediction = {
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
