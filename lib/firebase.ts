import { DocumentData } from '@google-cloud/firestore'
import { getAuth, signOut } from '@react-native-firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
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

export const leaveAllActiveGames = async (userId: string) => {
  // Get all games the user has joined (from users/{userId}/games)
  const userGamesQuery = query(collection(db, `users/${userId}/games`))
  const userGamesSnapshot = await getDocs(userGamesQuery)

  if (userGamesSnapshot.empty) {
    console.log(`[Firebase] User ${userId} has no games to leave`)
    return
  }

  const batch = writeBatch(db)

  for (const userGameDoc of userGamesSnapshot.docs) {
    const gameId = userGameDoc.id

    // Get the game to check if it's active
    const gameDoc = await getDoc(doc(db, 'games', gameId))
    if (!gameDoc.exists()) continue

    const gameState = gameDoc.data()?.state
    if (gameState === 'scheduled' || gameState === 'open') {
      console.log(
        `[Firebase] Removing user ${userId} from active game ${gameId}`
      )

      // Delete from games/{gameId}/users/{userId}
      batch.delete(doc(db, `games/${gameId}/users`, userId))
    }
  }

  await batch.commit()
  console.log(`[Firebase] User ${userId} removed from all active games`)
}

export const deleteUser = async (userId: string, username?: string) => {
  // First, leave all active games
  await leaveAllActiveGames(userId)

  // Delete user's games subcollection
  console.log(`[Firebase] Deleting games subcollection for user ${userId}`)
  const userGamesQuery = query(collection(db, `users/${userId}/games`))
  const userGamesSnapshot = await getDocs(userGamesQuery)

  const batch = writeBatch(db)

  // Delete all documents in users/{userId}/games subcollection
  userGamesSnapshot.docs.forEach((gameDoc: any) => {
    console.log(
      `[Firebase] Deleting game ${gameDoc.id} from user subcollection`
    )
    batch.delete(gameDoc.ref)
  })

  // Delete user document
  batch.delete(doc(db, 'users', userId))

  // Delete username document if it exists
  if (username) {
    batch.delete(doc(db, 'usernames', username.toLowerCase()))
  }

  await batch.commit()
  console.log(`[Firebase] User ${userId} and all subcollections deleted`)

  // Delete Firebase Auth account
  // const currentUser = auth.currentUser
  // if (currentUser && currentUser.uid === userId) {
  //   await currentUser.delete()
  // }

  // Sign the user out
  await signOut(auth)
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
  const q = query(collection(db, 'games'), orderBy('createdAt', 'asc'))
  return onSnapshot(q, (gamesSnap) => {
    if (!gamesSnap) {
      setGames([])
      return
    }
    setGames(
      gamesSnap.docs.map((gameSnap: any) => {
        const data = gameSnap.data()
        return {
          ...(data as Game),
          startTime: data.startTime,
          playerCount:
            (data as any).playerCount !== undefined
              ? (data as any).playerCount
              : (data as any).userCount || 0,
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

export const deleteGamePlayer = async (gameId: string, playerId: string) => {
  console.log(`[Firebase] Deleting player ${playerId} from game ${gameId}`)

  // Get predictions to delete them individually
  const predictionsRef = collection(
    db,
    `users/${playerId}/games/${gameId}/predictions`
  )
  const predictionsSnapshot = await getDocs(predictionsRef)

  // Parallelize all deletes (predictions + game documents)
  await Promise.all([
    deleteDoc(doc(db, `games/${gameId}/users`, playerId)),
    deleteDoc(doc(db, `users/${playerId}/games`, gameId)),
    ...predictionsSnapshot.docs.map((predDoc: any) => deleteDoc(predDoc.ref)),
  ])

  console.log(
    `[Firebase] Deleted player from both collections and ${predictionsSnapshot.size} predictions`
  )
}

/*************
  PREDICTIONS
**************/
export const addPrediction = async (
  gameId: string,
  questionId: string,
  userId: string,
  prediction: Omit<Prediction, 'createdAt' | 'source'>
) => {
  await setDoc(
    doc(db, `games/${gameId}/questions/${questionId}/predictions`, userId),
    { ...prediction, source: 'app', createdAt: serverTimestamp() }
  )
}

export const getUserPredictionsStream = async (
  gameId: string,
  userId: string,
  setPredictions: (predictions: Map<string, string>) => void
): Promise<any> => {
  const q = query(
    collection(db, `users/${userId}/games/${gameId}/predictions`),
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
