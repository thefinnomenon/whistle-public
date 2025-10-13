import { CollectionReference, DocumentData } from '@google-cloud/firestore'
import firestore from '@react-native-firebase/firestore'

const createCollection = <T = DocumentData>(collectionName: string) => {
  return firestore().collection(
    collectionName
  ) as unknown as CollectionReference<T>
}

/********************
  USERS COLLECTION
*********************/
export const usersCollection = createCollection<User>('users')
export const addUser = async (user: Omit<User, 'createdAt' | 'updatedAt'>) => {
  await usersCollection
    .doc(user.id)
    .set({ ...user, createdAt: firestore.FieldValue.serverTimestamp() })
}
export const getUser = async (userId: string) =>
  (await usersCollection.doc(userId).get()).data()
export const updateUser = async (userId: string, update: Partial<User>) => {
  await usersCollection
    .doc(userId)
    .set(
      { ...update, updatedAt: firestore.FieldValue.serverTimestamp() },
      { merge: true }
    )
}

/***********************
  USER GAMES COLLECTION
************************/
export const createUserGamesCollection = (userId: string) => {
  return firestore().collection(
    `users/${userId}/games`
  ) as unknown as CollectionReference<UserGame>
}

export const updateUserGame = async (
  userId: string,
  gameId: string,
  update: Partial<UserGame>
) => {
  await createUserGamesCollection(userId)
    .doc(gameId)
    .set(
      { ...update, updatedAt: firestore.FieldValue.serverTimestamp() },
      { merge: true }
    )
}

export const updateUserGamePrediction = async (
  userId: string,
  gameId: string,
  update: Partial<UserGame>
) => {
  await createUserGamesCollection(userId)
    .doc(gameId)
    /* @ts-ignore */
    .update({ ...update, updatedAt: firestore.FieldValue.serverTimestamp() })
}

export const getUserGameStream = async (
  userId: string,
  gameId: string,
  setUserGame: (userGame?: UserGame) => void
): Promise<any> => {
  await createUserGamesCollection(userId)
    .doc(gameId)
    .onSnapshot((userGame) => setUserGame(userGame.data()))
}

/**********************
  USERNAMES COLLECTION
***********************/
export const usernamesCollection = createCollection<Username>('usernames')
export const setUsername = async (user: string, rawUsername: string) => {
  const username = rawUsername.trim().toLowerCase()
  console.log(`Trying to save username ${username} for user ${user}`)
  if (username.length <= 3 && username.length >= 15)
    throw Error('Username length must be between 3 and 15 characters.')
  if (username.includes(' ')) throw Error('Username cannot contain a space.')
  const usernameSnap = await usernamesCollection.doc(username).get()
  if (usernameSnap.exists)
    throw Error('Username not available. Please try another.')
  else {
    console.log('Setting username to ', username)
    const batch = firestore().batch()
    /* @ts-ignore */
    batch.set(usernameSnap.ref, { user })
    batch.set(
      /* @ts-ignore */
      usersCollection.doc(user),
      {
        username,
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
  const ref = gamesCollection.doc()
  await gamesCollection.doc(ref.id).set({
    id: ref.id,
    ...game,
    createdAt: firestore.FieldValue.serverTimestamp(),
  })
}
export const getGame = async (gameId: string) =>
  (await gamesCollection.doc(gameId).get()).data()
export const getGames = async (setGames: (games: Game[]) => void) => {
  return await gamesCollection
    .orderBy('createdAt', 'asc')
    .onSnapshot((gamesSnap) => {
      setGames(
        gamesSnap.docs.map((gameSnap) => {
          return {
            ...(gameSnap.data() as Game),
            startTime: gameSnap.data().startTime,
            id: gameSnap.id,
          }
        })
      )
    })
}

export const getLatestGame = async (setGame: (game: Game) => void) => {
  return await gamesCollection
    .orderBy('createdAt', 'desc')
    .limit(1)
    .onSnapshot((gamesSnap) => {
      setGame(
        gamesSnap.docs.map((gameSnap) => {
          return {
            ...(gameSnap.data() as Game),
            startTime: gameSnap.data().startTime,
            id: gameSnap.id,
          }
        })[0]
      )
    })
}

export const updateGame = async (gameId: string, updates: Partial<Game>) => {
  await gamesCollection
    .doc(gameId)
    .set(
      { ...updates, updatedAt: firestore.FieldValue.serverTimestamp() },
      { merge: true }
    )
}

export const deleteGame = async (gameId: string) => {
  await gamesCollection.doc(gameId).delete()
}

/***********
  QUESTIONS
************/
export const createQuestionsCollection = (gameId: string) => {
  return firestore().collection(
    `games/${gameId}/questions`
  ) as unknown as CollectionReference<Question>
}

export const addQuestion = async (
  gameId: string,
  question: Omit<Question, 'id' | 'createdAt'>
) => {
  const ref = gamesCollection.doc()
  await createQuestionsCollection(gameId).add({
    id: ref.id,
    ...question,
    createdAt: firestore.FieldValue.serverTimestamp(),
  })
}

export const getQuestionsStream = async (
  gameId: string,
  setQuestions: (questions: Question[]) => void
): Promise<any> => {
  return await createQuestionsCollection(gameId)
    .orderBy('createdAt', 'asc')
    .onSnapshot((questionsSnap) => {
      setQuestions(
        questionsSnap.docs.map((questionSnap) => {
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
  await createQuestionsCollection(gameId)
    .doc(questionId)
    .set(
      { ...updates, updatedAt: firestore.FieldValue.serverTimestamp() },
      { merge: true }
    )
}

/*********
  PLAYERS
**********/
export const createPlayersCollection = (gameId: string) => {
  return firestore().collection(
    `games/${gameId}/users`
  ) as unknown as CollectionReference<GamePlayer>
}

export const updateGamePlayer = async (
  gameId: string,
  playerId: string,
  update: Partial<GamePlayer>
) => {
  await createPlayersCollection(gameId)
    .doc(playerId)
    .set(
      { ...update, updatedAt: firestore.FieldValue.serverTimestamp() },
      { merge: true }
    )
}

export const getGamePlayerStream = async (
  gameId: string,
  playerId: string,
  setGamePlayer: (gamePlayer?: GamePlayer) => void
): Promise<any> => {
  await createPlayersCollection(gameId)
    .doc(playerId)
    .onSnapshot((gamePlayer) => setGamePlayer(gamePlayer.data()))
}

export const deleteGamePlayer = async (gameId: string, playerId: string) => {
  await createPlayersCollection(gameId).doc(playerId).delete()
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
  await firestore()
    .collection(`games/${gameId}/questions/${questionId}/predictions`)
    .doc(userId)
    .set({ ...prediction, createdAt: firestore.FieldValue.serverTimestamp() })
}
