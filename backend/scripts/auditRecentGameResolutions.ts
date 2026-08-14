import { db } from '../src/firebase'
import { resolveQuestionForEvent } from '../src/lib/engine'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import { buildSimResult } from '../src/lib/simResult'
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

type StoredQuestion = Parameters<typeof resolveQuestionForEvent>[0] & {
  state?: string | null
  answer?: string | null
  cancelReason?: string | null
  question?: string | null
  templateId?: string | null
  engineTag?: string | null
}

type StoredBoxScoreSnapshot = {
  actionNumber?: number
  boxScore?: BoxScore | null
}

type AuditRow = {
  gameId: string
  nbaGameId: string
  questionId: string
  templateId: string
  question: string
  storedState: string
  storedAnswer: string | null
  storedCancelReason: string | null
  recomputedState: string | null
  recomputedAnswer: string | null
  recomputedReason: string | null
  decisionEventId: number | null
  decisionEventType: string | null
  startPeriod: number | null
  actualSummary: string
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

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const summarizeResult = (result: ReturnType<typeof buildSimResult>): string => {
  if (!result) return '—'
  if ('value' in result && typeof result.value === 'number') {
    return `value=${result.value}`
  }
  if ('tricode' in result && 'value' in result) {
    return `team=${result.tricode ?? 'null'} value=${result.value}`
  }
  if ('teams' in result) {
    return result.teams
      .map((team) => `${team.tricode}:${team.value}`)
      .join(', ')
  }
  if ('players' in result) {
    return result.players
      .map((player) => `${player.id}:${player.value}`)
      .join(', ')
  }
  if ('playerId' in result) {
    return `playerId=${result.playerId ?? 'null'} value=${result.value ?? '—'}`
  }
  return JSON.stringify(result)
}

const isPeriodOrGameResolution = (question: StoredQuestion): boolean => {
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

const normalizeReason = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.trim().toUpperCase()
}

const main = async () => {
  const requestedGames = Number(process.argv[2] ?? 5)
  const gameLimit =
    Number.isFinite(requestedGames) && requestedGames > 0
      ? Math.min(requestedGames, 20)
      : 5

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(gameLimit * 20)
    .get()

  const candidateGames = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)

  const selectedGames: { id: string; data: GameDoc }[] = []
  for (const candidate of candidateGames) {
    if (selectedGames.length >= gameLimit) break
    const lastEventSnap = await db
      .collection('games')
      .doc(candidate.id)
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
    selectedGames.push(candidate)
  }

  if (!selectedGames.length) {
    console.log('No completed resolved games found with final events.')
    return
  }

  const mismatches: AuditRow[] = []
  let auditedQuestions = 0

  for (const game of selectedGames) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const [eventsSnap, questionsSnap, snapshots] = await Promise.all([
      db
        .collection('games')
        .doc(gameId)
        .collection('events')
        .orderBy('eventId', 'asc')
        .get(),
      db
        .collection('games')
        .doc(gameId)
        .collection('questions')
        .where('state', 'in', ['resolved', 'cancelled'])
        .get(),
      loadBoxScoreSnapshots(gameId),
    ])

    const events = eventsSnap.docs
      .map((doc) => hydrateStoredEngineEvent(doc.data() as StoredEngineEvent))
      .filter((event) => typeof event.eventId === 'number')
      .sort((a, b) => a.eventId - b.eventId)

    if (!events.length) continue

    for (const questionDoc of questionsSnap.docs) {
      const question = questionDoc.data() as StoredQuestion
      if (!isPeriodOrGameResolution(question)) continue
      auditedQuestions += 1

      let decision: ReturnType<typeof resolveQuestionForEvent> = null
      let decisionEvent: EngineEvent | null = null
      let decisionResult: ReturnType<typeof buildSimResult> = null

      for (const event of events) {
        const eventBoxScore = resolveEventBoxScore(event, snapshots)
        const nextDecision = resolveQuestionForEvent(
          question,
          event,
          eventBoxScore
        )
        if (!nextDecision) continue
        decision = nextDecision
        decisionEvent = event
        decisionResult = buildSimResult(question, event, eventBoxScore)
        break
      }

      const storedState =
        typeof question.state === 'string' ? question.state : 'unknown'
      const storedAnswer =
        typeof question.answer === 'string' ? question.answer : null
      const storedCancelReason = normalizeReason(question.cancelReason)
      const recomputedState = decision?.state ?? null
      const recomputedAnswer =
        typeof decision?.answer === 'string' ? decision.answer : null
      const recomputedReason = normalizeReason(decision?.reason)

      const sameState = storedState === recomputedState
      const sameAnswer = (storedAnswer ?? null) === (recomputedAnswer ?? null)
      const sameReason = storedCancelReason === recomputedReason
      const isMatch =
        decision !== null &&
        sameState &&
        (storedState === 'resolved' ? sameAnswer : true) &&
        (storedState === 'cancelled' ? sameReason : true)

      if (isMatch) continue

      const context = question.resolutionContext
      const startPeriod =
        context && typeof context.startPeriod === 'number'
          ? context.startPeriod
          : null

      mismatches.push({
        gameId,
        nbaGameId,
        questionId: questionDoc.id,
        templateId:
          typeof question.templateId === 'string'
            ? question.templateId
            : typeof question.engineTag === 'string'
              ? question.engineTag
              : 'unknown',
        question:
          typeof question.question === 'string' ? question.question : '',
        storedState,
        storedAnswer,
        storedCancelReason,
        recomputedState,
        recomputedAnswer,
        recomputedReason,
        decisionEventId: decisionEvent?.eventId ?? null,
        decisionEventType:
          typeof decisionEvent?.type === 'string' ? decisionEvent.type : null,
        startPeriod: asNumber(startPeriod),
        actualSummary: summarizeResult(decisionResult),
      })
    }
  }

  const gameSummary = selectedGames.map((game) => {
    const start = toDate(game.data.startTime)
    const matchup = `${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`
    return {
      gameId: game.id,
      nbaGameId: String(game.data.nbaGameId ?? ''),
      startTime: start ? start.toISOString() : '—',
      matchup,
    }
  })

  console.log(
    `Audited games=${selectedGames.length} questions=${auditedQuestions}`
  )
  console.log('Games:')
  for (const game of gameSummary) {
    console.log(
      `  gameId=${game.gameId} nbaGameId=${game.nbaGameId} startTime=${game.startTime} matchup=${game.matchup}`
    )
  }

  if (!mismatches.length) {
    console.log('No mismatches found for period/game resolution questions.')
    return
  }

  console.log(`Mismatches=${mismatches.length}`)
  for (const mismatch of mismatches) {
    console.log(
      [
        `gameId=${mismatch.gameId}`,
        `nbaGameId=${mismatch.nbaGameId}`,
        `questionId=${mismatch.questionId}`,
        `template=${mismatch.templateId}`,
        `startPeriod=${mismatch.startPeriod ?? '—'}`,
        `stored=${mismatch.storedState}:${mismatch.storedAnswer ?? 'null'}:${mismatch.storedCancelReason ?? 'null'}`,
        `recomputed=${mismatch.recomputedState ?? 'null'}:${mismatch.recomputedAnswer ?? 'null'}:${mismatch.recomputedReason ?? 'null'}`,
        `event=${mismatch.decisionEventId ?? '—'}:${mismatch.decisionEventType ?? '—'}`,
        `actual=${mismatch.actualSummary}`,
        `q="${mismatch.question}"`,
      ].join(' ')
    )
  }
}

main().catch((error: Error) => {
  console.error('[audit-recent-game-resolutions] error', error)
  process.exit(1)
})
