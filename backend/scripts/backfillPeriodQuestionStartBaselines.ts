import { admin, db } from '../src/firebase'
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

type ResolutionValue =
  | string
  | number
  | boolean
  | null
  | ResolutionValue[]
  | { [key: string]: ResolutionValue }

type ResolutionContext = {
  type?: string
  teamTricode?: string
  homeTricode?: string
  awayTricode?: string
  statType?: string
  target?: number
  startTeamStat?: number
  minTeamStat?: number
  minHomeStat?: number
  minAwayStat?: number
  playerId?: number
  playerIds?: number[]
  startGameStat?: number
  startPlayerGameStats?: { [key: string]: number }
  [key: string]: ResolutionValue | undefined
}

type QuestionDoc = {
  windowType?: string | null
  state?: string | null
  templateId?: string | null
  engineTag?: string | null
  question?: string | null
  resolutionContext?: ResolutionContext
}

type StoredBoxScoreSnapshot = {
  actionNumber?: number
  boxScore?: BoxScore | null
}

type DerivedStatLine = {
  points: number
  assists: number
  rebounds: number
  steals: number
  threes: number
  blocks: number
  freeThrowsMade: number
}

type DerivedStatsSnapshot = {
  teams: Record<string, DerivedStatLine>
  players: Record<string, DerivedStatLine>
}

type BaselinePatch = {
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
  gameId: string
  questionId: string
  template: string
  contextType: string
  questionText: string
  update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
  summary: string
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

const toNumber = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const asNumber = (value: ResolutionValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return toNumber(value)
  return null
}

const asString = (value: ResolutionValue | undefined): string | null =>
  typeof value === 'string' ? value : null

const asNumberArray = (value: ResolutionValue | undefined): number[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) =>
      typeof item === 'number' && Number.isFinite(item) ? item : null
    )
    .filter((item): item is number => item !== null)
}

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
}

const getStatKey = (
  statType: string | null | undefined
): keyof DerivedStatLine | null => {
  const stat = String(statType ?? '').toUpperCase()
  if (stat === 'POINTS') return 'points'
  if (stat === 'ASSISTS') return 'assists'
  if (stat === 'REBOUNDS') return 'rebounds'
  if (stat === 'STEALS') return 'steals'
  if (stat === 'THREES' || stat === 'FG3M') return 'threes'
  if (stat === 'BLOCKS') return 'blocks'
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return 'freeThrowsMade'
  return null
}

const getPlayerId = (player: {
  personId?: number
  playerId?: number
}): number | null => {
  if (typeof player.personId === 'number' && Number.isFinite(player.personId)) {
    return player.personId
  }
  if (typeof player.playerId === 'number' && Number.isFinite(player.playerId)) {
    return player.playerId
  }
  return null
}

const getPlayerFromBoxScore = (
  boxScore: BoxScore | null,
  playerId: number
): {
  statistics?: {
    points?: number
    assists?: number
    reboundsTotal?: number
    rebounds?: number
    steals?: number
    blocks?: number
    threePointersMade?: number
    fg3m?: number
    freeThrowsMade?: number
    ftm?: number
  }
} | null => {
  if (!boxScore) return null
  const teams = [boxScore.homeTeam, boxScore.awayTeam]
  for (const team of teams) {
    const players = Array.isArray(team?.players) ? team.players : []
    for (const player of players) {
      const id = getPlayerId(player)
      if (id === playerId) return player
    }
  }
  return null
}

const getPlayerGameStat = (
  player: {
    statistics?: {
      points?: number
      assists?: number
      reboundsTotal?: number
      rebounds?: number
      steals?: number
      blocks?: number
      threePointersMade?: number
      fg3m?: number
      freeThrowsMade?: number
      ftm?: number
    }
  } | null,
  statType: string | null | undefined
): number | null => {
  if (!player?.statistics) return null
  const stats = player.statistics
  const stat = String(statType ?? '').toUpperCase()
  if (stat === 'POINTS') return toNumber(stats.points ?? null)
  if (stat === 'ASSISTS') return toNumber(stats.assists ?? null)
  if (stat === 'REBOUNDS')
    return toNumber(stats.reboundsTotal ?? stats.rebounds ?? null)
  if (stat === 'STEALS') return toNumber(stats.steals ?? null)
  if (stat === 'THREES' || stat === 'FG3M')
    return toNumber(stats.threePointersMade ?? stats.fg3m ?? null)
  if (stat === 'BLOCKS') return toNumber(stats.blocks ?? null)
  if (stat === 'FTM' || stat === 'FREE_THROWS' || stat === 'FREETHROWS')
    return toNumber(stats.freeThrowsMade ?? stats.ftm ?? null)
  return null
}

const getDerivedSnapshot = (
  event: EngineEvent
): DerivedStatsSnapshot | null => {
  const raw = event.derivedStatsSnapshot
  if (!raw || typeof raw !== 'object') return null
  return raw
}

const getDerivedTeamStat = (
  derived: DerivedStatsSnapshot | null,
  teamCode: string | null,
  statType: string | null | undefined
): number | null => {
  if (!derived || !teamCode) return null
  const key = normalizeCode(teamCode)
  if (!key) return null
  const line = derived.teams[key]
  if (!line) return null
  const statKey = getStatKey(statType)
  if (!statKey) return null
  return line[statKey]
}

const getDerivedPlayerStat = (
  derived: DerivedStatsSnapshot | null,
  playerId: number | null,
  statType: string | null | undefined
): number | null => {
  if (!derived || !playerId) return null
  const line = derived.players[String(playerId)]
  if (!line) return null
  const statKey = getStatKey(statType)
  if (!statKey) return null
  return line[statKey]
}

const getTeamStatFromBoxScore = (
  boxScore: BoxScore | null,
  teamCode: string | null,
  statType: string | null | undefined
): number | null => {
  if (!boxScore || !teamCode) return null
  const normalized = normalizeCode(teamCode)
  if (!normalized) return null
  const teams = [boxScore.homeTeam, boxScore.awayTeam]
  for (const team of teams) {
    if (normalizeCode(team?.teamTricode) !== normalized) continue
    const stats = team?.statistics
    if (!stats) return null
    const stat = String(statType ?? '').toUpperCase()
    if (stat === 'POINTS') return toNumber(stats.points ?? null)
    if (stat === 'ASSISTS') return toNumber(stats.assists ?? null)
    if (stat === 'REBOUNDS')
      return toNumber(stats.reboundsTotal ?? stats.rebounds ?? null)
    if (stat === 'STEALS') return toNumber(stats.steals ?? null)
    if (stat === 'THREES' || stat === 'FG3M')
      return toNumber(stats.threePointersMade ?? stats.fg3m ?? null)
    if (stat === 'BLOCKS') return toNumber(stats.blocks ?? null)
    return null
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
  if (event.gameState?.boxScore) return event.gameState.boxScore
  if (!snapshots.length) return null

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
  return latestBeforeOrAt ?? firstAfter
}

const shouldPatchQuestion = (question: QuestionDoc): boolean => {
  if (question.windowType !== 'PERIOD') return false
  const contextType = question.resolutionContext?.type
  return (
    contextType === 'TEAM_STAT_THIS_PERIOD' ||
    contextType === 'TEAM_COMPARE_PERIOD' ||
    contextType === 'PLAYER_MILESTONE_PERIOD' ||
    contextType === 'PLAYER_COMPARE_PERIOD'
  )
}

const deepEqualNumberRecord = (
  left: Record<string, number> | null,
  right: Record<string, number> | null
): boolean => {
  if (!left && !right) return true
  if (!left || !right) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let i = 0; i < leftKeys.length; i += 1) {
    const lk = leftKeys[i]
    const rk = rightKeys[i]
    if (lk !== rk) return false
    if (left[lk] !== right[rk]) return false
  }
  return true
}

const buildPatchForQuestion = (
  gameId: string,
  questionId: string,
  question: QuestionDoc,
  startEvent: EngineEvent,
  snapshots: (StoredBoxScoreSnapshot & { actionNumber: number })[],
  ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
): BaselinePatch | null => {
  const context = question.resolutionContext
  if (!context || typeof context.type !== 'string') return null
  const boxScore = resolveEventBoxScore(startEvent, snapshots)
  const derived = getDerivedSnapshot(startEvent)
  const statType = asString(context.statType)
  const contextType = context.type
  const update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> =
    {}
  const changes: string[] = []

  if (contextType === 'TEAM_STAT_THIS_PERIOD') {
    const teamCode = normalizeCode(asString(context.teamTricode))
    if (!teamCode) return null
    const current =
      getDerivedTeamStat(derived, teamCode, statType) ??
      getTeamStatFromBoxScore(boxScore, teamCode, statType)
    if (current === null) return null
    const existingStart = asNumber(context.startTeamStat)
    let target = asNumber(context.target)
    if (target === null) {
      const existingMin = asNumber(context.minTeamStat)
      if (existingMin !== null && existingStart !== null) {
        target = Math.max(0, existingMin - existingStart)
      }
    }
    if (target === null) target = 0
    const nextMin = current + target
    if (existingStart !== current) {
      update['resolutionContext.startTeamStat'] = current
      changes.push(`startTeamStat:${existingStart ?? 'null'}->${current}`)
    }
    const existingMin = asNumber(context.minTeamStat)
    if (existingMin !== nextMin) {
      update['resolutionContext.minTeamStat'] = nextMin
      changes.push(`minTeamStat:${existingMin ?? 'null'}->${nextMin}`)
    }
  } else if (contextType === 'TEAM_COMPARE_PERIOD') {
    const homeCode = normalizeCode(asString(context.homeTricode))
    const awayCode = normalizeCode(asString(context.awayTricode))
    if (!homeCode || !awayCode) return null
    const homeCurrent =
      getDerivedTeamStat(derived, homeCode, statType) ??
      getTeamStatFromBoxScore(boxScore, homeCode, statType)
    const awayCurrent =
      getDerivedTeamStat(derived, awayCode, statType) ??
      getTeamStatFromBoxScore(boxScore, awayCode, statType)
    if (homeCurrent === null || awayCurrent === null) return null
    const existingHome = asNumber(context.minHomeStat)
    const existingAway = asNumber(context.minAwayStat)
    if (existingHome !== homeCurrent) {
      update['resolutionContext.minHomeStat'] = homeCurrent
      changes.push(`minHomeStat:${existingHome ?? 'null'}->${homeCurrent}`)
    }
    if (existingAway !== awayCurrent) {
      update['resolutionContext.minAwayStat'] = awayCurrent
      changes.push(`minAwayStat:${existingAway ?? 'null'}->${awayCurrent}`)
    }
  } else if (contextType === 'PLAYER_MILESTONE_PERIOD') {
    const playerId = asNumber(context.playerId)
    if (playerId === null) return null
    const current =
      getDerivedPlayerStat(derived, playerId, statType) ??
      getPlayerGameStat(getPlayerFromBoxScore(boxScore, playerId), statType)
    if (current === null) return null
    const existingStart = asNumber(context.startGameStat)
    if (existingStart !== current) {
      update['resolutionContext.startGameStat'] = current
      update['resolutionContext.initialValue'] = current
      changes.push(`startGameStat:${existingStart ?? 'null'}->${current}`)
    }
  } else if (contextType === 'PLAYER_COMPARE_PERIOD') {
    const playerIds = asNumberArray(context.playerIds)
    if (!playerIds.length) return null
    const nextMap: Record<string, number> = {}
    for (const playerId of playerIds) {
      const value =
        getDerivedPlayerStat(derived, playerId, statType) ??
        getPlayerGameStat(getPlayerFromBoxScore(boxScore, playerId), statType)
      if (value === null) continue
      nextMap[String(playerId)] = value
    }
    if (!Object.keys(nextMap).length) return null
    const rawExisting = context.startPlayerGameStats
    const existingMap = rawExisting ? { ...rawExisting } : null
    if (!deepEqualNumberRecord(existingMap, nextMap)) {
      update['resolutionContext.startPlayerGameStats'] = nextMap
      changes.push('startPlayerGameStats:updated')
    }
  } else {
    return null
  }

  if (!changes.length) return null
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp()

  return {
    ref,
    gameId,
    questionId,
    template:
      typeof question.templateId === 'string'
        ? question.templateId
        : typeof question.engineTag === 'string'
          ? question.engineTag
          : 'unknown',
    contextType,
    questionText:
      typeof question.question === 'string' ? question.question : '',
    update,
    summary: changes.join(' | '),
  }
}

const main = async () => {
  const gameArg = Number(process.argv[2] ?? 10)
  const gameLimit =
    Number.isFinite(gameArg) && gameArg > 0 ? Math.min(gameArg, 30) : 10
  const apply = process.argv.includes('--apply')
  const gameIdArgs = process.argv
    .filter((arg) => arg.startsWith('--game-id='))
    .map((arg) => arg.slice('--game-id='.length))
    .filter((value) => value.length > 0)

  const selected: { id: string; data: GameDoc }[] = []
  if (gameIdArgs.length > 0) {
    for (const gameId of gameIdArgs) {
      const gameSnap = await db.collection('games').doc(gameId).get()
      if (!gameSnap.exists) continue
      const data = gameSnap.data() as GameDoc
      selected.push({ id: gameId, data })
    }
  } else {
    const gamesSnap = await db
      .collection('games')
      .orderBy('startTime', 'desc')
      .limit(gameLimit * 30)
      .get()

    const candidates = gamesSnap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
      .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)

    for (const candidate of candidates) {
      if (selected.length >= gameLimit) break
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
      selected.push(candidate)
    }
  }

  const patches: BaselinePatch[] = []
  let inspected = 0

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
    const eventsById = new Map<number, EngineEvent>()
    for (const doc of eventsSnap.docs) {
      const event = hydrateStoredEngineEvent(doc.data() as StoredEngineEvent)
      if (typeof event.eventId === 'number' && Number.isFinite(event.eventId)) {
        eventsById.set(event.eventId, event)
      }
    }

    for (const questionDoc of questionsSnap.docs) {
      const question = questionDoc.data() as QuestionDoc
      if (!shouldPatchQuestion(question)) continue
      inspected += 1
      const startEventId = asNumber(question.resolutionContext?.startEventId)
      if (startEventId === null) continue
      const startEvent = eventsById.get(startEventId)
      if (!startEvent) continue
      const patch = buildPatchForQuestion(
        game.id,
        questionDoc.id,
        question,
        startEvent,
        snapshots,
        questionDoc.ref
      )
      if (patch) patches.push(patch)
    }
  }

  console.log(
    `Backfill period baselines games=${selected.length} inspected=${inspected} patches=${patches.length} apply=${apply}`
  )
  for (const game of selected) {
    const start = toDate(game.data.startTime)
    console.log(
      `  gameId=${game.id} nbaGameId=${String(game.data.nbaGameId ?? '')} start=${start ? start.toISOString() : '—'} matchup=${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`
    )
  }
  for (const patch of patches) {
    console.log(
      [
        `gameId=${patch.gameId}`,
        `questionId=${patch.questionId}`,
        `type=${patch.contextType}`,
        `template=${patch.template}`,
        `changes=${patch.summary}`,
        `q="${patch.questionText}"`,
      ].join(' ')
    )
  }

  if (!apply || patches.length === 0) return

  const chunkSize = 250
  for (let index = 0; index < patches.length; index += chunkSize) {
    const chunk = patches.slice(index, index + chunkSize)
    const batch = db.batch()
    for (const patch of chunk) {
      batch.update(patch.ref, patch.update)
    }
    await batch.commit()
  }
  console.log(`Applied baseline patches=${patches.length}`)
}

main().catch((error: Error) => {
  console.error('[backfill-period-question-start-baselines] error', error)
  process.exit(1)
})
