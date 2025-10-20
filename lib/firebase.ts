import { DocumentData } from '@google-cloud/firestore'
import { getAuth } from '@react-native-firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from '@react-native-firebase/firestore'

const db = getFirestore()
const auth = getAuth()

export { db }

const createCollection = <T = any>(collectionName: string) => {
  return collection<T, DocumentData>(db, collectionName)
}

/********************
  USERS COLLECTION
*********************/
export const usersCollection = createCollection<User>('users')
export const addUser = async (user: Omit<User, 'createdAt' | 'updatedAt'>) => {
  await setDoc(doc(db, 'users', user.id), {
    ...user,
    createdAt: serverTimestamp(),
  })
}
export const getUser = async (userId: string): Promise<User | undefined> =>
  (await getDoc(doc(db, 'users', userId))).data() as User | undefined
export const updateUser = async (userId: string, update: Partial<User>) => {
  await setDoc(
    doc(db, 'users', userId),
    { ...update, updatedAt: serverTimestamp() },
    { merge: true }
  )
}
export const deleteUser = async (userId: string, username?: string) => {
  const batch = writeBatch(db)

  // Delete user document
  batch.delete(doc(db, 'users', userId))

  // Delete username document if it exists
  if (username) {
    batch.delete(doc(db, 'usernames', username.toLowerCase()))
  }

  await batch.commit()

  // Delete Firebase Auth account
  const currentUser = auth.currentUser
  if (currentUser && currentUser.uid === userId) {
    await currentUser.delete()
  }
}

/***********************
  USER GAMES COLLECTION
************************/
export const createUserGamesCollection = (userId: string) => {
  return collection<UserGame, DocumentData>(db, `users/${userId}/games`)
}

export const updateUserGame = async (
  userId: string,
  gameId: string,
  update: Partial<UserGame>
) => {
  await setDoc(
    doc(db, `users/${userId}/games`, gameId),
    { ...update, updatedAt: serverTimestamp() },
    { merge: true }
  )
}

export const updateUserGamePrediction = async (
  userId: string,
  gameId: string,
  update: Partial<UserGame>
) => {
  await updateDoc(doc(db, `users/${userId}/games`, gameId), {
    ...update,
    updatedAt: serverTimestamp(),
  })
}

export const getUserGameStream = async (
  userId: string,
  gameId: string,
  setUserGame: (userGame?: UserGame) => void
): Promise<any> => {
  return onSnapshot(doc(db, `users/${userId}/games`, gameId), (snapshot) => {
    if (snapshot.exists()) {
      setUserGame(snapshot.data() as UserGame | undefined)
    } else {
      setUserGame(undefined)
    }
  })
}

/**********************
  USERNAMES COLLECTION
***********************/
export const usernamesCollection = createCollection<Username>('usernames')
export const setUsername = async (user: string, rawUsername: string) => {
  const username = rawUsername.trim().toLowerCase()
  console.log(`Trying to save username ${username} for user ${user}`)
  if (username.length <= 3 || username.length >= 20)
    throw Error('Username length must be between 3 and 20 characters.')
  if (username.includes(' ')) throw Error('Username cannot contain a space.')
  const usernameRef = doc(db, 'usernames', username)
  const usernameSnap = await getDoc(usernameRef)
  if (usernameSnap.exists())
    throw Error('Username not available. Please try another.')
  else {
    console.log('Setting username to ', username)
    const batch = writeBatch(db)
    batch.set(usernameRef, { user })
    batch.set(doc(db, 'users', user), { username }, { merge: true })
    await batch.commit()
  }
}

/********************
  GAMES COLLECTION
*********************/
export const gamesCollection = createCollection<Game>('games')

export const addGame = async (game: Omit<Game, 'id' | 'createdAt'>) => {
  const ref = doc(collection(db, 'games'))
  await setDoc(ref, {
    id: ref.id,
    ...game,
    createdAt: serverTimestamp(),
  })
}
export const getGame = async (gameId: string): Promise<Game | undefined> =>
  (await getDoc(doc(db, 'games', gameId))).data() as Game | undefined
export const getGames = async (setGames: (games: Game[]) => void) => {
  const q = query(collection(db, 'games'), orderBy('createdAt', 'asc'))
  return onSnapshot(q, (gamesSnap) => {
    if (!gamesSnap) {
      setGames([])
      return
    }
    setGames(
      gamesSnap.docs.map((gameSnap: any) => {
        return {
          ...(gameSnap.data() as Game),
          startTime: gameSnap.data().startTime,
          id: gameSnap.id,
        }
      })
    )
  })
}

export const getGameStream = async (
  gameId: string,
  setGame: (game: Game) => void
) => {
  return onSnapshot(
    doc(db, 'games', gameId),
    (gameSnap) => {
      if (!gameSnap.exists()) {
        console.log('Game not found')
        return
      }
      const game = {
        ...(gameSnap.data() as Game),
        id: gameSnap.id,
      }
      setGame(game)
    },
    (error) => {
      console.error('Error getting game:', error)
    }
  )
}

export const getLatestGame = async (setGame: (game: Game) => void) => {
  const q = query(
    collection(db, 'games'),
    orderBy('createdAt', 'desc'),
    limit(1)
  )
  return onSnapshot(
    q,
    (gamesSnap) => {
      if (!gamesSnap || gamesSnap.empty) {
        console.log('No games found')
        return
      }
      const game = gamesSnap.docs.map((gameSnap: any) => {
        return {
          ...(gameSnap.data() as Game),
          startTime: gameSnap.data().startTime,
          id: gameSnap.id,
        }
      })[0]
      setGame(game)
    },
    (error) => {
      console.error('Error getting latest game:', error)
    }
  )
}

export const updateGame = async (gameId: string, updates: Partial<Game>) => {
  await setDoc(
    doc(db, 'games', gameId),
    { ...updates, updatedAt: serverTimestamp() },
    { merge: true }
  )
}

export const deleteGame = async (gameId: string) => {
  await deleteDoc(doc(db, 'games', gameId))
}

/***********
  QUESTIONS
************/
export const createQuestionsCollection = (gameId: string) => {
  return collection<Question, DocumentData>(db, `games/${gameId}/questions`)
}

export const addQuestion = async (
  gameId: string,
  question: Omit<Question, 'id' | 'createdAt'>
) => {
  const ref = doc(collection(db, 'games'))
  await addDoc(collection(db, `games/${gameId}/questions`), {
    id: ref.id,
    ...question,
    createdAt: serverTimestamp(),
  })
}

export const getQuestionsStream = async (
  gameId: string,
  setQuestions: (questions: Question[]) => void
): Promise<any> => {
  const q = query(
    collection(db, `games/${gameId}/questions`),
    orderBy('createdAt', 'asc')
  )
  return onSnapshot(q, (questionsSnap) => {
    if (!questionsSnap || questionsSnap.empty) {
      setQuestions([])
      return
    }
    setQuestions(
      questionsSnap.docs.map((questionSnap: any) => {
        return {
          ...(questionSnap.data() as Question),
          id: questionSnap.id,
        }
      })
    )
  })
}

export const updateQuestion = async (
  gameId: string,
  questionId: string,
  updates: Partial<Question>
) => {
  await setDoc(
    doc(db, `games/${gameId}/questions`, questionId),
    { ...updates, updatedAt: serverTimestamp() },
    { merge: true }
  )
}

/*********
  PLAYERS
**********/
export const createPlayersCollection = (gameId: string) => {
  return collection<GamePlayer, DocumentData>(db, `games/${gameId}/users`)
}

export const updateGamePlayer = async (
  gameId: string,
  playerId: string,
  update: Partial<GamePlayer>
) => {
  await setDoc(
    doc(db, `games/${gameId}/users`, playerId),
    { ...update, updatedAt: serverTimestamp() },
    { merge: true }
  )
}

export const getGamePlayerStream = async (
  gameId: string,
  playerId: string,
  setGamePlayer: (gamePlayer?: GamePlayer) => void
): Promise<any> => {
  return onSnapshot(doc(db, `games/${gameId}/users`, playerId), (snapshot) => {
    if (snapshot.exists()) {
      setGamePlayer(snapshot.data() as GamePlayer | undefined)
    } else {
      setGamePlayer(undefined)
    }
  })
}

export const deleteGamePlayer = async (gameId: string, playerId: string) => {
  await deleteDoc(doc(db, `games/${gameId}/users`, playerId))
}

/*************
  PREDICTIONS
**************/
export const addPrediction = async (
  gameId: string,
  questionId: string,
  userId: string,
  prediction: Omit<Prediction, 'createdAt'>
) => {
  await setDoc(
    doc(db, `games/${gameId}/questions/${questionId}/predictions`, userId),
    { ...prediction, createdAt: serverTimestamp() }
  )
}
