/// <reference types="nativewind/types" />

type FirestoreTimestamp =
  import('@react-native-firebase/firestore').FirebaseFirestoreTypes.Timestamp

type FieldValue =
  import('@react-native-firebase/firestore').FirebaseFirestoreTypes.FieldValue

type LoginType = 'Google' | 'Apple'

type Token = {
  token: string
  type: string
  updatedAt: admin.firestore.Timestamp
}

type UserGame = {
  score: number
  predictions?: {
    [questionId: string]: { prediction: string; createdAt: Timestamp }
  }
  joinedAt?: FirestoreTimestamp
  updatedAt: FirestoreTimestamp
}

type GamePlayer = {
  score: number
  username: string
  place?: number
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

type User = {
  id: string
  email?: string
  username?: string
  loginMethod?: LoginType
  isAdmin?: boolean
  winnings?: number
  winningsCents?: number
  points?: number
  onboardingComplete?: boolean
  onboardingPrediction?: Prediction
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  tokens: { [tokenId: string]: Token | FieldValue }
}

type Username = {
  user: string
}

type GameState = 'scheduled' | 'open' | 'resolved' | 'cancelled'
type Sport = 'BASKETBALL' | 'FOOTBALL'
type League = 'NBA' | 'NFL'

type Game = {
  id: string
  state: GameState
  prizeAmount: number
  prizeAmountCents?: number
  prizeType?: 'USD' | 'POINTS'
  homeTeam: NFL_Team
  awayTeam: NFL_Team
  playerCount: number
  playerCountByPlatform?: {
    ios: number
    android: number
    web?: number
    unknown?: number
  }
  leaderboard: LeaderboardItem[]
  startTime: FirestoreTimestamp
  createdAt: FirestoreTimestamp
  closedAt: FirestoreTimestamp
  updatedAt: FirestoreTimestamp
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

type QuestionState = 'open' | 'closed' | 'resolved' | 'cancelled'
type UserQuestionState = QuestionState | 'correct' | 'incorrect'
type QuestionType = 'YESNO' | 'MULTIPLE_CHOICE'
type QuestionWindowType =
  | 'PERIOD'
  | 'NEXT_N_MIN'
  | 'NEXT_EVENT'
  | 'GAME'
  | 'JUMP_BALL'
  | 'NFL_NEXT_PLAY'
  | 'NFL_DRIVE'
  | 'NFL_NEXT_TARGET'
type QuestionCancelReason = 'MANUAL' | 'VOID' | 'RESOLVED_WHILE_OPEN'

type Choice = { id: string; value: string }

type NflQuestionDedupe = {
  redZoneDriveId?: string
  redZonePeriodKey?: string
  receiverQuestionKey?: string
  completionReceiverHalfKey?: string
  timeoutQuestionDriveId?: string
  gameQuestionKey?: string
  periodQuestionKey?: string
}

type Question = {
  id: string
  state: QuestionState
  type: QuestionType
  question: string
  choices: Choice[]
  answer?: string
  points?: number
  engineTag?: string
  nflDedupe?: NflQuestionDedupe
  timeoutAt: string
  windowType?: QuestionWindowType
  cancelReason?: QuestionCancelReason
  triggeredAt: FirestoreTimestamp
  createdAt: FirestoreTimestamp
  updatedAt: FirestoreTimestamp
  cancelledAt?: FirestoreTimestamp
  resolvedAt?: FirestoreTimestamp
  closedAt?: FirestoreTimestamp
}

type Prediction = {
  createdAt: FirestoreTimestamp
  prediction: string
  source?: string
}

type LeaderboardItem = {
  userId: string
  username: string
  score: number
  place: number
}

type ListItemStyle = {
  bg: string
  text: string
  icon: IconProps
  iconColor: string
}

type NFL_Team =
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
