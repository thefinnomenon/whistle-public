import https from 'https'
import zlib from 'zlib'

export type PlayerSeasonProfile = {
  playerId: string
  playerName: string
  teamId: string
  teamAbbr: string
  gp: number
  mpg: number
  ppg: number
  rpg: number
  bpg: number
  apg: number
  spg: number
  tov: number
  stl: number
  blk: number
  pf: number
  fg3m: number
  fg3a: number
  fta: number
  ftm: number
  ptsPerMin: number
  rebPerMin: number
  astPerMin: number
  stlPerMin: number
  blkPerMin: number
  pfPerMin: number
  fg3mPerMin: number
  ftaPerMin: number
  isScoringCandidate: boolean
  isReboundCandidate: boolean
  isAssistCandidate: boolean
  isStealsCandidate: boolean
  isBlocksCandidate: boolean
  isThreeCandidate: boolean
  isFreeThrowCandidate: boolean
  isFoulCandidate: boolean
}

export type TeamSeasonProfile = {
  teamId: string
  teamName: string
  gp: number
  mpg: number
  ppg: number
  rpg: number
  bpg: number
  apg: number
  spg: number
  tov: number
  stl: number
  blk: number
  pf: number
  fg3m: number
  fg3a: number
  fta: number
  ftm: number
  ptsPerMin: number
  rebPerMin: number
  astPerMin: number
  stlPerMin: number
  blkPerMin: number
  pfPerMin: number
  fg3mPerMin: number
  ftaPerMin: number
}

const NBA_HEADERS = {
  Host: 'stats.nba.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  Referer: 'https://stats.nba.com/',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua':
    '"Chromium";v="140", "Google Chrome";v="140", "Not;A=Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Fetch-Dest': 'empty',
} as const

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12_000

const playerSeasonById = new Map<string, PlayerSeasonProfile>()
const teamSeasonById = new Map<string, TeamSeasonProfile>()
let lastUpdatedAt: string | null = null
let isRefreshing = false

const getEnvSeason = () => process.env.NBA_SEASON || '2025-26'
const getEnvSeasonType = () => process.env.NBA_SEASON_TYPE || 'Regular Season'

export const buildLeagueDashPlayerStatsUrl = (opts: {
  season: string
  seasonType: string
}) => {
  const params = new URLSearchParams({
    LeagueID: '00',
    Season: opts.season,
    SeasonType: opts.seasonType,
    PerMode: 'PerGame',
    MeasureType: 'Base',
    PlusMinus: 'N',
    PaceAdjust: 'N',
    Rank: 'N',
    Outcome: '',
    Location: '',
    Month: '0',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    OpponentTeamID: '0',
    VsConference: '',
    VsDivision: '',
    GameSegment: '',
    Period: '0',
    ShotClockRange: '',
    LastNGames: '0',
  })
  return `https://stats.nba.com/stats/leaguedashplayerstats?${params.toString()}`
}

export const buildLeagueDashTeamStatsUrl = (opts: {
  season: string
  seasonType: string
}) => {
  const params = new URLSearchParams({
    LeagueID: '00',
    Season: opts.season,
    SeasonType: opts.seasonType,
    PerMode: 'PerGame',
    MeasureType: 'Base',
    PlusMinus: 'N',
    PaceAdjust: 'N',
    Rank: 'N',
    Outcome: '',
    Location: '',
    Month: '0',
    SeasonSegment: '',
    DateFrom: '',
    DateTo: '',
    OpponentTeamID: '0',
    VsConference: '',
    VsDivision: '',
    GameSegment: '',
    Period: '0',
    ShotClockRange: '',
    LastNGames: '0',
  })
  return `https://stats.nba.com/stats/leaguedashteamstats?${params.toString()}`
}

const fetchJson = (url: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { headers: NBA_HEADERS }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const encoding = String(
          res.headers['content-encoding'] || ''
        ).toLowerCase()
        let dataBuffer: Buffer = buffer
        try {
          if (encoding.includes('br')) {
            dataBuffer = zlib.brotliDecompressSync(buffer) as Buffer
          } else if (encoding.includes('gzip')) {
            dataBuffer = zlib.gunzipSync(buffer) as Buffer
          } else if (encoding.includes('deflate')) {
            dataBuffer = zlib.inflateSync(buffer) as Buffer
          }
        } catch (err) {
          reject(err)
          return
        }
        try {
          resolve(JSON.parse(dataBuffer.toString('utf8')))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`NBA stats request timeout ${REQUEST_TIMEOUT_MS}ms`)
      )
    })
    req.on('error', reject)
    req.end()
  })

const toNumber = (value: any) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const toPerMinute = (value: number, mpg: number) => (mpg > 0 ? value / mpg : 0)

const parsePlayerProfiles = (payload: any): PlayerSeasonProfile[] => {
  const resultSets = Array.isArray(payload?.resultSets)
    ? payload.resultSets
    : payload?.resultSet
      ? [payload.resultSet]
      : []
  const table = resultSets.find(
    (set: any) =>
      Array.isArray(set?.headers) &&
      set.headers.includes('PLAYER_ID') &&
      set.headers.includes('PLAYER_NAME') &&
      set.headers.includes('TEAM_ID') &&
      set.headers.includes('TEAM_ABBREVIATION') &&
      set.headers.includes('GP') &&
      set.headers.includes('MIN') &&
      set.headers.includes('PTS') &&
      set.headers.includes('REB') &&
      set.headers.includes('AST') &&
      set.headers.includes('TOV') &&
      set.headers.includes('STL') &&
      set.headers.includes('BLK') &&
      set.headers.includes('PF') &&
      set.headers.includes('FG3M') &&
      set.headers.includes('FG3A') &&
      set.headers.includes('FTM') &&
      set.headers.includes('FTA')
  )
  if (!table) return []
  const headers: string[] = table.headers
  const rows: any[][] = table.rowSet || []
  const idx = (name: string) => headers.indexOf(name)
  const getValue = (row: any[], name: string) => row[idx(name)]

  return rows.map((row) => {
    const gp = toNumber(getValue(row, 'GP'))
    const mpg = toNumber(getValue(row, 'MIN'))
    const ppg = toNumber(getValue(row, 'PTS'))
    const rpg = toNumber(getValue(row, 'REB'))
    const apg = toNumber(getValue(row, 'AST'))
    const spg = toNumber(getValue(row, 'STL'))
    const bpg = toNumber(getValue(row, 'BLK'))
    const pf = toNumber(getValue(row, 'PF'))
    const tov = toNumber(getValue(row, 'TOV'))
    const fg3m = toNumber(getValue(row, 'FG3M'))
    const fg3a = toNumber(getValue(row, 'FG3A'))
    const ftm = toNumber(getValue(row, 'FTM'))
    const fta = toNumber(getValue(row, 'FTA'))

    return {
      playerId: String(getValue(row, 'PLAYER_ID') ?? ''),
      playerName: String(getValue(row, 'PLAYER_NAME') ?? ''),
      teamId: String(getValue(row, 'TEAM_ID') ?? ''),
      teamAbbr: String(getValue(row, 'TEAM_ABBREVIATION') ?? ''),
      gp,
      mpg,
      ppg,
      rpg,
      bpg,
      apg,
      spg,
      tov,
      stl: spg,
      blk: bpg,
      pf,
      fg3m,
      fg3a,
      fta,
      ftm,
      ptsPerMin: toPerMinute(ppg, mpg),
      rebPerMin: toPerMinute(rpg, mpg),
      astPerMin: toPerMinute(apg, mpg),
      stlPerMin: toPerMinute(spg, mpg),
      blkPerMin: toPerMinute(bpg, mpg),
      pfPerMin: toPerMinute(pf, mpg),
      fg3mPerMin: toPerMinute(fg3m, mpg),
      ftaPerMin: toPerMinute(fta, mpg),
      isScoringCandidate: ppg >= 10 && mpg >= 18,
      isReboundCandidate: rpg >= 6 && mpg >= 18,
      isAssistCandidate: apg >= 4 && mpg >= 18,
      isStealsCandidate: spg >= 1.2 && mpg >= 18,
      isBlocksCandidate: bpg >= 1.2 && mpg >= 18,
      isThreeCandidate: fg3a >= 3 && mpg >= 18,
      isFreeThrowCandidate: fta >= 2 && mpg >= 18,
      isFoulCandidate: pf >= 2.5 && mpg >= 18,
    }
  })
}

const parseTeamProfiles = (payload: any): TeamSeasonProfile[] => {
  const resultSets = Array.isArray(payload?.resultSets)
    ? payload.resultSets
    : payload?.resultSet
      ? [payload.resultSet]
      : []
  const table = resultSets.find(
    (set: any) =>
      Array.isArray(set?.headers) &&
      set.headers.includes('TEAM_ID') &&
      (set.headers.includes('TEAM_ABBREVIATION') ||
        set.headers.includes('TEAM_NAME')) &&
      set.headers.includes('GP') &&
      set.headers.includes('MIN') &&
      set.headers.includes('PTS') &&
      set.headers.includes('REB') &&
      set.headers.includes('AST') &&
      set.headers.includes('TOV') &&
      set.headers.includes('STL') &&
      set.headers.includes('BLK') &&
      set.headers.includes('FG3M') &&
      set.headers.includes('FG3A') &&
      set.headers.includes('FTM') &&
      set.headers.includes('FTA')
  )
  if (!table) return []
  const headers: string[] = table.headers
  const rows: any[][] = table.rowSet || []
  const idx = (name: string) => headers.indexOf(name)
  const getValue = (row: any[], name: string) => row[idx(name)]
  const hasTeamAbbr = headers.includes('TEAM_ABBREVIATION')
  const hasTeamName = headers.includes('TEAM_NAME')

  return rows.map((row) => {
    const gp = toNumber(getValue(row, 'GP'))
    const mpg = toNumber(getValue(row, 'MIN'))
    const ppg = toNumber(getValue(row, 'PTS'))
    const rpg = toNumber(getValue(row, 'REB'))
    const apg = toNumber(getValue(row, 'AST'))
    const spg = toNumber(getValue(row, 'STL'))
    const bpg = toNumber(getValue(row, 'BLK'))
    const pf = headers.includes('PF') ? toNumber(getValue(row, 'PF')) : 0
    const tov = toNumber(getValue(row, 'TOV'))
    const fg3m = toNumber(getValue(row, 'FG3M'))
    const fg3a = toNumber(getValue(row, 'FG3A'))
    const ftm = toNumber(getValue(row, 'FTM'))
    const fta = toNumber(getValue(row, 'FTA'))
    const teamAbbrRaw = hasTeamAbbr ? getValue(row, 'TEAM_ABBREVIATION') : ''
    const teamNameRaw = hasTeamName ? getValue(row, 'TEAM_NAME') : ''

    return {
      teamId: String(getValue(row, 'TEAM_ID') ?? ''),
      teamName: String(teamNameRaw || teamAbbrRaw || ''),
      gp,
      mpg,
      ppg,
      rpg,
      bpg,
      apg,
      spg,
      tov,
      stl: spg,
      blk: bpg,
      pf,
      fg3m,
      fg3a,
      fta,
      ftm,
      ptsPerMin: toPerMinute(ppg, mpg),
      rebPerMin: toPerMinute(rpg, mpg),
      astPerMin: toPerMinute(apg, mpg),
      stlPerMin: toPerMinute(spg, mpg),
      blkPerMin: toPerMinute(bpg, mpg),
      pfPerMin: toPerMinute(pf, mpg),
      fg3mPerMin: toPerMinute(fg3m, mpg),
      ftaPerMin: toPerMinute(fta, mpg),
    }
  })
}

export const fetchSeasonProfilesOnce = async (opts?: {
  season?: string
  seasonType?: string
}) => {
  const season = opts?.season || getEnvSeason()
  const seasonType = opts?.seasonType || getEnvSeasonType()
  const url = buildLeagueDashPlayerStatsUrl({ season, seasonType })
  const teamUrl = buildLeagueDashTeamStatsUrl({ season, seasonType })
  const [payload, teamPayload] = await Promise.all([
    fetchJson(url),
    fetchJson(teamUrl),
  ])
  const teams = parseTeamProfiles(teamPayload)
  if (!teams.length) {
    const resultSets = Array.isArray(teamPayload?.resultSets)
      ? teamPayload.resultSets
      : teamPayload?.resultSet
        ? [teamPayload.resultSet]
        : []
    const headersPreview = resultSets.map((set: any) => ({
      name: set?.name,
      headers: Array.isArray(set?.headers) ? set.headers : [],
    }))
    console.warn(
      '[seasonProfiles] team parse empty',
      JSON.stringify(
        {
          season,
          seasonType,
          resultSetCount: resultSets.length,
          headersPreview,
        },
        null,
        2
      )
    )
  }
  return {
    season,
    seasonType,
    fetchedAt: new Date().toISOString(),
    players: parsePlayerProfiles(payload),
    teams,
  }
}

const refreshSeasonProfiles = async () => {
  if (isRefreshing) return
  isRefreshing = true
  const startedAt = Date.now()
  const season = getEnvSeason()
  const seasonType = getEnvSeasonType()
  const url = buildLeagueDashPlayerStatsUrl({ season, seasonType })
  const teamUrl = buildLeagueDashTeamStatsUrl({ season, seasonType })
  console.log(
    `[seasonProfiles] refresh start season=${season} type=${seasonType}`
  )
  try {
    const [payload, teamPayload] = await Promise.all([
      fetchJson(url),
      fetchJson(teamUrl),
    ])
    const profiles = parsePlayerProfiles(payload)
    const teamProfiles = parseTeamProfiles(teamPayload)
    const nextPlayers = new Map<string, PlayerSeasonProfile>()
    const nextTeams = new Map<string, TeamSeasonProfile>()
    for (const profile of profiles) {
      if (!profile.playerId) continue
      nextPlayers.set(profile.playerId, profile)
    }
    for (const team of teamProfiles) {
      if (!team.teamId) continue
      nextTeams.set(team.teamId, team)
    }
    playerSeasonById.clear()
    teamSeasonById.clear()
    for (const [key, value] of nextPlayers) playerSeasonById.set(key, value)
    for (const [key, value] of nextTeams) teamSeasonById.set(key, value)
    lastUpdatedAt = new Date().toISOString()
    const durationMs = Date.now() - startedAt
    console.log(
      `[seasonProfiles] refresh success players=${playerSeasonById.size} teams=${teamSeasonById.size} durationMs=${durationMs}`
    )
  } catch (err) {
    console.error('[seasonProfiles] refresh failure', err)
  } finally {
    isRefreshing = false
  }
}

export const startSeasonProfilesWorker = async (): Promise<void> => {
  await refreshSeasonProfiles()
  setInterval(() => {
    void refreshSeasonProfiles()
  }, REFRESH_INTERVAL_MS)
}

export const getPlayerSeasonProfile = (playerId: string) =>
  playerSeasonById.get(playerId)

export const getTeamSeasonProfile = (teamId: string) =>
  teamSeasonById.get(teamId)

export const isSeasonProfilesReady = () => !!lastUpdatedAt

export const getSeasonProfilesMeta = () => ({
  lastUpdatedAt,
  season: getEnvSeason(),
  seasonType: getEnvSeasonType(),
  playersCount: playerSeasonById.size,
})
