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
  predictions: {
    [questionId: string]: { prediction: string; createdAt: Timestamp }
  }
  updatedAt: FirestoreTimestamp
}

type GamePlayer = {
  score: number
  username: string
  place?: number
  updatedAt: FirestoreTimestamp
}

type User = {
  id: string
  email?: string
  username?: string
  loginMethod?: LoginType
  isAdmin?: boolean
  winnings?: number
  onboardingComplete?: boolean
  createdAt: FirestoreTimestamp
  updatedAt?: FirestoreTimestamp
  tokens: { [tokenId: string]: Token | FieldValue }
}

type Username = {
  user: string
}

type GameState = 'scheduled' | 'open' | 'resolved' | 'cancelled'

type Game = {
  id: string
  state: GameState
  prize: number
  homeTeam: NFL_Team
  awayTeam: NFL_Team
  userCount: number
  leaderboard: LeaderboardItem[]
  startTime: FirestoreTimestamp
  createdAt: FirestoreTimestamp
  closedAt: FirestoreTimestamp
  updatedAt: FirestoreTimestamp
}

type QuestionState = 'open' | 'closed' | 'resolved' | 'cancelled'
type UserQuestionState = QuestionState | 'correct' | 'incorrect'
type QuestionType = 'YESNO'

type Choice = { id: string; value: string }

type Question = {
  id: string
  state: QuestionState
  type: QuestionType
  question: string
  choices: Choice[]
  answer?: boolean
  engineTag?: string
  timeoutAt: string
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
