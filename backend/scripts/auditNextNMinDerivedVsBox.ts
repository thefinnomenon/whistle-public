import { db } from '../src/firebase'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import {
  resolveQuestionForEvent,
  type DerivedStatsSnapshot,
} from '../src/lib/engine'
import { EventType, type NbaEventContext } from '../src/types/engine'

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
  templateId?: string | null
  engineTag?: string | null
  question?: string | null
}

type Decision = {
  state: 'resolved' | 'cancelled'
  answer: string | null
  reason: string | null
  eventId: number | null
}

type AuditRow = {
  gameId: string
  nbaGameId: string
  questionId: string
  templateId: string
  stored: string
  boxReplay: string
  derivedReplay: string
  differsBoxVsDerived: boolean
  storedMatchesDerived: boolean
  question: string
}

const toDateIso = (value: TimestampLike): string => {
  if (!value) return '—'
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? '—' : value.toISOString()
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const parsed = value.toDate()
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toISOString()
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toISOString()
  }
  return '—'
}

type DerivedLine = {
  points: number
  assists: number
  rebounds: number
  steals: number
  threes: number
  blocks: number
  freeThrowsMade: number
}

const emptyLine = (): DerivedLine => ({
  points: 0,
  assists: 0,
  rebounds: 0,
  steals: 0,
  threes: 0,
  blocks: 0,
  freeThrowsMade: 0,
})

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
}

const getOrInitTeam = (
  derived: DerivedStatsSnapshot,
  tricode: string | null
): DerivedLine | null => {
  const key = normalizeCode(tricode)
  if (!key) return null
  if (!derived.teams[key]) derived.teams[key] = emptyLine()
  return derived.teams[key]
}

const getOrInitPlayer = (
  derived: DerivedStatsSnapshot,
  playerId: number | null
): DerivedLine | null => {
  if (!playerId || !Number.isFinite(playerId)) return null
  const key = String(playerId)
  if (!derived.players[key]) derived.players[key] = emptyLine()
  return derived.players[key]
}

const applyEventToDerived = (
  derived: DerivedStatsSnapshot,
  eventType: EventType,
  context: NbaEventContext | null
) => {
  const teamCode = normalizeCode(context?.teamTricode ?? null)
  const primaryPlayer =
    typeof context?.primaryPlayerId === 'number'
      ? context.primaryPlayerId
      : null
  const shot = context?.shot
  const shotTeam = normalizeCode(shot?.teamTricode ?? teamCode)
  const shooter =
    typeof shot?.shooterId === 'number' ? shot.shooterId : primaryPlayer
  const assist =
    typeof shot?.assistPlayerId === 'number' ? shot.assistPlayerId : null

  if (eventType === EventType.REBOUND) {
    const team = getOrInitTeam(derived, teamCode)
    if (team) team.rebounds += 1
    const player = getOrInitPlayer(derived, primaryPlayer)
    if (player) player.rebounds += 1
    return
  }
  if (eventType === EventType.STEAL) {
    const team = getOrInitTeam(derived, teamCode)
    if (team) team.steals += 1
    const player = getOrInitPlayer(derived, primaryPlayer)
    if (player) player.steals += 1
    return
  }
  if (eventType === EventType.BLOCK) {
    const team = getOrInitTeam(derived, teamCode)
    if (team) team.blocks += 1
    const player = getOrInitPlayer(derived, primaryPlayer)
    if (player) player.blocks += 1
    return
  }
  if (eventType === EventType.MADE_3) {
    const team = getOrInitTeam(derived, shotTeam)
    if (team) {
      team.points += 3
      team.threes += 1
    }
    const player = getOrInitPlayer(derived, shooter)
    if (player) {
      player.points += 3
      player.threes += 1
    }
    const assister = getOrInitPlayer(derived, assist)
    if (assister) assister.assists += 1
    if (team && assister) team.assists += 1
    return
  }
  if (eventType === EventType.MADE_FG) {
    const team = getOrInitTeam(derived, shotTeam)
    if (team) team.points += 2
    const player = getOrInitPlayer(derived, shooter)
    if (player) player.points += 2
    const assister = getOrInitPlayer(derived, assist)
    if (assister) assister.assists += 1
    if (team && assister) team.assists += 1
    return
  }
  if (eventType === EventType.MADE_FT) {
    const team = getOrInitTeam(derived, teamCode)
    if (team) {
      team.points += 1
      team.freeThrowsMade += 1
    }
    const player = getOrInitPlayer(derived, primaryPlayer)
    if (player) {
      player.points += 1
      player.freeThrowsMade += 1
    }
  }
}

const normalizeDecision = (
  decision: ReturnType<typeof resolveQuestionForEvent>
): Decision | null => {
  if (!decision) return null
  return {
    state: decision.state,
    answer: typeof decision.answer === 'string' ? decision.answer : null,
    reason:
      typeof decision.reason === 'string'
        ? decision.reason.trim().toUpperCase()
        : null,
    eventId: null,
  }
}

const decisionLabel = (decision: Decision | null): string =>
  decision
    ? `${decision.state}:${decision.answer ?? 'null'}:${decision.reason ?? 'null'}@${decision.eventId ?? '—'}`
    : 'null'

const storedLabel = (question: QuestionDoc): string => {
  const state = typeof question.state === 'string' ? question.state : 'unknown'
  const answer = typeof question.answer === 'string' ? question.answer : null
  const reason =
    typeof question.cancelReason === 'string'
      ? question.cancelReason.trim().toUpperCase()
      : null
  return `${state}:${answer ?? 'null'}:${reason ?? 'null'}`
}

const main = async () => {
  const requested = Number(process.argv[2] ?? 10)
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, 40) : 10

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(limit * 20)
    .get()

  const selectedGames = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)
    .slice(0, limit)

  const rows: AuditRow[] = []
  let totalNextN = 0
  let boxVsDerivedDiff = 0
  let storedVsDerivedMismatch = 0

  for (const game of selectedGames) {
    const gameId = game.id
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const [eventsSnap, questionsSnap] = await Promise.all([
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
        .where('windowType', '==', 'NEXT_N_MIN')
        .where('state', 'in', ['resolved', 'cancelled'])
        .get(),
    ])

    if (questionsSnap.empty) continue
    const events = eventsSnap.docs
      .map((doc) => hydrateStoredEngineEvent(doc.data() as StoredEngineEvent))
      .filter((event) => typeof event.eventId === 'number')
      .sort((a, b) => a.eventId - b.eventId)
    if (!events.length) continue

    for (const qDoc of questionsSnap.docs) {
      const question = qDoc.data() as QuestionDoc
      totalNextN += 1

      const derived: DerivedStatsSnapshot = { teams: {}, players: {} }
      let boxDecision: Decision | null = null
      let derivedDecision: Decision | null = null

      for (const event of events) {
        applyEventToDerived(derived, event.type, event.context)
        if (!boxDecision) {
          const next = normalizeDecision(
            resolveQuestionForEvent(
              question,
              event,
              event.gameState?.boxScore ?? null
            )
          )
          if (next) {
            next.eventId = event.eventId
            boxDecision = next
          }
        }
        if (!derivedDecision) {
          const next = normalizeDecision(
            resolveQuestionForEvent(
              question,
              event,
              event.gameState?.boxScore ?? null,
              derived
            )
          )
          if (next) {
            next.eventId = event.eventId
            derivedDecision = next
          }
        }
        if (boxDecision && derivedDecision) break
      }

      const boxLabel = decisionLabel(boxDecision)
      const derivedLabel = decisionLabel(derivedDecision)
      const stored = storedLabel(question)
      const differs = boxLabel !== derivedLabel
      const storedMatchesDerived =
        derivedDecision !== null &&
        stored.startsWith(
          `${derivedDecision.state}:${derivedDecision.answer ?? 'null'}:`
        ) &&
        (derivedDecision.state !== 'cancelled' ||
          stored.includes(`:${derivedDecision.reason ?? 'null'}`))

      if (differs) boxVsDerivedDiff += 1
      if (!storedMatchesDerived) storedVsDerivedMismatch += 1

      rows.push({
        gameId,
        nbaGameId,
        questionId: qDoc.id,
        templateId:
          typeof question.templateId === 'string'
            ? question.templateId
            : typeof question.engineTag === 'string'
              ? question.engineTag
              : 'unknown',
        stored,
        boxReplay: boxLabel,
        derivedReplay: derivedLabel,
        differsBoxVsDerived: differs,
        storedMatchesDerived,
        question:
          typeof question.question === 'string' ? question.question : '',
      })
    }
  }

  console.log(
    `Audited NEXT_N_MIN questions=${totalNextN} games=${selectedGames.length}`
  )
  for (const game of selectedGames) {
    console.log(
      `  gameId=${game.id} nbaGameId=${String(game.data.nbaGameId ?? '')} start=${toDateIso(game.data.startTime)} matchup=${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`
    )
  }
  console.log(`BoxVsDerivedDiff=${boxVsDerivedDiff}`)
  console.log(`StoredVsDerivedMismatch=${storedVsDerivedMismatch}`)

  const interesting = rows.filter(
    (row) => row.differsBoxVsDerived || !row.storedMatchesDerived
  )
  for (const row of interesting) {
    console.log(
      [
        `gameId=${row.gameId}`,
        `nbaGameId=${row.nbaGameId}`,
        `questionId=${row.questionId}`,
        `template=${row.templateId}`,
        `stored=${row.stored}`,
        `box=${row.boxReplay}`,
        `derived=${row.derivedReplay}`,
        `diff=${row.differsBoxVsDerived}`,
        `storedMatchesDerived=${row.storedMatchesDerived}`,
        `q="${row.question}"`,
      ].join(' ')
    )
  }
}

main().catch((error: Error) => {
  console.error('[audit-next-n-min-derived-vs-box] error', error)
  process.exit(1)
})
