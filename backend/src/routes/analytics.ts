import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { isAdminMiddleware } from '../middleware/isAdmin'

const router = Router()

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type MixpanelEventRecord = {
  event: string
  properties: { [key: string]: JsonValue }
}

type BreakdownItem = {
  key: string
  sent: number
  opened: number
  answered: number
  resolved: number
  voided: number
  send_to_answer_rate: number | null
  open_rate: number | null
  void_rate: number | null
  median_time_to_answer_ms: number | null
}

type SummaryResponse = {
  range_days: number
  from_date: string
  to_date: string
  generated_at: string
  totals: {
    question_sent: number
    question_opened: number
    question_answered: number
    question_resolved: number
    send_to_open_rate: number | null
    send_to_answer_rate: number | null
    median_time_to_answer_ms: number | null
    avg_answers_per_user_per_game: number | null
    pct_user_games_with_5_plus_answers: number | null
    users_with_2_plus_games_7d: number | null
  }
  by_question_type: BreakdownItem[]
  by_trigger_type: BreakdownItem[]
  by_latency_bucket: {
    latency_bucket: string
    sent: number
    answered: number
    send_to_answer_rate: number | null
    median_time_to_answer_ms: number | null
  }[]
}

const CACHE_TTL_MS = 60_000
const cachedSummaries = new Map<
  string,
  { expiresAt: number; payload: SummaryResponse }
>()

const CANONICAL_EVENTS = [
  'question_created',
  'question_sent',
  'question_opened',
  'question_answered',
  'question_resolved',
]
const LEGACY_EVENTS = [
  'prediction_submitted',
  'notification_viewed',
  'notification_prediction_submitted',
  'notification_displayed',
  'question_cancelled',
  'question_closed',
]
const MIXPANEL_EVENTS = [...CANONICAL_EVENTS, ...LEGACY_EVENTS]

const toDateKey = (date: Date) => date.toISOString().slice(0, 10)

const parseRangeDays = (raw: string | undefined) => {
  const normalized = String(raw || '7d')
    .trim()
    .toLowerCase()
  if (normalized === '30d') return 30
  return 7
}

const toLatencyBucket = (latencyMs: number | null) => {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return null
  if (latencyMs < 5_000) return '0-5s'
  if (latencyMs < 10_000) return '5-10s'
  if (latencyMs < 20_000) return '10-20s'
  if (latencyMs < 40_000) return '20-40s'
  return '40s+'
}

const asString = (
  props: { [key: string]: JsonValue },
  keys: string[]
): string | null => {
  for (const key of keys) {
    const value = props[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const asNumber = (
  props: { [key: string]: JsonValue },
  keys: string[]
): number | null => {
  for (const key of keys) {
    const value = props[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null)

type AuthCandidate = {
  method: string
  header: string
}

const mixpanelAuthCandidates = (): AuthCandidate[] => {
  const candidates: AuthCandidate[] = []
  const explicitBasic = process.env.MIXPANEL_EXPORT_AUTH_BASIC
  if (explicitBasic && explicitBasic.trim()) {
    candidates.push({
      method: 'explicit_basic',
      header: explicitBasic.trim().startsWith('Basic ')
        ? explicitBasic.trim()
        : `Basic ${explicitBasic.trim()}`,
    })
  }

  const apiSecret =
    process.env.MIXPANEL_API_SECRET || process.env.MIXPANEL_PROJECT_SECRET
  if (apiSecret && apiSecret.trim()) {
    candidates.push({
      method: 'api_secret',
      header: `Basic ${Buffer.from(`${apiSecret.trim()}:`).toString('base64')}`,
    })
  }

  const serviceUsername = process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME
  const serviceSecret = process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET
  if (serviceUsername && serviceSecret) {
    candidates.push({
      method: 'service_account',
      header: `Basic ${Buffer.from(
        `${serviceUsername}:${serviceSecret}`
      ).toString('base64')}`,
    })
  }

  return candidates
}

const missingCredentialsMessage =
  'Missing Mixpanel export credentials. Set MIXPANEL_API_SECRET (preferred) or MIXPANEL_PROJECT_SECRET, or MIXPANEL_EXPORT_AUTH_BASIC. Service accounts may not be accepted for Export API on all projects.'

const toObject = (
  value: { [key: string]: JsonValue } | null | undefined
): { [key: string]: JsonValue } => value || {}

const parseEventLine = (line: string): MixpanelEventRecord | null => {
  try {
    const parsed = JSON.parse(line) as {
      event?: string
      properties?: { [key: string]: JsonValue }
    }
    if (typeof parsed.event !== 'string') return null
    return { event: parsed.event, properties: toObject(parsed.properties) }
  } catch {
    return null
  }
}

const fetchCanonicalEvents = async (
  fromDate: string,
  toDate: string
): Promise<MixpanelEventRecord[]> => {
  const authCandidates = mixpanelAuthCandidates()
  if (!authCandidates.length) throw new Error(missingCredentialsMessage)

  const exportBaseUrl =
    process.env.MIXPANEL_EXPORT_BASE_URL ||
    'https://data.mixpanel.com/api/2.0/export'

  const url = new URL(exportBaseUrl)
  url.searchParams.set('from_date', fromDate)
  url.searchParams.set('to_date', toDate)
  url.searchParams.set('event', JSON.stringify(MIXPANEL_EVENTS))

  let lastError: string | null = null

  for (const candidate of authCandidates) {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: candidate.header,
        Accept: 'text/plain',
      },
    })
    if (!resp.ok) {
      const body = await resp.text()
      lastError = `method=${candidate.method} status=${resp.status} body=${body}`
      // Try next auth style only for auth/forbidden failures.
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        continue
      }
      throw new Error(`Mixpanel export failed ${lastError}`)
    }

    const text = await resp.text()
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const records: MixpanelEventRecord[] = []
    for (const line of lines) {
      const parsed = parseEventLine(line)
      if (parsed) records.push(parsed)
    }
    return records
  }

  throw new Error(
    `Mixpanel export auth failed. attempted=${authCandidates.map((c) => c.method).join(',')} last=${lastError || 'unknown'}`
  )
}

const toCanonicalEventName = (row: MixpanelEventRecord) => {
  if (CANONICAL_EVENTS.includes(row.event)) return row.event
  if (
    row.event === 'prediction_submitted' ||
    row.event === 'notification_prediction_submitted'
  ) {
    return 'question_answered'
  }
  if (row.event === 'notification_viewed') return 'question_opened'
  if (row.event === 'notification_displayed') return 'question_sent'
  if (row.event === 'question_cancelled' || row.event === 'question_closed') {
    return 'question_resolved'
  }
  return row.event
}

const withCanonicalShape = (
  row: MixpanelEventRecord
): MixpanelEventRecord & { canonicalEvent: string } => {
  const canonicalEvent = toCanonicalEventName(row)
  const properties = row.properties
  if (!asString(properties, ['question_type'])) {
    const inferred =
      asString(properties, ['engine_tag', 'engineTag', 'type']) || 'UNKNOWN'
    properties.question_type = inferred.toUpperCase()
  }
  if (!asString(properties, ['trigger_type'])) {
    const triggerRaw = asString(properties, ['trigger']) || 'legacy'
    properties.trigger_type = triggerRaw.split(':')[0].toLowerCase()
  }
  if (
    !asString(properties, ['resolution_type']) &&
    canonicalEvent === 'question_resolved'
  ) {
    properties.resolution_type =
      row.event === 'question_cancelled' ? 'void' : 'normal'
  }
  return { ...row, canonicalEvent }
}

const buildBreakdown = (
  events: (MixpanelEventRecord & { canonicalEvent: string })[],
  keyName: 'question_type' | 'trigger_type'
): BreakdownItem[] => {
  const buckets = new Map<
    string,
    {
      sent: number
      opened: number
      answered: number
      resolved: number
      voided: number
      times: number[]
    }
  >()

  const ensure = (key: string) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        sent: 0,
        opened: 0,
        answered: 0,
        resolved: 0,
        voided: 0,
        times: [],
      })
    }
    return buckets.get(key)!
  }

  for (const row of events) {
    const key =
      asString(row.properties, [keyName]) ||
      (row.event === 'question_created' ? 'unknown' : 'unknown')
    const bucket = ensure(key)

    if (row.canonicalEvent === 'question_sent') bucket.sent += 1
    if (row.canonicalEvent === 'question_opened') bucket.opened += 1
    if (row.canonicalEvent === 'question_answered') {
      bucket.answered += 1
      const tta = asNumber(row.properties, ['time_to_answer_ms'])
      if (tta !== null) bucket.times.push(tta)
    }
    if (row.canonicalEvent === 'question_resolved') {
      bucket.resolved += 1
      const resolutionType =
        asString(row.properties, ['resolution_type']) || 'normal'
      if (resolutionType === 'void') bucket.voided += 1
    }
  }

  return [...buckets.entries()]
    .map(([key, data]) => ({
      key,
      sent: data.sent,
      opened: data.opened,
      answered: data.answered,
      resolved: data.resolved,
      voided: data.voided,
      send_to_answer_rate: ratio(data.answered, data.sent),
      open_rate: ratio(data.opened, data.sent),
      void_rate: ratio(data.voided, data.resolved),
      median_time_to_answer_ms: median(data.times),
    }))
    .sort((a, b) => b.sent - a.sent)
}

const buildSummary = (
  events: (MixpanelEventRecord & { canonicalEvent: string })[],
  rangeDays: number,
  fromDate: string,
  toDate: string
): SummaryResponse => {
  let sent = 0
  let opened = 0
  let answered = 0
  let resolved = 0
  const answerTimes: number[] = []

  const sentByLatency = new Map<string, number>()
  const answeredByLatency = new Map<string, number>()
  const answerTimesByLatency = new Map<string, number[]>()

  const answerCountsByUserGame = new Map<string, number>()
  const gamesByUser = new Map<string, Set<string>>()

  for (const row of events) {
    if (row.canonicalEvent === 'question_sent') {
      sent += 1
      const bucket =
        asString(row.properties, ['latency_bucket']) ||
        toLatencyBucket(
          asNumber(row.properties, ['push_delivery_latency_ms'])
        ) ||
        'unknown'
      sentByLatency.set(bucket, (sentByLatency.get(bucket) || 0) + 1)
    }

    if (row.canonicalEvent === 'question_opened') {
      opened += 1
    }

    if (row.canonicalEvent === 'question_answered') {
      answered += 1
      const tta = asNumber(row.properties, ['time_to_answer_ms'])
      if (tta !== null) answerTimes.push(tta)
      const latencyBucket =
        asString(row.properties, ['latency_bucket']) ||
        toLatencyBucket(asNumber(row.properties, ['latency_at_answer_ms'])) ||
        'unknown'
      answeredByLatency.set(
        latencyBucket,
        (answeredByLatency.get(latencyBucket) || 0) + 1
      )
      if (tta !== null) {
        const list = answerTimesByLatency.get(latencyBucket) || []
        list.push(tta)
        answerTimesByLatency.set(latencyBucket, list)
      }

      const userId =
        asString(row.properties, ['user_id']) ||
        asString(row.properties, ['distinct_id']) ||
        'unknown'
      const gameId = asString(row.properties, ['game_id']) || 'unknown'
      const userGameKey = `${userId}:${gameId}`
      answerCountsByUserGame.set(
        userGameKey,
        (answerCountsByUserGame.get(userGameKey) || 0) + 1
      )
      if (!gamesByUser.has(userId)) gamesByUser.set(userId, new Set())
      gamesByUser.get(userId)!.add(gameId)
    }

    if (row.canonicalEvent === 'question_resolved') {
      resolved += 1
    }
  }

  const byLatencyBuckets = [
    '0-5s',
    '5-10s',
    '10-20s',
    '20-40s',
    '40s+',
    'unknown',
  ].map((bucket) => {
    const bucketSent = sentByLatency.get(bucket) || 0
    const bucketAnswered = answeredByLatency.get(bucket) || 0
    const bucketTimes = answerTimesByLatency.get(bucket) || []
    return {
      latency_bucket: bucket,
      sent: bucketSent,
      answered: bucketAnswered,
      send_to_answer_rate: ratio(bucketAnswered, bucketSent),
      median_time_to_answer_ms: median(bucketTimes),
    }
  })

  const userGameCounts = [...answerCountsByUserGame.values()]
  const avgAnswersPerUserPerGame = userGameCounts.length
    ? userGameCounts.reduce((sum, value) => sum + value, 0) /
      userGameCounts.length
    : null
  const pctFivePlus = userGameCounts.length
    ? userGameCounts.filter((count) => count >= 5).length /
      userGameCounts.length
    : null
  const usersWithTwoPlusGames = [...gamesByUser.values()].filter(
    (games) => games.size >= 2
  ).length

  return {
    range_days: rangeDays,
    from_date: fromDate,
    to_date: toDate,
    generated_at: new Date().toISOString(),
    totals: {
      question_sent: sent,
      question_opened: opened,
      question_answered: answered,
      question_resolved: resolved,
      send_to_open_rate: ratio(opened, sent),
      send_to_answer_rate: ratio(answered, sent),
      median_time_to_answer_ms: median(answerTimes),
      avg_answers_per_user_per_game: avgAnswersPerUserPerGame,
      pct_user_games_with_5_plus_answers: pctFivePlus,
      users_with_2_plus_games_7d:
        rangeDays === 7 ? usersWithTwoPlusGames : null,
    },
    by_question_type: buildBreakdown(events, 'question_type'),
    by_trigger_type: buildBreakdown(events, 'trigger_type'),
    by_latency_bucket: byLatencyBuckets,
  }
}

router.use(authMiddleware)
router.use(isAdminMiddleware)

router.get('/summary', async (req, res) => {
  const rangeDays = parseRangeDays(
    typeof req.query.range === 'string' ? req.query.range : undefined
  )
  const cacheKey = `summary:${rangeDays}`
  const now = Date.now()
  const cached = cachedSummaries.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return res.json({ ...cached.payload, cache: 'hit' })
  }

  try {
    const toDate = new Date()
    const fromDate = new Date()
    fromDate.setDate(toDate.getDate() - rangeDays + 1)

    const fromDateKey = toDateKey(fromDate)
    const toDateKeyValue = toDateKey(toDate)
    const events = await fetchCanonicalEvents(fromDateKey, toDateKeyValue)
    const canonicalRows = events.map(withCanonicalShape)
    const payload = buildSummary(
      canonicalRows,
      rangeDays,
      fromDateKey,
      toDateKeyValue
    )
    cachedSummaries.set(cacheKey, {
      payload,
      expiresAt: now + CACHE_TTL_MS,
    })
    return res.json({ ...payload, cache: 'miss' })
  } catch (error) {
    console.error('[analytics] mixpanel summary error', error)
    return res.status(500).json({
      error: 'Failed to fetch Mixpanel summary',
      detail: String(error),
    })
  }
})

export default router
