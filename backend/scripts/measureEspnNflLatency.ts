import https from 'https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib'

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type JsonObject = { [key: string]: JsonValue }

type EspnPlay = {
  id: string
  text: string
  type: string
  period: number | null
  clock: string | null
  wallclock: string | null
}

type SummarySnapshot = {
  status: string
  plays: EspnPlay[]
  responseMs: number
  payloadBytes: number
  cacheControl: string | null
}

const ESPN_SUMMARY_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary'
const ESPN_TIMEOUT_MS = 15_000

const asObject = (value: JsonValue | undefined): JsonObject | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

const asArray = (value: JsonValue | undefined): JsonValue[] =>
  Array.isArray(value) ? value : []

const asString = (value: JsonValue | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const asNumber = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const parseArg = (name: string): string | null => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : null
}

const parsePositiveNumber = (
  name: string,
  value: string | null | undefined,
  fallback: number,
  minimum: number
): number => {
  if (!value) return fallback
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= minimum) return parsed
  throw new Error(
    `${name} must be a number greater than or equal to ${minimum}`
  )
}

const decodeBody = (body: Buffer, encoding: string | undefined): Buffer => {
  if (encoding === 'gzip') return gunzipSync(body)
  if (encoding === 'deflate') return inflateSync(body)
  if (encoding === 'br') return brotliDecompressSync(body)
  return body
}

const extractPlay = (value: JsonValue): EspnPlay | null => {
  const play = asObject(value)
  const id = asString(play?.id)
  if (!play || !id) return null

  const type = asObject(play.type)
  const period = asObject(play.period)
  const clock = asObject(play.clock)

  return {
    id,
    text: asString(play.text) ?? '',
    type: asString(type?.text) ?? 'Unknown',
    period: asNumber(period?.number),
    clock: asString(clock?.displayValue),
    wallclock: asString(play.wallclock),
  }
}

const extractDrivePlays = (value: JsonValue | undefined): EspnPlay[] => {
  const drive = asObject(value)
  if (!drive) return []
  return asArray(drive.plays)
    .map(extractPlay)
    .filter((play): play is EspnPlay => play !== null)
}

const extractPlays = (root: JsonObject): EspnPlay[] => {
  const drives = asObject(root.drives)
  const previousDrives = asArray(drives?.previous)
  const previousPlays = previousDrives.flatMap(extractDrivePlays)
  const currentPlays = extractDrivePlays(drives?.current)
  const topLevelPlays = asArray(root.plays)
    .map(extractPlay)
    .filter((play): play is EspnPlay => play !== null)

  const byId = new Map<string, EspnPlay>()
  for (const play of [...previousPlays, ...currentPlays, ...topLevelPlays]) {
    byId.set(play.id, play)
  }
  return [...byId.values()]
}

const extractStatus = (root: JsonObject): string => {
  const header = asObject(root.header)
  const competition = asObject(asArray(header?.competitions)[0])
  const status = asObject(competition?.status)
  const type = asObject(status?.type)
  return asString(type?.name) ?? 'STATUS_UNKNOWN'
}

const fetchSummary = (eventId: string): Promise<SummarySnapshot> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const url = new URL(ESPN_SUMMARY_URL)
    url.searchParams.set('event', eventId)

    const req = https.get(
      url.toString(),
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': 'Whistle/1.0 NFL latency evaluation',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const responseMs = Date.now() - startedAt
          const compressedBody = Buffer.concat(chunks)
          const statusCode = res.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`ESPN request failed with status ${statusCode}`))
            return
          }

          try {
            const contentEncoding = Array.isArray(
              res.headers['content-encoding']
            )
              ? res.headers['content-encoding'][0]
              : res.headers['content-encoding']
            const decodedBody = decodeBody(compressedBody, contentEncoding)
            const parsed = JSON.parse(decodedBody.toString('utf8')) as JsonValue
            const root = asObject(parsed)
            if (!root) throw new Error('ESPN response was not an object')

            const cacheHeader = res.headers['cache-control']
            resolve({
              status: extractStatus(root),
              plays: extractPlays(root),
              responseMs,
              payloadBytes: compressedBody.length,
              cacheControl:
                typeof cacheHeader === 'string' ? cacheHeader : null,
            })
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    )

    req.setTimeout(ESPN_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`ESPN request timed out after ${ESPN_TIMEOUT_MS}ms`)
      )
    })
    req.on('error', reject)
  })

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  )
  return sorted[index]
}

const formatMetric = (value: number | null): string =>
  value === null ? 'na' : String(Math.round(value))

const main = async () => {
  const eventId = parseArg('event') ?? process.env.ESPN_NFL_EVENT_ID
  if (!eventId) {
    throw new Error(
      'Provide an ESPN event ID with --event=401873272 or ESPN_NFL_EVENT_ID'
    )
  }

  const pollMs = parsePositiveNumber(
    'poll-ms',
    parseArg('poll-ms') ?? process.env.ESPN_NFL_POLL_MS,
    1_000,
    500
  )
  const maxMinutes = parsePositiveNumber(
    'max-minutes',
    parseArg('max-minutes') ?? process.env.ESPN_NFL_MAX_MINUTES,
    300,
    1
  )
  const once = parseArg('once') === '1'
  const playFingerprints = new Map<string, string>()
  const latencySamples: number[] = []
  const responseSamples: number[] = []
  const startedAt = Date.now()
  let pollCount = 0
  let errorCount = 0
  let baselineLoaded = false
  let stopped = false
  let newPlayCount = 0
  let revisionCount = 0
  let lastStatus = 'STATUS_UNKNOWN'
  let lastHeartbeatAt = 0

  const printSummary = () => {
    console.log(
      [
        '[espn-nfl-latency] summary',
        `event=${eventId}`,
        `polls=${pollCount}`,
        `errors=${errorCount}`,
        `newPlays=${newPlayCount}`,
        `revisions=${revisionCount}`,
        `latencyP50Ms=${formatMetric(percentile(latencySamples, 0.5))}`,
        `latencyP90Ms=${formatMetric(percentile(latencySamples, 0.9))}`,
        `latencyP95Ms=${formatMetric(percentile(latencySamples, 0.95))}`,
        `responseP50Ms=${formatMetric(percentile(responseSamples, 0.5))}`,
        `responseP95Ms=${formatMetric(percentile(responseSamples, 0.95))}`,
        `status=${lastStatus}`,
      ].join(' ')
    )
  }

  process.on('SIGINT', () => {
    stopped = true
  })
  process.on('SIGTERM', () => {
    stopped = true
  })

  console.log(
    `[espn-nfl-latency] started event=${eventId} pollMs=${pollMs} maxMinutes=${maxMinutes}`
  )

  while (!stopped && Date.now() - startedAt < maxMinutes * 60_000) {
    const pollStartedAt = Date.now()
    try {
      const snapshot = await fetchSummary(eventId)
      const receivedAt = Date.now()
      pollCount += 1
      lastStatus = snapshot.status
      responseSamples.push(snapshot.responseMs)

      if (!baselineLoaded) {
        for (const play of snapshot.plays) {
          playFingerprints.set(play.id, JSON.stringify(play))
        }
        baselineLoaded = true
        console.log(
          `[espn-nfl-latency] baseline event=${eventId} plays=${snapshot.plays.length} status=${snapshot.status} responseMs=${snapshot.responseMs} payloadBytes=${snapshot.payloadBytes} cache=${snapshot.cacheControl ?? 'unknown'}`
        )
      } else {
        for (const play of snapshot.plays) {
          const fingerprint = JSON.stringify(play)
          const previousFingerprint = playFingerprints.get(play.id)
          if (previousFingerprint) {
            if (previousFingerprint !== fingerprint) {
              playFingerprints.set(play.id, fingerprint)
              revisionCount += 1
              console.log(
                `[espn-nfl-latency] revised_play event=${eventId} play=${play.id} revisions=${revisionCount} type=${JSON.stringify(play.type)} text=${JSON.stringify(play.text)}`
              )
            }
            continue
          }
          playFingerprints.set(play.id, fingerprint)
          newPlayCount += 1

          const wallclockMs = play.wallclock
            ? Date.parse(play.wallclock)
            : Number.NaN
          const latencyMs = Number.isFinite(wallclockMs)
            ? receivedAt - wallclockMs
            : null
          if (latencyMs !== null) latencySamples.push(latencyMs)

          console.log(
            [
              '[espn-nfl-latency] new_play',
              `event=${eventId}`,
              `play=${play.id}`,
              `type=${JSON.stringify(play.type)}`,
              `period=${play.period ?? 'na'}`,
              `clock=${play.clock ?? 'na'}`,
              `latencyMs=${latencyMs ?? 'na'}`,
              `responseMs=${snapshot.responseMs}`,
              `text=${JSON.stringify(play.text)}`,
            ].join(' ')
          )
        }
      }

      if (once) break
      if (snapshot.status === 'STATUS_FINAL') break

      if (receivedAt - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = receivedAt
        console.log(
          `[espn-nfl-latency] heartbeat event=${eventId} polls=${pollCount} errors=${errorCount} knownPlays=${playFingerprints.size} revisions=${revisionCount} status=${snapshot.status} responseMs=${snapshot.responseMs} payloadBytes=${snapshot.payloadBytes}`
        )
      }
    } catch (error) {
      errorCount += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[espn-nfl-latency] poll_error event=${eventId} errors=${errorCount} message=${JSON.stringify(message)}`
      )
      if (once) throw error
    }

    const elapsedMs = Date.now() - pollStartedAt
    const delayMs = Math.max(0, pollMs - elapsedMs)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs)
    })
  }

  printSummary()
}

main().catch((error: Error) => {
  console.error('[espn-nfl-latency] fatal', error)
  process.exit(1)
})
