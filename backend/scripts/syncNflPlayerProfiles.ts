import {
  fetchEspnNflPlayerPriorSeasonProfile,
  fetchEspnNflRoster,
  getEspnNflTeamCodes,
  type EspnNflRosterPlayer,
  type NflPlayerPriorSeasonProfile,
} from '../src/lib/nfl'
import { admin, db } from '../src/firebase'

type SyncOptions = {
  apply: boolean
  concurrency: number
  force: boolean
  maxPlayers: number | null
  seasonYear: number
}

type PlayerProfileResult = {
  player: EspnNflRosterPlayer
  profile: NflPlayerPriorSeasonProfile | null
  errorMessage: string | null
}

const parsePositiveInteger = (
  value: string | undefined,
  optionName: string
): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`)
  }
  return parsed
}

const readOptionValue = (
  argument: string,
  optionName: string
): string | null =>
  argument.startsWith(`${optionName}=`)
    ? argument.slice(optionName.length + 1)
    : null

const parseOptions = (): SyncOptions => {
  const currentYear = new Date().getUTCFullYear()
  const options: SyncOptions = {
    apply: false,
    concurrency: 4,
    force: false,
    maxPlayers: null,
    seasonYear: currentYear - 1,
  }
  for (const argument of process.argv.slice(2)) {
    if (argument === '--apply') {
      options.apply = true
      continue
    }
    if (argument === '--force') {
      options.force = true
      continue
    }
    const concurrency = readOptionValue(argument, '--concurrency')
    if (concurrency !== null) {
      options.concurrency = parsePositiveInteger(concurrency, '--concurrency')
      continue
    }
    const maxPlayers = readOptionValue(argument, '--max-players')
    if (maxPlayers !== null) {
      options.maxPlayers = parsePositiveInteger(maxPlayers, '--max-players')
      continue
    }
    const seasonYear = readOptionValue(argument, '--season')
    if (seasonYear !== null) {
      options.seasonYear = parsePositiveInteger(seasonYear, '--season')
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  transform: (item: Input) => Promise<Output>
): Promise<Output[]> => {
  const results: Output[] = new Array(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await transform(item)
    }
  }
  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

const loadRosterPlayers = async (
  concurrency: number
): Promise<EspnNflRosterPlayer[]> => {
  const teamCodes = getEspnNflTeamCodes()
  const teamRosters = await mapWithConcurrency(
    teamCodes,
    concurrency,
    async (teamCode) => {
      const players = await fetchEspnNflRoster(teamCode)
      console.log(
        `[sync-nfl-profiles] roster team=${teamCode} players=${players.length}`
      )
      return players
    }
  )
  const playersById = new Map<string, EspnNflRosterPlayer>()
  for (const player of teamRosters.flat()) {
    if (!playersById.has(player.id)) playersById.set(player.id, player)
  }
  return [...playersById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
}

const fetchPlayerProfile = async (
  player: EspnNflRosterPlayer,
  seasonYear: number
): Promise<PlayerProfileResult> => {
  try {
    return {
      player,
      profile: await fetchEspnNflPlayerPriorSeasonProfile(
        player.id,
        seasonYear
      ),
      errorMessage: null,
    }
  } catch (error) {
    return {
      player,
      profile: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}

const writeProfiles = async (
  results: readonly PlayerProfileResult[],
  seasonYear: number
): Promise<number> => {
  const successfulResults = results.filter(
    (result) => result.errorMessage === null
  )
  const batchSize = 400
  let writes = 0
  for (let offset = 0; offset < successfulResults.length; offset += batchSize) {
    const batch = db.batch()
    for (const result of successfulResults.slice(offset, offset + batchSize)) {
      const document = db.collection('nflPlayerProfiles').doc(result.player.id)
      batch.set(document, {
        athleteId: result.player.id,
        displayName: result.player.displayName,
        teamCode: result.player.teamCode,
        position: result.player.position,
        seasonYear,
        hasPriorSeasonProfile: result.profile !== null,
        ...(result.profile ?? {}),
        source: 'espn',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      writes += 1
    }
    await batch.commit()
    console.log(
      `[sync-nfl-profiles] batch committed writes=${Math.min(offset + batchSize, successfulResults.length)} total=${successfulResults.length}`
    )
  }
  return writes
}

const run = async (): Promise<void> => {
  const options = parseOptions()
  const mode = options.apply ? 'apply' : 'dry-run'
  const projectId = admin.app().options.projectId ?? 'unknown'
  console.log(
    `[sync-nfl-profiles] start mode=${mode} project=${projectId} season=${options.seasonYear} concurrency=${options.concurrency} force=${options.force ? 1 : 0} maxPlayers=${options.maxPlayers ?? 'all'}`
  )

  const rosterPlayers = await loadRosterPlayers(options.concurrency)
  const existingSnapshot = await db.collection('nflPlayerProfiles').get()
  const existingIds = new Set(
    options.force
      ? []
      : existingSnapshot.docs
          .filter(
            (document) => document.data().seasonYear === options.seasonYear
          )
          .map((document) => document.id)
  )
  const pendingPlayers = rosterPlayers.filter(
    (player) => !existingIds.has(player.id)
  )
  const selectedPlayers =
    options.maxPlayers === null
      ? pendingPlayers
      : pendingPlayers.slice(0, options.maxPlayers)
  console.log(
    `[sync-nfl-profiles] scope rosterPlayers=${rosterPlayers.length} existingDocs=${existingSnapshot.size} alreadySynced=${rosterPlayers.length - pendingPlayers.length} selected=${selectedPlayers.length}`
  )

  const results = await mapWithConcurrency(
    selectedPlayers,
    options.concurrency,
    (player) => fetchPlayerProfile(player, options.seasonYear)
  )
  const withHistory = results.filter((result) => result.profile !== null).length
  const withoutHistory = results.filter(
    (result) => result.profile === null && result.errorMessage === null
  ).length
  const failed = results.filter((result) => result.errorMessage !== null)
  for (const result of failed.slice(0, 20)) {
    console.error(
      `[sync-nfl-profiles] fetch failed athlete=${result.player.id} name=${JSON.stringify(result.player.displayName)} message=${result.errorMessage}`
    )
  }
  console.log(
    `[sync-nfl-profiles] fetched selected=${results.length} withHistory=${withHistory} withoutHistory=${withoutHistory} failed=${failed.length}`
  )

  const writes = options.apply
    ? await writeProfiles(results, options.seasonYear)
    : 0
  console.log(
    `[sync-nfl-profiles] complete mode=${mode} writes=${writes} failed=${failed.length}`
  )
  if (failed.length > 0) process.exitCode = 1
}

void run().catch((error) => {
  console.error(
    `[sync-nfl-profiles] fatal message=${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
