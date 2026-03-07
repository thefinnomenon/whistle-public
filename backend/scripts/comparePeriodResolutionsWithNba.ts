import https from 'https'
import fs from 'fs'
import path from 'path'
import { admin, db } from '../src/firebase'

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
  startEventId?: number
  startPeriod?: number
  startScoreHome?: number
  startScoreAway?: number
  homeTricode?: string
  awayTricode?: string
  teamTricode?: string
  statType?: string
  startTeamStat?: number
  minTeamStat?: number
  startGameStat?: number
  target?: number
  playerId?: number
  playerIds?: number[]
  startPlayerGameStats?: { [key: string]: number }
  [key: string]: ResolutionValue | undefined
}

type QuestionDoc = {
  state?: string
  answer?: string | null
  cancelReason?: string | null
  windowType?: string | null
  question?: string | null
  templateId?: string | null
  engineTag?: string | null
  resolutionContext?: ResolutionContext
}

type RawAction = {
  actionNumber?: number | null
  period?: number | null
  clock?: string | null
  actionType?: string | null
  subType?: string | null
  description?: string | null
  teamTricode?: string | null
  personId?: number | null
  assistPersonId?: number | null
  scoreHome?: string | number | null
  scoreAway?: string | number | null
  shotResult?: string | null
}

type PbpResponse = {
  game?: {
    actions?: RawAction[] | null
  } | null
}

type BoxScoreResponse = {
  game?: {
    gameId?: string | null
    homeTeam?: {
      teamTricode?: string | null
      periods?: { period?: number | null; score?: number | null }[] | null
    } | null
    awayTeam?: {
      teamTricode?: string | null
      periods?: { period?: number | null; score?: number | null }[] | null
    } | null
  } | null
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type OfficialStatLine = {
  points: number
  assists: number
  rebounds: number
  steals: number
  threes: number
}

type OfficialQuarterData = {
  period: number
  sourceUrl: string
  homeCode: string | null
  awayCode: string | null
  teamStats: Map<string, OfficialStatLine>
  playerStats: Map<number, OfficialStatLine>
}

type StatKey = 'POINTS' | 'ASSISTS' | 'REBOUNDS' | 'STEALS' | 'THREES'

type StatAccumulator = {
  team: Map<
    string,
    { assists: number; rebounds: number; steals: number; threes: number }
  >
  player: Map<
    number,
    {
      assists: number
      rebounds: number
      steals: number
      threes: number
      points: number
    }
  >
}

type CompareResult = {
  gameId: string
  nbaGameId: string
  questionId: string
  template: string
  question: string
  storedState: string
  storedAnswer: string | null
  storedReason: string | null
  computedState: string
  computedAnswer: string | null
  computedReason: string | null
  nbaValues: string
  sourceUrl: string
  sourceBoxScoreUrl: string
  sourceGamePageUrl: string
  detail: string
  engineResolvedValue: string
  officialQuarterValue: string
  mismatch: boolean
}

const NBA_JSON_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Encoding': 'identity',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/',
  Origin: 'https://www.nba.com',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const fetchJson = <T>(url: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { headers: NBA_JSON_HEADERS }, (res) => {
      const { statusCode } = res
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        if (statusCode && statusCode >= 400) {
          reject(new Error(`NBA request failed ${statusCode}: ${url}`))
          return
        }
        try {
          resolve(JSON.parse(raw) as T)
        } catch (error) {
          reject(new Error(`NBA parse failed: ${String(error)}`))
        }
      })
    })
    req.setTimeout(90_000, () => {
      req.destroy(new Error(`NBA timeout: ${url}`))
    })
    req.on('error', (error) => reject(error))
  })

const fetchHtml = (url: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.nba.com/',
          Origin: 'https://www.nba.com',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        const { statusCode } = res
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          if (statusCode && statusCode >= 400) {
            reject(new Error(`NBA HTML request failed ${statusCode}: ${url}`))
            return
          }
          resolve(raw)
        })
      }
    )
    req.setTimeout(90_000, () => {
      req.destroy(new Error(`NBA HTML timeout: ${url}`))
    })
    req.on('error', (error) => reject(error))
  })

const asObject = (
  value: JsonValue | undefined | null
): { [key: string]: JsonValue } | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const asArray = (value: JsonValue | undefined | null): JsonValue[] | null => {
  if (!value || !Array.isArray(value)) return null
  return value
}

const readJsonPath = (
  root: JsonValue,
  pathParts: string[]
): JsonValue | null => {
  let cursor: JsonValue | null = root
  for (const key of pathParts) {
    const obj = asObject(cursor)
    if (!obj) return null
    cursor = obj[key] ?? null
  }
  return cursor
}

const parseNextData = (html: string): JsonValue | null => {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  )
  if (!match || typeof match[1] !== 'string') return null
  try {
    return JSON.parse(match[1]) as JsonValue
  } catch {
    return null
  }
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

const normalizeCode = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
}

const toNumber = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const normalizeReason = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return normalized.length ? normalized : null
}

const readStatNumber = (
  stats: { [key: string]: JsonValue } | null,
  key: string
): number => {
  if (!stats) return 0
  return toNumber(stats[key] as string | number | null | undefined) ?? 0
}

const extractOfficialQuarterData = (
  period: number,
  periodUrl: string,
  nextData: JsonValue
): OfficialQuarterData | null => {
  const gameObj = asObject(
    readJsonPath(nextData, ['props', 'pageProps', 'game'])
  )
  if (!gameObj) return null

  const readTeam = (key: 'homeTeam' | 'awayTeam') => {
    const teamObj = asObject(gameObj[key])
    if (!teamObj) {
      return {
        tricode: null as string | null,
        teamStat: {
          points: 0,
          assists: 0,
          rebounds: 0,
          steals: 0,
          threes: 0,
        },
        players: new Map<number, OfficialStatLine>(),
      }
    }
    const tricode = normalizeCode(
      teamObj.teamTricode as string | null | undefined
    )
    const teamStatsObj = asObject(teamObj.statistics)
    const teamStat: OfficialStatLine = {
      points: readStatNumber(teamStatsObj, 'points'),
      assists: readStatNumber(teamStatsObj, 'assists'),
      rebounds: readStatNumber(teamStatsObj, 'reboundsTotal'),
      steals: readStatNumber(teamStatsObj, 'steals'),
      threes: readStatNumber(teamStatsObj, 'threePointersMade'),
    }
    const playerMap = new Map<number, OfficialStatLine>()
    const players = asArray(teamObj.players) ?? []
    for (const playerRaw of players) {
      const playerObj = asObject(playerRaw)
      if (!playerObj) continue
      const playerId = toNumber(
        playerObj.personId as string | number | null | undefined
      )
      if (playerId === null) continue
      const statsObj = asObject(playerObj.statistics)
      playerMap.set(playerId, {
        points: readStatNumber(statsObj, 'points'),
        assists: readStatNumber(statsObj, 'assists'),
        rebounds: readStatNumber(statsObj, 'reboundsTotal'),
        steals: readStatNumber(statsObj, 'steals'),
        threes: readStatNumber(statsObj, 'threePointersMade'),
      })
    }
    return { tricode, teamStat, players: playerMap }
  }

  const home = readTeam('homeTeam')
  const away = readTeam('awayTeam')
  const teamStats = new Map<string, OfficialStatLine>()
  if (home.tricode) teamStats.set(home.tricode, home.teamStat)
  if (away.tricode) teamStats.set(away.tricode, away.teamStat)
  const playerStats = new Map<number, OfficialStatLine>()
  for (const [playerId, stats] of home.players.entries())
    playerStats.set(playerId, stats)
  for (const [playerId, stats] of away.players.entries())
    playerStats.set(playerId, stats)

  return {
    period,
    sourceUrl: periodUrl,
    homeCode: home.tricode,
    awayCode: away.tricode,
    teamStats,
    playerStats,
  }
}

const getOfficialStatValue = (
  stats: OfficialStatLine | null,
  stat: StatKey
): number | null => {
  if (!stats) return null
  if (stat === 'POINTS') return stats.points
  if (stat === 'ASSISTS') return stats.assists
  if (stat === 'REBOUNDS') return stats.rebounds
  if (stat === 'STEALS') return stats.steals
  if (stat === 'THREES') return stats.threes
  return null
}

const isFinalStatusFromActions = (actions: RawAction[]): boolean => {
  if (!actions.length) return false
  const last = actions[actions.length - 1]
  const text = String(last?.description ?? '').toLowerCase()
  if (text.includes('game end') || text.includes('final')) return true
  return true
}

const isMade = (action: RawAction): boolean => {
  const shotResult = String(action.shotResult ?? '').toLowerCase()
  const desc = String(action.description ?? '').toLowerCase()
  if (shotResult.includes('miss')) return false
  if (shotResult.includes('made')) return true
  if (desc.startsWith('miss')) return false
  return desc.includes('pts')
}

const getPeriodEndActionNumber = (
  actions: RawAction[],
  period: number
): number | null => {
  const explicit = actions.find((action) => {
    if (toNumber(action.period) !== period) return false
    const actionType = String(action.actionType ?? '').toLowerCase()
    const subType = String(action.subType ?? '').toLowerCase()
    return actionType === 'period' && subType === 'end'
  })
  if (explicit?.actionNumber && Number.isFinite(explicit.actionNumber)) {
    return explicit.actionNumber
  }
  let maxInPeriod: number | null = null
  for (const action of actions) {
    if (toNumber(action.period) !== period) continue
    const actionNumber = toNumber(action.actionNumber)
    if (actionNumber === null) continue
    if (maxInPeriod === null || actionNumber > maxInPeriod)
      maxInPeriod = actionNumber
  }
  return maxInPeriod
}

const buildStatAccumulator = (
  actions: RawAction[],
  startEventId: number,
  endEventId: number
): StatAccumulator => {
  const accumulator: StatAccumulator = {
    team: new Map(),
    player: new Map(),
  }

  const upsertTeam = (tricode: string) => {
    const existing = accumulator.team.get(tricode)
    if (existing) return existing
    const created = { assists: 0, rebounds: 0, steals: 0, threes: 0 }
    accumulator.team.set(tricode, created)
    return created
  }

  const upsertPlayer = (playerId: number) => {
    const existing = accumulator.player.get(playerId)
    if (existing) return existing
    const created = { assists: 0, rebounds: 0, steals: 0, threes: 0, points: 0 }
    accumulator.player.set(playerId, created)
    return created
  }

  for (const action of actions) {
    const actionNumber = toNumber(action.actionNumber)
    if (actionNumber === null) continue
    if (actionNumber <= startEventId || actionNumber > endEventId) continue

    const actionType = String(action.actionType ?? '').toLowerCase()
    const teamTricode = normalizeCode(action.teamTricode)
    const personId = toNumber(action.personId)
    const assistPersonId = toNumber(action.assistPersonId)

    if (actionType === 'rebound') {
      if (teamTricode) upsertTeam(teamTricode).rebounds += 1
      if (personId !== null) upsertPlayer(personId).rebounds += 1
      continue
    }

    if (actionType === 'steal') {
      if (teamTricode) upsertTeam(teamTricode).steals += 1
      if (personId !== null) upsertPlayer(personId).steals += 1
      continue
    }

    if (actionType === '3pt' && isMade(action)) {
      if (teamTricode) upsertTeam(teamTricode).threes += 1
      if (personId !== null) {
        const player = upsertPlayer(personId)
        player.threes += 1
        player.points += 3
      }
      if (assistPersonId !== null) {
        if (teamTricode) upsertTeam(teamTricode).assists += 1
        upsertPlayer(assistPersonId).assists += 1
      }
      continue
    }

    if (actionType === '2pt' && isMade(action)) {
      if (personId !== null) upsertPlayer(personId).points += 2
      if (assistPersonId !== null) {
        if (teamTricode) upsertTeam(teamTricode).assists += 1
        upsertPlayer(assistPersonId).assists += 1
      }
      continue
    }

    if (actionType === 'freethrow' && isMade(action)) {
      if (personId !== null) upsertPlayer(personId).points += 1
      continue
    }
  }

  return accumulator
}

const statFromAccumulator = (
  accumulator: StatAccumulator,
  stat: StatKey,
  tricode: string
): number => {
  const entry = accumulator.team.get(tricode)
  if (!entry) return 0
  if (stat === 'ASSISTS') return entry.assists
  if (stat === 'REBOUNDS') return entry.rebounds
  if (stat === 'STEALS') return entry.steals
  if (stat === 'THREES') return entry.threes
  return 0
}

const playerStatFromAccumulator = (
  accumulator: StatAccumulator,
  stat: StatKey,
  playerId: number
): number => {
  const entry = accumulator.player.get(playerId)
  if (!entry) return 0
  if (stat === 'ASSISTS') return entry.assists
  if (stat === 'REBOUNDS') return entry.rebounds
  if (stat === 'STEALS') return entry.steals
  if (stat === 'THREES') return entry.threes
  if (stat === 'POINTS') return entry.points
  return 0
}

const compareQuestion = (
  gameId: string,
  nbaGameId: string,
  questionId: string,
  question: QuestionDoc,
  actions: RawAction[],
  officialQuarterDataByPeriod: Map<number, OfficialQuarterData>,
  sourceBoxScoreUrl: string,
  sourceGamePageBaseUrl: string
): CompareResult | null => {
  const context = question.resolutionContext
  if (!context || typeof context.type !== 'string') return null
  const contextType = context.type
  if (!contextType.includes('PERIOD')) return null

  const startPeriod = toNumber(context.startPeriod)
  const startEventId = toNumber(context.startEventId) ?? 0
  if (startPeriod === null || startPeriod < 1) return null

  const endEventId = getPeriodEndActionNumber(actions, startPeriod)
  if (endEventId === null) return null

  const periodActions = actions.filter(
    (action) =>
      toNumber(action.actionNumber) !== null &&
      (toNumber(action.actionNumber) ?? 0) <= endEventId &&
      (toNumber(action.actionNumber) ?? 0) > startEventId
  )
  const accumulator = buildStatAccumulator(actions, startEventId, endEventId)

  const storedState =
    typeof question.state === 'string' ? question.state : 'unknown'
  const storedAnswer =
    typeof question.answer === 'string' ? question.answer : null
  const storedReason = normalizeReason(question.cancelReason)

  let computedState: 'resolved' | 'cancelled' = 'cancelled'
  let computedAnswer: string | null = null
  let computedReason: string | null = null
  let nbaValues = ''
  let detail = ''
  const sourceUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${nbaGameId}.json`
  const sourceGamePageUrl = `${sourceGamePageBaseUrl}?period=Q${startPeriod}`
  const officialQuarter = officialQuarterDataByPeriod.get(startPeriod) ?? null

  const homeCode = normalizeCode(context.homeTricode)
  const awayCode = normalizeCode(context.awayTricode)
  const statType = String(context.statType ?? '').toUpperCase() as StatKey

  if (contextType === 'TEAM_STAT_THIS_PERIOD') {
    const teamCode = normalizeCode(context.teamTricode)
    const startTeamStat = toNumber(context.startTeamStat)
    const minTeamStat = toNumber(context.minTeamStat)
    if (!teamCode || startTeamStat === null || minTeamStat === null) return null
    const pbpDelta = statFromAccumulator(accumulator, statType, teamCode)
    const deltaFromOfficial = getOfficialStatValue(
      officialQuarter?.teamStats.get(teamCode) ?? null,
      statType
    )
    const delta = deltaFromOfficial ?? pbpDelta
    const final = startTeamStat + delta
    computedState = 'resolved'
    computedAnswer = final >= minTeamStat ? 'yes' : 'no'
    const officialStat = getOfficialStatValue(
      officialQuarter?.teamStats.get(teamCode) ?? null,
      statType
    )
    if (officialStat === null) {
      nbaValues = `team=${teamCode} official_q${startPeriod}=unavailable`
    } else {
      nbaValues = `team=${teamCode} official_q${startPeriod}_${statType.toLowerCase()}=${officialStat}`
    }
    detail = `team=${teamCode} stat=${statType} start=${startTeamStat} delta=${delta} final=${final} target=${minTeamStat} pbpDelta=${pbpDelta}`
  } else if (contextType === 'TEAM_COMPARE_PERIOD') {
    if (!homeCode || !awayCode) return null
    const homePbp = statFromAccumulator(accumulator, statType, homeCode)
    const awayPbp = statFromAccumulator(accumulator, statType, awayCode)
    const homeOfficial = getOfficialStatValue(
      officialQuarter?.teamStats.get(homeCode) ?? null,
      statType
    )
    const awayOfficial = getOfficialStatValue(
      officialQuarter?.teamStats.get(awayCode) ?? null,
      statType
    )
    const homeDelta = homeOfficial ?? homePbp
    const awayDelta = awayOfficial ?? awayPbp
    if (homeDelta === awayDelta) {
      computedState = 'cancelled'
      computedReason = 'TIE'
    } else {
      computedState = 'resolved'
      computedAnswer = homeDelta > awayDelta ? homeCode : awayCode
    }
    nbaValues =
      homeOfficial === null || awayOfficial === null
        ? `official_q${startPeriod} unavailable for ${statType}`
        : `official_q${startPeriod} ${homeCode}:${homeOfficial} ${awayCode}:${awayOfficial} stat=${statType}`
    detail = `home=${homeCode}:${homeDelta} away=${awayCode}:${awayDelta} stat=${statType} pbpHome=${homePbp} pbpAway=${awayPbp}`
  } else if (contextType === 'PLAYER_MILESTONE_PERIOD') {
    const playerId = toNumber(context.playerId)
    const startGameStat = toNumber(context.startGameStat)
    const target = toNumber(context.target)
    if (playerId === null || startGameStat === null || target === null)
      return null
    const pbpDelta = playerStatFromAccumulator(accumulator, statType, playerId)
    const officialStat = getOfficialStatValue(
      officialQuarter?.playerStats.get(playerId) ?? null,
      statType
    )
    const delta = officialStat ?? 0
    const final = startGameStat + delta
    computedState = 'resolved'
    computedAnswer = final >= startGameStat + target ? 'yes' : 'no'
    nbaValues =
      officialStat === null
        ? `player=${playerId} official_q${startPeriod}=unavailable`
        : `player=${playerId} official_q${startPeriod}_${statType.toLowerCase()}=${officialStat}`
    detail = `player=${playerId} stat=${statType} start=${startGameStat} delta=${delta} final=${final} targetDelta=${target} pbpDelta=${pbpDelta}`
  } else if (contextType === 'PLAYER_COMPARE_PERIOD') {
    const playerIds = Array.isArray(context.playerIds)
      ? context.playerIds.filter((id): id is number => typeof id === 'number')
      : []
    const startMap = context.startPlayerGameStats ?? {}
    if (!playerIds.length) return null
    let bestId: number | null = null
    let bestValue: number | null = null
    let tie = false
    const values: string[] = []
    for (const playerId of playerIds) {
      const start = toNumber(startMap[String(playerId)])
      if (start === null) continue
      const pbpDelta = playerStatFromAccumulator(
        accumulator,
        statType,
        playerId
      )
      const officialStat = getOfficialStatValue(
        officialQuarter?.playerStats.get(playerId) ?? null,
        statType
      )
      const delta = officialStat ?? 0
      const final = start + delta
      const value = final - start
      values.push(`${playerId}:${value}(pbp=${pbpDelta})`)
      if (bestValue === null || value > bestValue) {
        bestValue = value
        bestId = playerId
        tie = false
      } else if (value === bestValue) {
        tie = true
      }
    }
    if (bestId === null || bestValue === null) return null
    if (tie) {
      computedState = 'cancelled'
      computedReason = 'TIE'
    } else {
      computedState = 'resolved'
      computedAnswer = String(bestId)
    }
    const officialValues = playerIds.map((playerId) => {
      const officialStat = getOfficialStatValue(
        officialQuarter?.playerStats.get(playerId) ?? null,
        statType
      )
      return officialStat === null
        ? `${playerId}:0(unavailable)`
        : `${playerId}:${officialStat}`
    })
    nbaValues = `official_q${startPeriod} ${officialValues.join(', ')} stat=${statType}`
    detail = `stat=${statType} ${values.join(',')}`
  } else if (contextType === 'LEADER_END_OF_PERIOD') {
    const startHome = toNumber(context.startScoreHome) ?? 0
    const startAway = toNumber(context.startScoreAway) ?? 0
    const endAction = periodActions[periodActions.length - 1] ?? null
    const endHome = toNumber(endAction?.scoreHome) ?? startHome
    const endAway = toNumber(endAction?.scoreAway) ?? startAway
    const leader =
      endHome === endAway ? 'TIE' : endHome > endAway ? 'HOME' : 'AWAY'
    const leaderTricode =
      leader === 'HOME' ? homeCode : leader === 'AWAY' ? awayCode : null
    const requiresTrailing = context.requiresTrailing === true
    const requiresLeading = context.requiresLeading === true
    if (requiresTrailing) {
      computedState = 'resolved'
      if (leader === 'TIE') {
        computedAnswer = 'no'
      } else {
        const trailingTricode =
          typeof context.trailingTricode === 'string'
            ? normalizeCode(context.trailingTricode)
            : null
        computedAnswer =
          trailingTricode && leaderTricode && trailingTricode === leaderTricode
            ? 'yes'
            : 'no'
      }
    } else if (requiresLeading) {
      computedState = 'resolved'
      if (leader === 'TIE') {
        computedAnswer = 'no'
      } else {
        const leadingTricode =
          typeof context.leadingTricode === 'string'
            ? normalizeCode(context.leadingTricode)
            : null
        computedAnswer =
          leadingTricode && leaderTricode && leadingTricode === leaderTricode
            ? 'yes'
            : 'no'
      }
    } else if (leader === 'TIE') {
      computedState = 'cancelled'
      computedReason = 'TIE'
    } else {
      computedState = 'resolved'
      computedAnswer = leaderTricode
    }
    const homeOfficial = homeCode
      ? getOfficialStatValue(
          officialQuarter?.teamStats.get(homeCode) ?? null,
          'POINTS'
        )
      : null
    const awayOfficial = awayCode
      ? getOfficialStatValue(
          officialQuarter?.teamStats.get(awayCode) ?? null,
          'POINTS'
        )
      : null
    if (
      homeOfficial !== null &&
      awayOfficial !== null &&
      homeCode &&
      awayCode
    ) {
      nbaValues = `official_q${startPeriod} ${homeCode}:${homeOfficial} ${awayCode}:${awayOfficial}`
    } else {
      nbaValues = `score_home=${endHome} score_away=${endAway}`
    }
    detail = `score home=${endHome} away=${endAway}`
  } else {
    return null
  }

  const stateMatches = storedState === computedState
  const answerMatches = (storedAnswer ?? null) === (computedAnswer ?? null)
  const reasonMatches = storedReason === computedReason
  const mismatch =
    !stateMatches ||
    (computedState === 'resolved' && !answerMatches) ||
    (computedState === 'cancelled' && !reasonMatches)

  return {
    gameId,
    nbaGameId,
    questionId,
    template:
      typeof question.templateId === 'string'
        ? question.templateId
        : typeof question.engineTag === 'string'
          ? question.engineTag
          : 'unknown',
    question: typeof question.question === 'string' ? question.question : '',
    storedState,
    storedAnswer,
    storedReason,
    computedState,
    computedAnswer,
    computedReason,
    nbaValues,
    sourceUrl,
    sourceBoxScoreUrl,
    sourceGamePageUrl,
    detail,
    engineResolvedValue:
      storedState === 'resolved'
        ? `resolved:${storedAnswer ?? 'null'}`
        : `cancelled:${storedReason ?? 'null'}`,
    officialQuarterValue: nbaValues,
    mismatch,
  }
}

const main = async () => {
  const gameCount = Number(process.argv[2] ?? 5)
  const showValues = process.argv.includes('--show-values')
  const onlyCompare = process.argv.includes('--only-compare')
  const htmlArg = process.argv.find((arg) => arg.startsWith('--html-out='))
  const apply = process.argv.includes('--apply')
  const htmlOutPath = htmlArg ? htmlArg.slice('--html-out='.length) : null
  const limit =
    Number.isFinite(gameCount) && gameCount > 0 ? Math.min(gameCount, 20) : 5

  const gamesSnap = await db
    .collection('games')
    .orderBy('startTime', 'desc')
    .limit(limit * 25)
    .get()

  const candidates = gamesSnap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as GameDoc }))
    .filter(({ data }) => data.state === 'resolved' && !!data.nbaGameId)

  const selected: { id: string; data: GameDoc }[] = []
  for (const candidate of candidates) {
    if (selected.length >= limit) break
    selected.push(candidate)
  }

  const mismatches: CompareResult[] = []
  const comparisons: CompareResult[] = []
  let checked = 0

  for (const game of selected) {
    const nbaGameId = String(game.data.nbaGameId ?? '')
    const pbpUrl = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${nbaGameId}.json`
    const boxScoreUrl = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${nbaGameId}.json`
    const pbp = await fetchJson<PbpResponse>(pbpUrl)
    const boxScore = await fetchJson<BoxScoreResponse>(boxScoreUrl)
    const actions = (pbp.game?.actions ?? [])
      .filter((action): action is RawAction => !!action)
      .sort(
        (a, b) =>
          (toNumber(a.actionNumber) ?? 0) - (toNumber(b.actionNumber) ?? 0)
      )
    if (!actions.length || !isFinalStatusFromActions(actions)) continue

    const homeCode = normalizeCode(boxScore.game?.homeTeam?.teamTricode)
    const awayCode = normalizeCode(boxScore.game?.awayTeam?.teamTricode)
    const gamePageUrl =
      homeCode && awayCode
        ? `https://www.nba.com/game/${awayCode.toLowerCase()}-vs-${homeCode.toLowerCase()}-${nbaGameId}/box-score`
        : `https://www.nba.com/game/${nbaGameId}/box-score`

    const questionsSnap = await db
      .collection('games')
      .doc(game.id)
      .collection('questions')
      .where('windowType', '==', 'PERIOD')
      .where('state', 'in', ['resolved', 'cancelled'])
      .get()

    const periodsNeeded = new Set<number>()
    for (const doc of questionsSnap.docs) {
      const question = doc.data() as QuestionDoc
      const startPeriod = toNumber(question.resolutionContext?.startPeriod)
      if (startPeriod !== null && startPeriod >= 1 && startPeriod <= 4) {
        periodsNeeded.add(startPeriod)
      }
    }
    const officialQuarterDataByPeriod = new Map<number, OfficialQuarterData>()
    for (const period of periodsNeeded) {
      const periodUrl = `${gamePageUrl}?period=Q${period}`
      try {
        const html = await fetchHtml(periodUrl)
        const nextData = parseNextData(html)
        if (!nextData) {
          console.warn(
            `[compare-period-resolutions-with-nba] missing_next_data game=${game.id} nbaGameId=${nbaGameId} period=Q${period}`
          )
          continue
        }
        const quarterData = extractOfficialQuarterData(
          period,
          periodUrl,
          nextData
        )
        if (!quarterData) {
          console.warn(
            `[compare-period-resolutions-with-nba] missing_quarter_data game=${game.id} nbaGameId=${nbaGameId} period=Q${period}`
          )
          continue
        }
        officialQuarterDataByPeriod.set(period, quarterData)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `[compare-period-resolutions-with-nba] fetch_official_failed game=${game.id} nbaGameId=${nbaGameId} period=Q${period} error=${message}`
        )
      }
    }

    for (const doc of questionsSnap.docs) {
      checked += 1
      const question = doc.data() as QuestionDoc
      const comparison = compareQuestion(
        game.id,
        nbaGameId,
        doc.id,
        question,
        actions,
        officialQuarterDataByPeriod,
        boxScoreUrl,
        gamePageUrl
      )
      if (!comparison) continue
      comparisons.push(comparison)
      if (comparison.mismatch) mismatches.push(comparison)
    }
  }

  console.log(`Compared period questions=${checked} games=${selected.length}`)
  for (const game of selected) {
    const start = toDate(game.data.startTime)
    console.log(
      `  gameId=${game.id} nbaGameId=${String(game.data.nbaGameId ?? '')} start=${start ? start.toISOString() : '—'} matchup=${game.data.awayTeam ?? 'AWAY'} vs ${game.data.homeTeam ?? 'HOME'}`
    )
  }
  console.log(`Mismatches=${mismatches.length}`)
  if (showValues) {
    const rows = onlyCompare
      ? comparisons.filter(
          (row) =>
            row.template.includes('COMPARE') || row.template.includes('LEADER')
        )
      : comparisons
    for (const row of rows) {
      console.log(
        [
          `gameId=${row.gameId}`,
          `nbaGameId=${row.nbaGameId}`,
          `questionId=${row.questionId}`,
          `template=${row.template}`,
          `stored=${row.storedState}:${row.storedAnswer ?? 'null'}:${row.storedReason ?? 'null'}`,
          `computed=${row.computedState}:${row.computedAnswer ?? 'null'}:${row.computedReason ?? 'null'}`,
          `mismatch=${row.mismatch}`,
          `nba_values=${row.nbaValues}`,
          `source=${row.sourceUrl}`,
          `source_box=${row.sourceBoxScoreUrl}`,
          `source_page=${row.sourceGamePageUrl}`,
          `detail=${row.detail}`,
          `q="${row.question}"`,
        ].join(' ')
      )
    }
  }
  for (const mismatch of mismatches) {
    console.log(
      [
        `gameId=${mismatch.gameId}`,
        `nbaGameId=${mismatch.nbaGameId}`,
        `questionId=${mismatch.questionId}`,
        `template=${mismatch.template}`,
        `stored=${mismatch.storedState}:${mismatch.storedAnswer ?? 'null'}:${mismatch.storedReason ?? 'null'}`,
        `computed=${mismatch.computedState}:${mismatch.computedAnswer ?? 'null'}:${mismatch.computedReason ?? 'null'}`,
        `nba_values=${mismatch.nbaValues}`,
        `source=${mismatch.sourceUrl}`,
        `source_box=${mismatch.sourceBoxScoreUrl}`,
        `source_page=${mismatch.sourceGamePageUrl}`,
        `detail=${mismatch.detail}`,
        `q="${mismatch.question}"`,
      ].join(' ')
    )
  }

  if (htmlOutPath) {
    const rows = onlyCompare
      ? comparisons.filter(
          (row) =>
            row.template.includes('COMPARE') || row.template.includes('LEADER')
        )
      : comparisons
    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Period Resolution Comparison</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; color: #111827; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .meta { margin: 0 0 16px; color: #4b5563; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #f3f4f6; position: sticky; top: 0; z-index: 1; }
    tr.mismatch { background: #fff7ed; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>Period Resolution Comparison</h1>
  <p class="meta">Games: ${selected.length} • Questions compared: ${checked} • Rows: ${rows.length} • Mismatches: ${mismatches.length}</p>
  <table>
    <thead>
      <tr>
        <th>Game</th>
        <th>Question</th>
        <th>Template</th>
        <th>Stored</th>
        <th>Engine Resolved Value</th>
        <th>Computed (PBP Derived)</th>
        <th>NBA.com Quarter Values</th>
        <th>Official Quarter Value</th>
        <th>Detail</th>
        <th>Source</th>
        <th>Mismatch</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) => `<tr class="${row.mismatch ? 'mismatch' : ''}">
  <td class="mono">${escapeHtml(row.gameId)}<br/>${escapeHtml(row.nbaGameId)}</td>
  <td>${escapeHtml(row.question)}</td>
  <td class="mono">${escapeHtml(row.template)}</td>
  <td class="mono">state=${escapeHtml(row.storedState)}<br/>answer=${escapeHtml(row.storedAnswer ?? 'null')}<br/>reason=${escapeHtml(row.storedReason ?? 'null')}</td>
  <td class="mono">${escapeHtml(row.engineResolvedValue)}</td>
  <td class="mono">state=${escapeHtml(row.computedState)}<br/>answer=${escapeHtml(row.computedAnswer ?? 'null')}<br/>reason=${escapeHtml(row.computedReason ?? 'null')}</td>
  <td class="mono">${escapeHtml(row.nbaValues)}</td>
  <td class="mono">${escapeHtml(row.officialQuarterValue)}</td>
  <td class="mono">${escapeHtml(row.detail)}</td>
  <td class="mono">
    <a href="${escapeHtml(row.sourceGamePageUrl)}" target="_blank" rel="noopener noreferrer">NBA Box Score Page</a><br/>
    <a href="${escapeHtml(row.sourceBoxScoreUrl)}" target="_blank" rel="noopener noreferrer">Box Score JSON</a><br/>
    <a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener noreferrer">PBP JSON</a>
  </td>
  <td class="mono">${row.mismatch ? 'yes' : 'no'}</td>
</tr>`
        )
        .join('\n')}
    </tbody>
  </table>
</body>
</html>`
    const resolvedOutPath = path.isAbsolute(htmlOutPath)
      ? htmlOutPath
      : path.resolve(process.cwd(), htmlOutPath)
    fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true })
    fs.writeFileSync(resolvedOutPath, html, 'utf8')
    console.log(`HTML report written: ${resolvedOutPath}`)
  }

  if (apply && mismatches.length > 0) {
    const batchSize = 250
    let applied = 0
    for (let i = 0; i < mismatches.length; i += batchSize) {
      const chunk = mismatches.slice(i, i + batchSize)
      const batch = db.batch()
      for (const mismatch of chunk) {
        const ref = db
          .collection('games')
          .doc(mismatch.gameId)
          .collection('questions')
          .doc(mismatch.questionId)
        if (mismatch.computedState === 'resolved') {
          batch.set(
            ref,
            {
              state: 'resolved',
              answer: mismatch.computedAnswer ?? null,
              cancelReason: admin.firestore.FieldValue.delete(),
              resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        } else {
          batch.set(
            ref,
            {
              state: 'cancelled',
              answer: admin.firestore.FieldValue.delete(),
              cancelReason: mismatch.computedReason ?? 'VOID',
              closedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        }
      }
      await batch.commit()
      applied += chunk.length
    }
    console.log(`Applied mismatch patches=${applied}`)
  }
}

main().catch((error: Error) => {
  console.error('[compare-period-resolutions-with-nba] error', error)
  process.exit(1)
})
