import { DocumentData } from '@google-cloud/firestore'
import type { FirebaseFirestoreTypes } from '@react-native-firebase/firestore'
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
  Timestamp,
  where,
  writeBatch,
} from '@react-native-firebase/firestore'

const db = getFirestore()

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

export const saveFCMToken = async (
  userId: string,
  deviceId: string,
  token: string,
  deviceInfo: {
    platform: 'ios' | 'android'
    model?: string
    osVersion?: string
  }
) => {
  console.log(
    `[Firebase] Saving FCM token for user ${userId}, device ${deviceId} (${deviceInfo.platform})`
  )
  await setDoc(
    doc(db, 'users', userId),
    {
      tokens: {
        [deviceId]: {
          token,
          platform: deviceInfo.platform,
          model: deviceInfo.model,
          osVersion: deviceInfo.osVersion,
          updatedAt: serverTimestamp(),
        },
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  )
}

export const removeFCMToken = async (userId: string, deviceId: string) => {
  console.log(
    `[Firebase] Removing FCM token for user ${userId}, device ${deviceId}`
  )
  const userRef = doc(db, 'users', userId)
  const userDoc = await getDoc(userRef)

  if (userDoc.exists()) {
    const userData = userDoc.data()
    const tokens = { ...userData?.tokens }
    delete tokens[deviceId]

    await setDoc(
      userRef,
      {
        tokens,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )
  }
}

export const getUserGamesStream = async (
  userId: string,
  setUserGames: (games: Map<string, UserGame>) => void
) => {
  const q = query(collection(db, `users/${userId}/games`))
  return onSnapshot(q, (snapshot) => {
    const map = new Map<string, UserGame>()
    snapshot.docs.forEach((docSnap: any) => {
      map.set(docSnap.id, docSnap.data() as UserGame)
    })
    setUserGames(map)
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
    batch.set(
      doc(db, 'users', user),
      {
        username,
        onboardingComplete: true,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    )
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
  const cutoff = Timestamp.fromDate(new Date(Date.now() - 5 * 60 * 60 * 1000))
  const q = query(
    collection(db, 'games'),
    where('league', '==', 'NFL'),
    where('startTime', '>=', cutoff),
    orderBy('startTime', 'asc')
  )
  return onSnapshot(q, (gamesSnap) => {
    if (!gamesSnap) {
      setGames([])
      return
    }
    setGames(
      gamesSnap.docs.map(
        (gameSnap: FirebaseFirestoreTypes.QueryDocumentSnapshot) => {
          const data = gameSnap.data() as Game
          return {
            ...data,
            startTime: data.startTime,
            playerCount: data.playerCount || 0,
            id: gameSnap.id,
          }
        }
      )
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

export const getLatestGame = async (setGame: (game: Game | null) => void) => {
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
        setGame(null)
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

/***************
  PRACTICE
****************/
export const createPracticeQuestionsCollection = (userId: string) => {
  return collection<Question, DocumentData>(
    db,
    `users/${userId}/practice/questions/items`
  )
}

export const getPracticeQuestionsStream = async (
  userId: string,
  setQuestions: (questions: Question[]) => void
) => {
  const q = query(
    collection(db, `users/${userId}/practice/questions/items`),
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

export const getPracticePredictionsStream = async (
  userId: string,
  setPredictions: (predictions: Map<string, string>) => void
) => {
  const q = query(
    collection(db, `users/${userId}/practice/predictions/items`),
    orderBy('createdAt', 'asc')
  )

  return onSnapshot(q, (predictionsSnap) => {
    const predictionsMap = new Map<string, string>()

    if (!predictionsSnap || predictionsSnap.empty) {
      setPredictions(predictionsMap)
      return
    }

    predictionsSnap.docs.forEach((predictionDoc: any) => {
      const questionId = predictionDoc.id
      const data = predictionDoc.data()
      const value = data.prediction
      predictionsMap.set(
        questionId,
        typeof value === 'string' ? value : String(value)
      )
    })

    setPredictions(predictionsMap)
  })
}

/***********
  QUESTIONS
************/
export const createQuestionsCollection = (gameId: string) => {
  return collection<Question, DocumentData>(db, `games/${gameId}/questions`)
}

export const addQuestion = async (
  gameId: string,
  question: Omit<Question, 'id' | 'createdAt' | 'triggeredAt'>
) => {
  const ref = doc(collection(db, 'games'))
  await addDoc(collection(db, `games/${gameId}/questions`), {
    id: ref.id,
    ...question,
    triggeredAt: Timestamp.fromMillis(Date.now()),
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
