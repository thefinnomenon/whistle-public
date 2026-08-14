import { admin, db } from '../src/firebase'
import { resolveQuestionForEvent } from '../src/lib/engine'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import { EventType, type BoxScore, type EngineEvent } from '../src/types/engine'

type TimestampLike =
  | { toDate: () => Date }
  | Date
  | string
  | number
  | null
  | undefined

type GameDoc = {
  state?: string | null
  startTime?: TimestampLike
  nbaGameId?: string | number | null
  homeTeam?: string | null
  awayTeam?: string | null
}

type QuestionDoc = Parameters<typeof resolveQuestionForEvent>[0] & {
  state?: string | null
  answer?: string | null
  cancelReason?: string | null
  windowType?: string | null
  question?: string | null
  templateId?: string | null
  engineTag?: string | null
}

type StoredBoxScoreSnapshot = {
  actionNumber?: number
  boxScore?: BoxScore | null
}

const toDate = (value: TimestampLike): Date | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const parsed = value.toDate()
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

const isFinalStatus = (event: EngineEvent | null): boolean => {
  if (!event) return false
  if (event.type === EventType.GAME_END) return true
  const status = event.gameState?.boxScore?.gameStatus
  const statusText = String(
    event.gameState?.boxScore?.gameStatusText ?? ''
  ).toLowerCase()
  const numeric = typeof status === 'number' ? status : Number(status)
  return numeric === 3 || statusText.includes('final')
}

const normalizeReason = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.trim().toUpperCase()
}

const isPeriodOrGameResolution = (question: QuestionDoc): boolean => {
  const context = question.resolutionContext
  const contextType =
    context && typeof context.type === 'string' ? context.type : ''
  const windowType =
    typeof question.windowType === 'string' ? question.windowType : ''
  return (
    contextType.includes('PERIOD') ||
    contextType.includes('GAME') ||
    windowType === 'PERIOD' ||
    windowType === 'GAME'
  )
}

const loadBoxScoreSnapshots = async (gameId: string) => {
  const snap = await db
    .collection('games')
    .doc(gameId)
    .collection('boxScoreSnapshots')
    .orderBy('actionNumber', 'asc')
    .get()

  return snap.docs
    .map((doc) => doc.data() as StoredBoxScoreSnapshot)
    .filter(
      (entry): entry is StoredBoxScoreSnapshot & { actionNumber: number } =>
        typeof entry.actionNumber === 'number' &&
        Number.isFinite(entry.actionNumber)
    )
}

const resolveEventBoxScore = (
  event: EngineEvent,
  snapshots: (StoredBoxScoreSnapshot & { actionNumber: number })[]
): BoxScore | null => {
  if (!snapshots.length) return event.gameState?.boxScore ?? null

  let latestBeforeOrAt: BoxScore | null = null
  let firstAfter: BoxScore | null = null
  for (const snapshot of snapshots) {
    const candidate = snapshot.boxScore ?? null
    if (!candidate) continue
    if (snapshot.actionNumber <= event.eventId) {
      latestBeforeOrAt = candidate
      continue
    }
    firstAfter = candidate
    break
  }

  if (
    event.type === EventType.PERIOD_END ||
    event.type === EventType.GAME_END
  ) {
    return firstAfter ?? latestBeforeOrAt ?? event.gameState?.boxScore ?? null
  }
  return latestBeforeOrAt ?? firstAfter ?? event.gameState?.boxScore ?? null
}

type RecomputedDecision = {
  state: 'resolved' | 'cancelled'
  answer: string | null
  reason: string | null
  eventId: number | null
  eventType: string | null
}

const recomputeDecision = (
  question: QuestionDoc,
  events: EngineEvent[],
  snapshots: (StoredBoxScoreSnapshot & { actionNumber: number })[]
): RecomputedDecision | null => {
  for (const event of events) {
    const eventBoxScore = resolveEventBoxScore(event, snapshots)
    const decision = resolveQuestionForEvent(question, event, eventBoxScore)
    if (!decision) continue
    return {
      state: decision.state,
      answer: typeof decision.answer === 'string' ? decision.answer : null,
      reason: normalizeReason(decision.reason),
      eventId: event.eventId,
      eventType: String(event.type),
    }
  }
  return null
}

type QuestionPatch = {
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
  gameId: string
  questionId: string
  fromState: string
  toState: 'resolved' | 'cancelled'
  fromAnswer: string | null
  toAnswer: string | null
  fromReason: string | null
  toReason: string | null
  eventId: number | null
  eventType: string | null
  template: string
  questionText: string
  data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
}

const main = async () => {
  const argCount = Number(process.argv[2] ?? 5)
  const gameLimit =
    Number.isFinite(argCount) && argCount > 0 ? Math.min(argCount, 25) : 5
  const apply = process.argv.includes('--apply')
  const gameIdArgs = process.argv
    .filter((arg) => arg.startsWith('--game-id='))
    .map((arg) => arg.slice('--game-id='.length))
    .filter((value) => value.trim().length > 0)

  let selected: { id: string; data: GameDoc }[] = []
  if (gameIdArgs.length > 0) {
    const gameDocs = await Promise.all(
      gameIdArgs.map((gameId) => db.collection('games').doc(gameId).get())
    )
    selected = gameDocs
      .filter((doc) => doc.exists)
      .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
      .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)
  } else {
    const gamesSnap = await db
      .collection('games')
      .orderBy('startTime', 'desc')
      .limit(gameLimit * 30)
      .get()

    const candidates = gamesSnap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
      .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)

    selected = []
    for (const game of candidates) {
      if (selected.length >= gameLimit) break
      const lastEventSnap = await db
        .collection('games')
        .doc(game.id)
        .collection('events')
        .orderBy('eventId', 'desc')
        .limit(1)
        .get()
      const lastEvent = lastEventSnap.empty
        ? null
        : hydrateStoredEngineEvent(
            lastEventSnap.docs[0].data() as StoredEngineEvent
          )
      if (!isFinalStatus(lastEvent)) continue
      selected.push(game)
    }
  }

  if (!selected.length) {
    console.log('No completed resolved games found.')
    return
  }

  const patches: QuestionPatch[] = []

  for (const game of selected) {
    const [eventsSnap, questionsSnap, snapshots] = await Promise.all([
      db
        .collection('games')
        .doc(game.id)
        .collection('events')
        .orderBy('eventId', 'asc')
        .get(),
      db.collection('games').doc(game.id).collection('questions').get(),
      loadBoxScoreSnapshots(game.id),
    ])

    const events = eventsSnap.docs
      .map((doc) => hydrateStoredEngineEvent(doc.data() as StoredEngineEvent))
      .filter((event) => typeof event.eventId === 'number')
      .sort((a, b) => a.eventId - b.eventId)

    for (const questionDocSnap of questionsSnap.docs) {
      const question = questionDocSnap.data() as QuestionDoc
      if (!isPeriodOrGameResolution(question)) continue

      const decision = recomputeDecision(question, events, snapshots)
      if (!decision) continue

      const currentState =
        typeof question.state === 'string' ? question.state : 'unknown'
      const currentAnswer =
        typeof question.answer === 'string' ? question.answer : null
      const currentReason = normalizeReason(question.cancelReason)
      const targetReason =
        decision.state === 'cancelled' ? (decision.reason ?? 'VOID') : null

      const matchesState = currentState === decision.state
      const matchesAnswer =
        (currentAnswer ?? null) ===
        (decision.state === 'resolved' ? decision.answer : null)
      const matchesReason = currentReason === targetReason
      const alreadyCorrect =
        matchesState &&
        (decision.state === 'resolved' ? matchesAnswer : matchesReason)
      if (alreadyCorrect) continue

      const patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> =
        {
          state: decision.state,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      if (decision.state === 'resolved') {
        patch.answer = decision.answer
        patch.cancelReason = admin.firestore.FieldValue.delete()
        patch.resolvedAt = admin.firestore.FieldValue.serverTimestamp()
      } else {
        patch.answer = admin.firestore.FieldValue.delete()
        patch.cancelReason = targetReason
        patch.closedAt = admin.firestore.FieldValue.serverTimestamp()
      }

      patches.push({
        ref: questionDocSnap.ref,
        gameId: game.id,
        questionId: questionDocSnap.id,
        fromState: currentState,
        toState: decision.state,
        fromAnswer: currentAnswer,
        toAnswer: decision.state === 'resolved' ? decision.answer : null,
        fromReason: currentReason,
        toReason: targetReason,
        eventId: decision.eventId,
        eventType: decision.eventType,
        template:
          typeof question.templateId === 'string'
            ? question.templateId
            : typeof question.engineTag === 'string'
              ? question.engineTag
              : 'unknown',
        questionText:
          typeof question.question === 'string' ? question.question : '',
        data: patch,
      })
    }
  }

  const summaryGames = selected.map((game) => {
    const start = toDate(game.data.startTime)
    return {
      gameId: game.id,
      nbaGameId: String(game.data.nbaGameId ?? ''),
      startTime: start ? start.toISOString() : '—',
      matchup: `${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`,
    }
  })

  console.log(`Selected games=${selected.length}`)
  for (const game of summaryGames) {
    console.log(
      `  gameId=${game.gameId} nbaGameId=${game.nbaGameId} start=${game.startTime} matchup=${game.matchup}`
    )
  }
  console.log(`Patches=${patches.length} apply=${apply}`)

  for (const patch of patches) {
    console.log(
      [
        `gameId=${patch.gameId}`,
        `questionId=${patch.questionId}`,
        `template=${patch.template}`,
        `from=${patch.fromState}:${patch.fromAnswer ?? 'null'}:${patch.fromReason ?? 'null'}`,
        `to=${patch.toState}:${patch.toAnswer ?? 'null'}:${patch.toReason ?? 'null'}`,
        `event=${patch.eventId ?? '—'}:${patch.eventType ?? '—'}`,
        `q="${patch.questionText}"`,
      ].join(' ')
    )
  }

  if (!apply || patches.length === 0) return

  const chunkSize = 250
  for (let i = 0; i < patches.length; i += chunkSize) {
    const chunk = patches.slice(i, i + chunkSize)
    const batch = db.batch()
    for (const patch of chunk) {
      batch.update(patch.ref, patch.data)
    }
    await batch.commit()
  }

  console.log(`Applied patches=${patches.length}`)
}

main().catch((error: Error) => {
  console.error('[backfill-recent-game-resolutions] error', error)
  process.exit(1)
})
