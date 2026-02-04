import type { BoxScore, BoxScorePlayer, EngineEvent } from '../src/types/engine'
import type {
  EngineQuestionPayload,
  ResolutionContext,
  ResolutionContextValue,
} from '../src/lib/engine'
import { getEventPlayerId, getEventTeamTricode } from '../src/lib/engine'

type QuestionLike = Partial<EngineQuestionPayload> & {
  resolutionContext?: ResolutionContext
}

type SimResultTeam = { tricode: string; value: number }
type SimResultPlayer = { id: number; name: string | null; value: number }
type SimResult =
  | { value: number }
  | { tricode: string | null; value: number }
  | { teams: SimResultTeam[] }
  | { players: SimResultPlayer[] }
  | {
      playerId: number | null
      value?: number
      playerName?: string | null
      teamTricode?: string | null
    }

const asString = (value: ResolutionContextValue | undefined): string | null =>
  typeof value === 'string' ? value : null

const asNumber = (value: ResolutionContextValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asChoiceArray = (
  value: ResolutionContextValue | undefined
): { id: string; value: string }[] | null => {
  if (!Array.isArray(value)) return null
  const choices = value.filter(
    (entry): entry is { id: string; value: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: ResolutionContextValue }).id === 'string' &&
      typeof (entry as { value?: ResolutionContextValue }).value === 'string'
  )
  return choices.length ? choices : null
}

const asNumberArray = (
  value: ResolutionContextValue | undefined
): number[] | null => {
  if (!Array.isArray(value)) return null
  const numbers = value
    .map((entry) => (typeof entry === 'number' ? entry : null))
    .filter(
      (entry): entry is number => entry !== null && Number.isFinite(entry)
    )
  return numbers.length ? numbers : null
}

const asRecordNumber = (
  value: ResolutionContextValue | undefined
): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, ResolutionContextValue>
  const output: Record<string, number> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      output[key] = entry
    }
  }
  return Object.keys(output).length ? output : null
}

const normalizeTricode = (value: string | null | undefined): string | null => {
  if (!value) return null
  return value.trim().toUpperCase()
}

const getBoxScoreTeams = (boxScore: BoxScore | null) => {
  const game = boxScore?.game
  return {
    homeTeam: game?.homeTeam ?? boxScore?.homeTeam ?? null,
    awayTeam: game?.awayTeam ?? boxScore?.awayTeam ?? null,
  }
}

const resolveTeamSideByTricode = (
  boxScore: BoxScore | null,
  tricode: string | null | undefined
): 'HOME' | 'AWAY' | null => {
  const code = normalizeTricode(tricode)
  if (!code) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const homeCode = normalizeTricode(homeTeam?.teamTricode)
  const awayCode = normalizeTricode(awayTeam?.teamTricode)
  if (homeCode && code === homeCode) return 'HOME'
  if (awayCode && code === awayCode) return 'AWAY'
  return null
}

const getTeamStat = (
  boxScore: BoxScore | null,
  team: 'HOME' | 'AWAY',
  statType: string | null
): number | null => {
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const teamData = team === 'HOME' ? homeTeam : awayTeam
  const stats = teamData?.statistics
  if (!stats) return null
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'REBOUNDS') return Number(stats.reboundsTotal ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? 0)
  return null
}

const getPlayerId = (
  player: BoxScorePlayer | null | undefined
): number | null =>
  typeof player?.personId === 'number'
    ? player.personId
    : typeof player?.playerId === 'number'
      ? player.playerId
      : null

const getPlayerFromBoxScore = (
  boxScore: BoxScore | null,
  playerId: number | null
): BoxScorePlayer | null => {
  if (!playerId) return null
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const players: BoxScorePlayer[] = []
  if (Array.isArray(homeTeam?.players)) players.push(...homeTeam.players)
  if (Array.isArray(awayTeam?.players)) players.push(...awayTeam.players)
  return players.find((player) => getPlayerId(player) === playerId) ?? null
}

const getPlayerName = (player: BoxScorePlayer | null): string | null => {
  if (!player) return null
  if (typeof player?.name === 'string') return player.name
  if (
    typeof player?.firstName === 'string' &&
    typeof player?.lastName === 'string'
  )
    return `${player.firstName} ${player.lastName}`
  return null
}

const getPlayerPeriodStat = (
  player: BoxScorePlayer | null | undefined,
  period: number,
  statType: string
): number | null => {
  const periods =
    player?.statistics?.periods ||
    player?.periods ||
    player?.stats?.periods ||
    null
  if (!Array.isArray(periods)) return null
  const entry = periods.find((p) => Number(p?.period) === period)
  if (!entry) return null
  const stats = entry.statistics || entry
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'REBOUNDS')
    return Number(stats.reboundsTotal ?? stats.rebounds ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'BLOCKS') return Number(stats.blocks ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? stats.fg3m ?? 0)
  if (key === 'FTM') return Number(stats.freeThrowsMade ?? stats.ftm ?? 0)
  return null
}

const getPlayerGameStat = (
  player: BoxScorePlayer | null | undefined,
  statType: string | null
): number | null => {
  const stats = player?.statistics
  if (!stats) return null
  const key = String(statType || '').toUpperCase()
  if (key === 'POINTS') return Number(stats.points ?? 0)
  if (key === 'REBOUNDS')
    return Number(stats.reboundsTotal ?? stats.rebounds ?? 0)
  if (key === 'ASSISTS') return Number(stats.assists ?? 0)
  if (key === 'STEALS') return Number(stats.steals ?? 0)
  if (key === 'BLOCKS') return Number(stats.blocks ?? 0)
  if (key === 'THREES' || key === 'FG3M')
    return Number(stats.threePointersMade ?? stats.fg3m ?? 0)
  return null
}

const getCurrentScore = (
  event: EngineEvent,
  boxScore: BoxScore | null,
  team: 'HOME' | 'AWAY'
): number | null => {
  const stateScore =
    team === 'HOME' ? event.gameState?.scoreHome : event.gameState?.scoreAway
  if (stateScore !== null && stateScore !== undefined) return Number(stateScore)
  const { homeTeam, awayTeam } = getBoxScoreTeams(boxScore)
  const boxScoreValue =
    team === 'HOME' ? (homeTeam?.score ?? null) : (awayTeam?.score ?? null)
  if (boxScoreValue !== null && boxScoreValue !== undefined)
    return Number(boxScoreValue)
  return null
}

const buildPlayerResults = (
  playerIds: number[],
  choices: { id: string; value: string }[] | null,
  getValue: (playerId: number) => number | null
): { players: SimResultPlayer[] } | null => {
  const players = playerIds
    .map((playerId) => {
      const value = getValue(playerId)
      if (value === null || Number.isNaN(value)) return null
      const choice = choices?.find((entry) => Number(entry.id) === playerId)
      return {
        id: playerId,
        name: choice?.value ?? null,
        value,
      }
    })
    .filter((entry): entry is SimResultPlayer => entry !== null)
  return players.length ? { players } : null
}

export const buildSimResult = (
  question: QuestionLike,
  event: EngineEvent,
  boxScore: BoxScore | null
): SimResult | null => {
  const context = question?.resolutionContext ?? {}
  const type = asString(context.type) ?? ''
  if (!type) return null

  switch (type) {
    case 'TOTAL_POINTS_NEXT_N': {
      const home = getCurrentScore(event, boxScore, 'HOME') ?? 0
      const away = getCurrentScore(event, boxScore, 'AWAY') ?? 0
      const startTotal = asNumber(context.startTotal)
      if (startTotal === null) return null
      return { value: home + away - startTotal }
    }
    case 'TEAM_POINTS_NEXT_N':
    case 'TEAM_POINTS_REST_PERIOD':
    case 'TEAM_POINTS_THIS_PERIOD': {
      const teamSide = resolveTeamSideByTricode(
        boxScore,
        asString(context.teamTricode)
      )
      if (!teamSide) return null
      const current = getCurrentScore(event, boxScore, teamSide)
      const startScore =
        teamSide === 'HOME'
          ? asNumber(context.startScoreHome)
          : asNumber(context.startScoreAway)
      if (current === null || startScore === null) return null
      return {
        tricode: normalizeTricode(asString(context.teamTricode)),
        value: current - startScore,
      }
    }
    case 'TEAM_STAT_THIS_PERIOD': {
      const teamSide = resolveTeamSideByTricode(
        boxScore,
        asString(context.teamTricode)
      )
      if (!teamSide) return null
      const current = getTeamStat(
        boxScore,
        teamSide,
        asString(context.statType)
      )
      const startStat = asNumber(context.startTeamStat)
      if (current === null || startStat === null) return null
      return {
        tricode: normalizeTricode(asString(context.teamTricode)),
        value: current - startStat,
      }
    }
    case 'MADE_3_COUNT_NEXT_N':
    case 'ANY_3_THIS_PERIOD':
    case 'THREE_COUNT_THIS_PERIOD': {
      const homeThrees = getTeamStat(boxScore, 'HOME', 'THREES')
      const awayThrees = getTeamStat(boxScore, 'AWAY', 'THREES')
      const startHomeThrees = asNumber(context.startHomeThrees)
      const startAwayThrees = asNumber(context.startAwayThrees)
      if (homeThrees === null || awayThrees === null) return null
      if (startHomeThrees === null || startAwayThrees === null) return null
      const value = homeThrees + awayThrees - startHomeThrees - startAwayThrees
      return { value }
    }
    case 'TEAM_COMPARE_PERIOD': {
      const statType = asString(context.statType)
      const homeStat = getTeamStat(boxScore, 'HOME', statType)
      const awayStat = getTeamStat(boxScore, 'AWAY', statType)
      const minHomeStat = asNumber(context.minHomeStat)
      const minAwayStat = asNumber(context.minAwayStat)
      if (homeStat === null || awayStat === null) return null
      if (minHomeStat === null || minAwayStat === null) return null
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        teams: [
          { tricode: homeTricode, value: homeStat - minHomeStat },
          { tricode: awayTricode, value: awayStat - minAwayStat },
        ],
      }
    }
    case 'GAME_WINNER': {
      const homeScore = getCurrentScore(event, boxScore, 'HOME')
      const awayScore = getCurrentScore(event, boxScore, 'AWAY')
      if (homeScore === null || awayScore === null) return null
      const homeTricode =
        normalizeTricode(asString(context.homeTricode)) ?? 'HOME'
      const awayTricode =
        normalizeTricode(asString(context.awayTricode)) ?? 'AWAY'
      return {
        teams: [
          { tricode: homeTricode, value: homeScore },
          { tricode: awayTricode, value: awayScore },
        ],
      }
    }
    case 'PLAYER_MILESTONE_PERIOD': {
      const playerId = asNumber(context.playerId) ?? 0
      const period =
        asNumber(context.endPeriod) ??
        asNumber(context.startPeriod) ??
        event.gameState?.period ??
        null
      if (!playerId || !period) {
        const statType = String(asString(context.statType) || '').toUpperCase()
        if (statType === 'THREES' || statType === 'STEALS') {
          const eventPlayerId = getEventPlayerId(event)
          const player = getPlayerFromBoxScore(boxScore, eventPlayerId)
          return {
            playerId: eventPlayerId ?? null,
            playerName: getPlayerName(player),
            teamTricode: normalizeTricode(getEventTeamTricode(event)),
          }
        }
        return null
      }
      const player = getPlayerFromBoxScore(boxScore, playerId)
      const statType = String(asString(context.statType) || 'POINTS')
      const currentTotal = getPlayerGameStat(player, statType)
      const initialValue = asNumber(context.initialValue)
      if (
        currentTotal === null ||
        Number.isNaN(currentTotal) ||
        initialValue === null
      )
        return null
      return { playerId, value: currentTotal - initialValue }
    }
    case 'PLAYER_COMPARE_PERIOD': {
      const period =
        asNumber(context.endPeriod) ??
        asNumber(context.startPeriod) ??
        event.gameState?.period ??
        null
      const playerIds = asNumberArray(context.playerIds) ?? []
      if (!period || playerIds.length < 2) return null
      const statType = String(asString(context.statType) || '')
      return buildPlayerResults(
        playerIds,
        asChoiceArray(context.choices),
        (playerId) => {
          const player = getPlayerFromBoxScore(boxScore, playerId)
          return (
            getPlayerPeriodStat(player, period, statType) ??
            getPlayerGameStat(player, statType)
          )
        }
      )
    }
    case 'PLAYER_COMPARE_NEXT_N': {
      const playerIds = asNumberArray(context.playerIds) ?? []
      if (playerIds.length < 2) return null
      const statType = String(asString(context.statType) || '')
      const startStats = asRecordNumber(context.startPlayerStats)
      return buildPlayerResults(
        playerIds,
        asChoiceArray(context.choices),
        (playerId) => {
          const player = getPlayerFromBoxScore(boxScore, playerId)
          const current = getPlayerGameStat(player, statType)
          if (current === null || Number.isNaN(current)) return null
          const start = startStats?.[String(playerId)]
          return typeof start === 'number' && Number.isFinite(start)
            ? current - start
            : current
        }
      )
    }
    case 'MADE_3_BEFORE_PERIOD_END':
    case 'MADE_FT_BEFORE_PERIOD_END':
    case 'MADE_FG_BEFORE_PERIOD_END': {
      const playerId = getEventPlayerId(event)
      const player = getPlayerFromBoxScore(boxScore, playerId)
      const teamTricode = normalizeTricode(getEventTeamTricode(event))
      return {
        playerId: playerId ?? null,
        playerName: getPlayerName(player),
        teamTricode,
      }
    }
    default:
      return null
  }
}
