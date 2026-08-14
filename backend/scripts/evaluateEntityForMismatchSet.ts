import { db } from '../src/firebase'
import {
  hydrateStoredEngineEvent,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import type { BoxScore, BoxScorePlayer } from '../src/types/engine'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type QuestionDoc = {
  state?: string | null
  answer?: string | null
  cancelReason?: string | null
  engineTag?: string | null
  question?: string | null
  resolvedEventId?: number | null
  resolutionContext?: {
    type?: string | null
    statType?: string | null
    target?: number | null
    startTeamStat?: number | null
    teamTricode?: string | null
    playerId?: number | null
    startGameStat?: number | null
    startPlayerGameStats?: { [key: string]: number } | null
    playerIds?: number[] | null
  } | null
}

type ShadowDoc = {
  kind?: string | null
  refetch?: boolean | null
  anchorActionNumber?: number | null
  payload?: JsonValue | null
}

type EvalRow = {
  gameId: string
  questionId: string
  stored: string
  entity: string
  supported: boolean
  note: string
}

type MismatchRef = {
  gameId: string
  questionId: string
}

const MISMATCHES: MismatchRef[] = [
  { gameId: 'nba_0022501015', questionId: 'XRgfdZKRdURiURMFcz9H' },
  { gameId: 'nba_0022501014', questionId: 'QxccmZAY8WGULSQC08zc' },
  { gameId: 'nba_0022501014', questionId: 'tlVTYH43cI49UcRX6kQb' },
  { gameId: 'nba_0022501012', questionId: 'pKxuB2iEVDKI7RccnVSv' },
  { gameId: 'nba_0022501011', questionId: 'byNvXrB46AKBDPdjvA1M' },
  { gameId: 'nba_0022501011', questionId: 'kkUv6ge5UUIleXRyf2H7' },
  { gameId: 'nba_0022501011', questionId: 'nidHsDgpZgLSxkcs54Kt' },
  { gameId: 'nba_0022501011', questionId: 'otPqW8uxuuC6efoKqguV' },
  { gameId: 'nba_0022501009', questionId: '178xGBIjlHCt56v31Jt9' },
]

const asObject = (
  value: JsonValue | null | undefined
): { [key: string]: JsonValue } | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const normalizeName = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const statKeyFromContext = (statType: string | null): string | null => {
  const upper = String(statType ?? '').toUpperCase()
  if (upper === 'POINTS') return 'points'
  if (upper === 'ASSISTS') return 'assists'
  if (upper === 'REBOUNDS') return 'rebound'
  if (upper === 'STEALS') return 'steals'
  if (upper === 'THREES') return '3pointerssuccess'
  return null
}

const readPath = (root: JsonValue | null, path: string[]): JsonValue | null => {
  let cursor: JsonValue | null = root
  for (const key of path) {
    const obj = asObject(cursor)
    if (!obj) return null
    cursor = obj[key] ?? null
  }
  return cursor
}

type EntityPlayerLine = {
  pid: string
  name: string
  teamType: 'home' | 'away' | 'unknown'
  stats: { [key: string]: number }
}

const toEntityPlayers = (payload: JsonValue | null): EntityPlayerLine[] => {
  const matchPlayerStats = readPath(payload, [
    'response',
    'items',
    'match_player_stats',
  ])
  const root = asObject(matchPlayerStats)
  if (!root) return []
  const lines: EntityPlayerLine[] = []
  for (const sideKey of Object.keys(root)) {
    const sideRaw = root[sideKey]
    const sideItems: JsonValue[] = Array.isArray(sideRaw)
      ? sideRaw
      : asObject(sideRaw)
        ? Object.values(asObject(sideRaw) as { [key: string]: JsonValue })
        : []
    for (const entry of sideItems) {
      const raw = asObject(entry)
      if (!raw) continue
      const pidValue = raw.pid
      const pid =
        typeof pidValue === 'string'
          ? pidValue
          : typeof pidValue === 'number'
            ? String(pidValue)
            : ''
      if (!pid) continue
      const name =
        typeof raw.name === 'string' && raw.name.trim().length > 0
          ? raw.name
          : pid
      const stats: { [key: string]: number } = {}
      for (const key of [
        'points',
        'assists',
        'rebound',
        'steals',
        '3pointerssuccess',
      ]) {
        const n = asNumber(raw[key])
        if (n !== null) stats[key] = n
      }
      const teamType: 'home' | 'away' | 'unknown' =
        sideKey === 'home' ? 'home' : sideKey === 'away' ? 'away' : 'unknown'
      lines.push({ pid, name, teamType, stats })
    }
  }
  return lines
}

const getBoxScorePlayers = (boxScore: BoxScore | null): BoxScorePlayer[] => {
  if (!boxScore) return []
  const game = boxScore.game ?? null
  const home = game?.homeTeam ?? boxScore.homeTeam ?? null
  const away = game?.awayTeam ?? boxScore.awayTeam ?? null
  const players: BoxScorePlayer[] = []
  if (Array.isArray(home?.players)) players.push(...home.players)
  if (Array.isArray(away?.players)) players.push(...away.players)
  return players
}

const getPlayerId = (player: BoxScorePlayer): number | null => {
  const direct =
    typeof player.personId === 'number'
      ? player.personId
      : typeof player.playerId === 'number'
        ? player.playerId
        : null
  return direct !== null && Number.isFinite(direct) ? direct : null
}

const getPlayerName = (player: BoxScorePlayer): string => {
  if (typeof player.name === 'string' && player.name.trim().length) {
    return player.name.trim()
  }
  const first = typeof player.firstName === 'string' ? player.firstName : ''
  const last = typeof player.lastName === 'string' ? player.lastName : ''
  return `${first} ${last}`.trim()
}

const getEntityPayloadAtAction = (
  byAction: Map<number, JsonValue>,
  actionNumber: number
): JsonValue | null => {
  let bestAction = -1
  let bestPayload: JsonValue | null = null
  for (const [action, payload] of byAction.entries()) {
    if (action <= actionNumber && action > bestAction) {
      bestAction = action
      bestPayload = payload
    }
  }
  return bestPayload
}

const sumTeamStat = (
  entityPlayers: EntityPlayerLine[],
  teamType: 'home' | 'away',
  statKey: string
): number | null => {
  let total = 0
  let seen = 0
  for (const player of entityPlayers) {
    if (player.teamType !== teamType) continue
    const value = player.stats[statKey]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    total += value
    seen += 1
  }
  return seen > 0 ? total : null
}

const evaluateQuestionAgainstEntity = (
  question: QuestionDoc,
  entityPayload: JsonValue | null,
  nbaNameByPlayerId: Map<number, string>,
  homeTricode: string | null,
  awayTricode: string | null
): { supported: boolean; entity: string; note: string } => {
  const context = question.resolutionContext ?? null
  const contextType =
    typeof context?.type === 'string' ? context.type.toUpperCase() : ''
  const statType =
    typeof context?.statType === 'string' ? context.statType : null
  const statKey = statKeyFromContext(statType)
  if (!context || !contextType || !statKey) {
    return { supported: false, entity: 'unsupported', note: 'missing_context' }
  }

  const entityPlayers = toEntityPlayers(entityPayload)
  if (!entityPlayers.length) {
    return {
      supported: false,
      entity: 'unsupported',
      note: 'missing_entity_players',
    }
  }

  const entityByNormName = new Map<string, EntityPlayerLine>()
  for (const line of entityPlayers) {
    entityByNormName.set(normalizeName(line.name), line)
  }

  if (contextType === 'TEAM_STAT_THIS_PERIOD') {
    const teamCode =
      typeof context.teamTricode === 'string'
        ? context.teamTricode.toUpperCase()
        : null
    const teamType: 'home' | 'away' | null =
      teamCode && homeTricode && teamCode === homeTricode
        ? 'home'
        : teamCode && awayTricode && teamCode === awayTricode
          ? 'away'
          : null
    const startTeamStat = asNumber(context.startTeamStat)
    const target = asNumber(context.target)
    if (!teamType || startTeamStat === null || target === null) {
      return {
        supported: false,
        entity: 'unsupported',
        note: 'team_inputs_missing',
      }
    }
    const endValue = sumTeamStat(entityPlayers, teamType, statKey)
    if (endValue === null) {
      return {
        supported: false,
        entity: 'unsupported',
        note: 'entity_team_stat_missing',
      }
    }
    const delta = Math.max(0, endValue - startTeamStat)
    const answer = delta >= target ? 'yes' : 'no'
    return {
      supported: true,
      entity: `resolved:${answer}:null`,
      note: `delta=${delta} target=${target}`,
    }
  }

  if (contextType === 'PLAYER_MILESTONE_PERIOD') {
    const playerId = asNumber(context.playerId)
    const startGameStat = asNumber(context.startGameStat)
    const target = asNumber(context.target)
    if (playerId === null || startGameStat === null || target === null) {
      return {
        supported: false,
        entity: 'unsupported',
        note: 'player_inputs_missing',
      }
    }
    const nbaName = nbaNameByPlayerId.get(playerId)
    if (!nbaName) {
      return {
        supported: false,
        entity: 'unsupported',
        note: `nba_name_missing playerId=${playerId}`,
      }
    }
    const entityLine = entityByNormName.get(normalizeName(nbaName))
    if (!entityLine) {
      return {
        supported: false,
        entity: 'unsupported',
        note: `entity_player_missing name=${nbaName}`,
      }
    }
    const endValue = entityLine.stats[statKey]
    if (typeof endValue !== 'number' || !Number.isFinite(endValue)) {
      return {
        supported: false,
        entity: 'unsupported',
        note: `entity_player_stat_missing name=${nbaName} stat=${statKey}`,
      }
    }
    const delta = Math.max(0, endValue - startGameStat)
    const answer = delta >= target ? 'yes' : 'no'
    return {
      supported: true,
      entity: `resolved:${answer}:null`,
      note: `player=${nbaName} delta=${delta} target=${target}`,
    }
  }

  if (contextType === 'PLAYER_COMPARE_PERIOD') {
    const playerIds = Array.isArray(context.playerIds) ? context.playerIds : []
    const startMap =
      context.startPlayerGameStats &&
      typeof context.startPlayerGameStats === 'object'
        ? context.startPlayerGameStats
        : null
    if (playerIds.length < 2 || !startMap) {
      return {
        supported: false,
        entity: 'unsupported',
        note: 'compare_inputs_missing',
      }
    }
    let bestId: string | null = null
    let bestDelta: number | null = null
    let tie = false
    for (const id of playerIds) {
      const startValue = asNumber(startMap[String(id)])
      const nbaName = nbaNameByPlayerId.get(id)
      if (startValue === null || !nbaName) continue
      const entityLine = entityByNormName.get(normalizeName(nbaName))
      if (!entityLine) continue
      const endValue = entityLine.stats[statKey]
      if (typeof endValue !== 'number' || !Number.isFinite(endValue)) continue
      const delta = Math.max(0, endValue - startValue)
      if (bestDelta === null || delta > bestDelta) {
        bestDelta = delta
        bestId = String(id)
        tie = false
      } else if (delta === bestDelta) {
        tie = true
      }
    }
    if (!bestId || bestDelta === null) {
      return {
        supported: false,
        entity: 'unsupported',
        note: 'compare_values_missing',
      }
    }
    if (tie) {
      return {
        supported: true,
        entity: 'cancelled:null:TIE',
        note: `bestDelta=${bestDelta}`,
      }
    }
    return {
      supported: true,
      entity: `resolved:${bestId}:null`,
      note: `winner=${bestId} delta=${bestDelta}`,
    }
  }

  return {
    supported: false,
    entity: 'unsupported',
    note: `unsupported_context_type=${contextType}`,
  }
}

const formatStored = (question: QuestionDoc): string => {
  const state = typeof question.state === 'string' ? question.state : 'unknown'
  const answer = typeof question.answer === 'string' ? question.answer : 'null'
  const reason =
    typeof question.cancelReason === 'string' ? question.cancelReason : 'null'
  return `${state}:${answer}:${reason}`
}

const main = async () => {
  const gameToLastBoxScore = new Map<string, BoxScore | null>()
  const gameToHomeAway = new Map<
    string,
    { home: string | null; away: string | null }
  >()

  const out: EvalRow[] = []

  for (const ref of MISMATCHES) {
    const [questionSnap, shadowSnap, eventsSnap] = await Promise.all([
      db
        .collection('games')
        .doc(ref.gameId)
        .collection('questions')
        .doc(ref.questionId)
        .get(),
      db
        .collection('games')
        .doc(ref.gameId)
        .collection('entitySportShadow')
        .where('kind', '==', 'box_score')
        .where('refetch', '==', true)
        .get(),
      db
        .collection('games')
        .doc(ref.gameId)
        .collection('events')
        .orderBy('eventId', 'desc')
        .limit(1)
        .get(),
    ])

    if (!questionSnap.exists) {
      out.push({
        gameId: ref.gameId,
        questionId: ref.questionId,
        stored: 'missing',
        entity: 'unsupported',
        supported: false,
        note: 'question_missing',
      })
      continue
    }

    const question = questionSnap.data() as QuestionDoc
    const resolvedEventId = asNumber(question.resolvedEventId)
    if (resolvedEventId === null) {
      out.push({
        gameId: ref.gameId,
        questionId: ref.questionId,
        stored: formatStored(question),
        entity: 'unsupported',
        supported: false,
        note: 'missing_resolved_event_id',
      })
      continue
    }

    const byAction = new Map<number, JsonValue>()
    for (const doc of shadowSnap.docs) {
      const shadow = doc.data() as ShadowDoc
      const action = asNumber(shadow.anchorActionNumber)
      if (action === null || !shadow.payload) continue
      byAction.set(action, shadow.payload)
    }
    const entityPayload = getEntityPayloadAtAction(byAction, resolvedEventId)

    let lastBoxScore = gameToLastBoxScore.get(ref.gameId)
    if (lastBoxScore === undefined) {
      const event = eventsSnap.empty
        ? null
        : hydrateStoredEngineEvent(
            eventsSnap.docs[0].data() as StoredEngineEvent
          )
      lastBoxScore = event?.gameState?.boxScore ?? null
      gameToLastBoxScore.set(ref.gameId, lastBoxScore)
    }

    let homeAway = gameToHomeAway.get(ref.gameId)
    if (!homeAway) {
      const game = lastBoxScore?.game ?? null
      const home =
        (game?.homeTeam?.teamTricode ??
          lastBoxScore?.homeTeam?.teamTricode ??
          null) ||
        null
      const away =
        (game?.awayTeam?.teamTricode ??
          lastBoxScore?.awayTeam?.teamTricode ??
          null) ||
        null
      homeAway = {
        home: typeof home === 'string' ? home.toUpperCase() : null,
        away: typeof away === 'string' ? away.toUpperCase() : null,
      }
      gameToHomeAway.set(ref.gameId, homeAway)
    }

    const nbaNameByPlayerId = new Map<number, string>()
    for (const player of getBoxScorePlayers(lastBoxScore ?? null)) {
      const id = getPlayerId(player)
      if (id === null) continue
      const name = getPlayerName(player)
      if (!name) continue
      nbaNameByPlayerId.set(id, name)
    }

    const evaluated = evaluateQuestionAgainstEntity(
      question,
      entityPayload,
      nbaNameByPlayerId,
      homeAway.home,
      homeAway.away
    )

    out.push({
      gameId: ref.gameId,
      questionId: ref.questionId,
      stored: formatStored(question),
      entity: evaluated.entity,
      supported: evaluated.supported,
      note: evaluated.note,
    })
  }

  let supported = 0
  let changed = 0
  for (const row of out) {
    if (row.supported) {
      supported += 1
      if (row.stored !== row.entity) changed += 1
    }
    console.log(
      `[entity-mismatch-eval] game=${row.gameId} question=${row.questionId} stored=${row.stored} entity=${row.entity} supported=${row.supported ? '1' : '0'} note=${row.note}`
    )
  }
  console.log(
    `[entity-mismatch-eval] summary total=${out.length} supported=${supported} changed=${changed}`
  )
}

main().catch((error: Error) => {
  console.error('[entity-mismatch-eval] error', error)
  process.exit(1)
})
