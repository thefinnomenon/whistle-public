import * as Sentry from '@sentry/node'
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { syncNbaLiveEvents, syncNbaSchedule } from './lib/nba'
import { syncNflLiveEvents, syncNflSchedule } from './lib/nfl'
import authRouter from './routes/auth'
import analyticsRouter from './routes/analytics'
import feedbackRouter from './routes/feedback'
import gameRouter, {
  closeExpiredQuestions,
  startScheduledGames,
  updatePlayerCountsForActiveGames,
} from './routes/game'
import logsRouter from './routes/logs'
import testersRouter from './routes/testers'
import { startSeasonProfilesWorker } from './workers/seasonProfilesWorker'
import { startUserCreatedSlackWorker } from './workers/userCreatedSlackWorker'

const LOG_BLACKLIST = ['/health', '/api/log']

Sentry.init({
  enabled: process.env.NODE_ENV === 'production',
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
})

const app = express()
app.use(Sentry.Handlers.requestHandler())
app.use(Sentry.Handlers.tracingHandler())
app.use(cors())
app.use(express.json())

// Simple request logger
app.use((req, _res, next) => {
  const isBlacklisted = LOG_BLACKLIST.some(
    (p) => req.path === p || req.path.startsWith(`${p}/`)
  )

  if (!isBlacklisted) console.log(`[request] ${req.method} ${req.path}`)

  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))
const resolveStaticHtml = (filename: string) => {
  const distPath = path.join(__dirname, 'static', filename)
  if (fs.existsSync(distPath)) return distPath
  return path.join(process.cwd(), 'src', 'static', filename)
}
const resolveStaticDir = () => {
  const distPath = path.join(__dirname, 'static')
  if (fs.existsSync(distPath)) return distPath
  return path.join(process.cwd(), 'src', 'static')
}

app.use('/static', express.static(resolveStaticDir()))
app.get('/', (_req, res) => res.sendFile(resolveStaticHtml('index.html')))
app.get('/privacy', (_req, res) =>
  res.sendFile(resolveStaticHtml('privacy.html'))
)
app.get('/support', (_req, res) =>
  res.sendFile(resolveStaticHtml('support.html'))
)
app.get('/testers', (_req, res) =>
  res.sendFile(resolveStaticHtml('testers.html'))
)

app.use('/api/games', gameRouter)
app.use('/api', authRouter)
app.use('/api/feedback', feedbackRouter)
app.use('/api/log', logsRouter)
app.use('/api/testers', testersRouter)
app.use('/api/admin/mixpanel', analyticsRouter)
app.use(Sentry.Handlers.errorHandler())

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`[backend] Domain: ${process.env.DOMAIN}`)
  if (process.env.SENTRY_DSN && process.env.NODE_ENV === 'production')
    console.log('[sentry] Initialized')
})

const parseBooleanEnv = (
  name: string,
  rawValue: string | undefined,
  fallback: boolean
): boolean => {
  if (!rawValue) return fallback

  const value = rawValue.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false

  console.warn(
    `[config] invalid_bool env=${name} value=${rawValue} fallback=${fallback ? '1' : '0'}`
  )
  return fallback
}

const parsePositiveNumberEnv = (
  name: string,
  rawValue: string | undefined,
  fallback: number,
  minimum: number
): number => {
  if (!rawValue) return fallback

  const value = Number(rawValue)
  if (Number.isFinite(value) && value >= minimum) return value

  console.warn(
    `[config] invalid_number env=${name} value=${rawValue} fallback=${fallback}`
  )
  return fallback
}

const BACKGROUND_WORKERS_FORCE_DISABLED = parseBooleanEnv(
  'DISABLE_BACKGROUND_WORKERS',
  process.env.DISABLE_BACKGROUND_WORKERS,
  process.env.NODE_ENV === 'production'
)
const BACKGROUND_WORKERS_ENABLED =
  parseBooleanEnv(
    'RUN_BACKGROUND_WORKERS',
    process.env.RUN_BACKGROUND_WORKERS,
    // Production web instances default to API-only so App Engine autoscaling does
    // not duplicate Firestore polling loops on every instance.
    process.env.NODE_ENV !== 'production'
  ) && !BACKGROUND_WORKERS_FORCE_DISABLED
const RUN_PLAYER_COUNT_WORKER = parseBooleanEnv(
  'RUN_PLAYER_COUNT_WORKER',
  process.env.RUN_PLAYER_COUNT_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_SCHEDULED_GAMES_WORKER = parseBooleanEnv(
  'RUN_SCHEDULED_GAMES_WORKER',
  process.env.RUN_SCHEDULED_GAMES_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_NBA_SCHEDULE_WORKER = parseBooleanEnv(
  'RUN_NBA_SCHEDULE_WORKER',
  process.env.RUN_NBA_SCHEDULE_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_NBA_LIVE_WORKER = parseBooleanEnv(
  'RUN_NBA_LIVE_WORKER',
  process.env.RUN_NBA_LIVE_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_NFL_SCHEDULE_WORKER = parseBooleanEnv(
  'RUN_NFL_SCHEDULE_WORKER',
  process.env.RUN_NFL_SCHEDULE_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_NFL_LIVE_WORKER = parseBooleanEnv(
  'RUN_NFL_LIVE_WORKER',
  process.env.RUN_NFL_LIVE_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_SEASON_PROFILES_WORKER = parseBooleanEnv(
  'RUN_SEASON_PROFILES_WORKER',
  process.env.RUN_SEASON_PROFILES_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_USER_CREATED_SLACK_WORKER = parseBooleanEnv(
  'RUN_USER_CREATED_SLACK_WORKER',
  process.env.RUN_USER_CREATED_SLACK_WORKER,
  BACKGROUND_WORKERS_ENABLED
)
const RUN_CLOSE_EXPIRED_QUESTIONS_WORKER = parseBooleanEnv(
  'RUN_CLOSE_EXPIRED_QUESTIONS_WORKER',
  process.env.RUN_CLOSE_EXPIRED_QUESTIONS_WORKER,
  BACKGROUND_WORKERS_ENABLED
)

const NBA_SCHEDULE_DAYS_AHEAD = parsePositiveNumberEnv(
  'NBA_SCHEDULE_DAYS_AHEAD',
  process.env.NBA_SCHEDULE_DAYS_AHEAD,
  7,
  0
)
const NBA_SCHEDULE_POLL_MS = parsePositiveNumberEnv(
  'NBA_SCHEDULE_POLL_MS',
  process.env.NBA_SCHEDULE_POLL_MS,
  3_600_000,
  60_000
)
const NBA_LIVE_POLL_MS = parsePositiveNumberEnv(
  'NBA_LIVE_POLL_MS',
  process.env.NBA_LIVE_POLL_MS,
  1_000,
  1_000
)
const NBA_LIVE_IDLE_POLL_MS = parsePositiveNumberEnv(
  'NBA_LIVE_IDLE_POLL_MS',
  process.env.NBA_LIVE_IDLE_POLL_MS,
  1_000,
  NBA_LIVE_POLL_MS
)
const NFL_SCHEDULE_DAYS_AHEAD = parsePositiveNumberEnv(
  'NFL_SCHEDULE_DAYS_AHEAD',
  process.env.NFL_SCHEDULE_DAYS_AHEAD,
  14,
  0
)
const NFL_SCHEDULE_POLL_MS = parsePositiveNumberEnv(
  'NFL_SCHEDULE_POLL_MS',
  process.env.NFL_SCHEDULE_POLL_MS,
  3_600_000,
  60_000
)
const NFL_LIVE_POLL_MS = parsePositiveNumberEnv(
  'NFL_LIVE_POLL_MS',
  process.env.NFL_LIVE_POLL_MS,
  1_000,
  1_000
)
const NFL_LIVE_IDLE_POLL_MS = parsePositiveNumberEnv(
  'NFL_LIVE_IDLE_POLL_MS',
  process.env.NFL_LIVE_IDLE_POLL_MS,
  5_000,
  NFL_LIVE_POLL_MS
)
const PLAYER_COUNT_POLL_MS = parsePositiveNumberEnv(
  'PLAYER_COUNT_POLL_MS',
  process.env.PLAYER_COUNT_POLL_MS,
  60_000,
  10_000
)
const START_SCHEDULED_GAMES_POLL_MS = parsePositiveNumberEnv(
  'START_SCHEDULED_GAMES_POLL_MS',
  process.env.START_SCHEDULED_GAMES_POLL_MS,
  60_000,
  10_000
)
const CLOSE_EXPIRED_QUESTIONS_POLL_MS = parsePositiveNumberEnv(
  'CLOSE_EXPIRED_QUESTIONS_POLL_MS',
  process.env.CLOSE_EXPIRED_QUESTIONS_POLL_MS,
  5_000,
  1_000
)

const startWorkerIfEnabled = (
  name: string,
  envName: string,
  enabled: boolean,
  start: () => void
) => {
  if (BACKGROUND_WORKERS_FORCE_DISABLED) {
    console.log(
      `[worker] skipped name=${name} reason=force_disabled env=DISABLE_BACKGROUND_WORKERS`
    )
    return
  }

  if (!enabled) {
    console.log(`[worker] skipped name=${name} reason=disabled env=${envName}`)
    return
  }

  start()
}

// Background worker: update player counts for active games every minute
const startPlayerCountWorker = () => {
  console.log('[worker] Update player counts for active games worker started')
  const run = async () => {
    try {
      await updatePlayerCountsForActiveGames()
    } catch (err) {
      console.error('[worker] update player counts error', err)
      Sentry.captureException(err)
    }
  }

  // run immediately, then every minute
  run()
  setInterval(run, PLAYER_COUNT_POLL_MS)
}

// Background worker: start scheduled games every minute
const startScheduledGamesWorker = () => {
  console.log('[worker] Start scheduled games worker started')
  const run = async () => {
    try {
      await startScheduledGames()
    } catch (err) {
      console.error('[worker] start scheduled games error', err)
      Sentry.captureException(err)
    }
  }
  run()
  setInterval(run, START_SCHEDULED_GAMES_POLL_MS)
}

// Background worker: sync NBA schedule every hour
const startNbaScheduleWorker = () => {
  console.log('[worker] NBA schedule sync worker started')
  const run = async () => {
    try {
      const { processed, created } = await syncNbaSchedule(
        NBA_SCHEDULE_DAYS_AHEAD
      )
      console.log(
        `[worker] NBA schedule sync complete. games processed=${processed} created=${created}`
      )
    } catch (err) {
      console.error('[worker] NBA schedule sync error', err)
      Sentry.captureException(err)
    }
  }
  run()
  setInterval(run, NBA_SCHEDULE_POLL_MS)
}

// Background worker: sync NBA live events for open games
const startNbaLiveFeedWorker = () => {
  console.log('[worker] NBA live feed worker started')
  let stopped = false
  let nextPollMs = NBA_LIVE_IDLE_POLL_MS
  const run = async () => {
    const startedAt = Date.now()
    try {
      const stats = await syncNbaLiveEvents()
      nextPollMs =
        stats.openGames > 0 ? NBA_LIVE_POLL_MS : NBA_LIVE_IDLE_POLL_MS
      const durationMs = Date.now() - startedAt
      if (stats.actionsProcessed > 0) {
        console.log(
          `[worker] NBA live feed summary durationMs=${durationMs} openGames=${stats.openGames} updatedGames=${stats.updatedGames} actionsProcessed=${stats.actionsProcessed} commitRetries=${stats.commitRetries}`
        )
      }
    } catch (err) {
      console.error('[worker] NBA live feed error', err)
      Sentry.captureException(err)
    }
  }

  const loop = async () => {
    while (!stopped) {
      await run()
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), nextPollMs)
      })
    }
  }

  void loop()

  return () => {
    stopped = true
  }
}

// Background worker: sync the upcoming NFL schedule every hour
const startNflScheduleWorker = () => {
  console.log('[worker] NFL schedule sync worker started')
  const run = async () => {
    try {
      const { processed, created, updated, unchanged } = await syncNflSchedule(
        NFL_SCHEDULE_DAYS_AHEAD
      )
      console.log(
        `[worker] NFL schedule sync complete gamesProcessed=${processed} gamesCreated=${created} gamesUpdated=${updated} gamesUnchanged=${unchanged}`
      )
    } catch (err) {
      console.error('[worker] NFL schedule sync error', err)
      Sentry.captureException(err)
    }
  }
  void run()
  setInterval(run, NFL_SCHEDULE_POLL_MS)
}

// Background worker: sync ESPN play-by-play for open NFL games
const startNflLiveFeedWorker = () => {
  console.log('[worker] NFL live feed worker started')
  let stopped = false
  let nextPollMs = NFL_LIVE_IDLE_POLL_MS
  const run = async () => {
    const startedAt = Date.now()
    try {
      const stats = await syncNflLiveEvents()
      nextPollMs =
        stats.openGames > 0 ? NFL_LIVE_POLL_MS : NFL_LIVE_IDLE_POLL_MS
      if (
        stats.playsCreated > 0 ||
        stats.playsRevised > 0 ||
        stats.errors > 0
      ) {
        console.log(
          `[worker] NFL live feed summary durationMs=${Date.now() - startedAt} openGames=${stats.openGames} updatedGames=${stats.updatedGames} playsCreated=${stats.playsCreated} playsRevised=${stats.playsRevised} errors=${stats.errors}`
        )
      }
    } catch (err) {
      console.error('[worker] NFL live feed error', err)
      Sentry.captureException(err)
    }
  }

  const loop = async () => {
    while (!stopped) {
      await run()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, nextPollMs)
      })
    }
  }
  void loop()

  return () => {
    stopped = true
  }
}

// Background worker: refresh NBA season profiles every 24h
const startSeasonProfilesCacheWorker = () => {
  console.log('[worker] NBA season profiles worker started')
  startSeasonProfilesWorker().catch((err) => {
    console.error('[worker] season profiles error', err)
    Sentry.captureException(err)
  })
}

// Background worker: close expired questions every second (small batch)
const closeExpiredQuestionsWorker = () => {
  console.log('[worker] Close expired questions worker started')
  const run = async () => {
    try {
      const closed = await closeExpiredQuestions()
      if (closed > 0) {
        console.log(
          `[worker] closed expired questions: ${closed} (batch up to 200)`
        )
      }
    } catch (err) {
      console.error('[worker] close expired questions error', err)
      Sentry.captureException(err)
    }
  }
  run()
  setInterval(run, CLOSE_EXPIRED_QUESTIONS_POLL_MS)
}

startWorkerIfEnabled(
  'player-count',
  'RUN_PLAYER_COUNT_WORKER',
  RUN_PLAYER_COUNT_WORKER,
  startPlayerCountWorker
)
startWorkerIfEnabled(
  'scheduled-games',
  'RUN_SCHEDULED_GAMES_WORKER',
  RUN_SCHEDULED_GAMES_WORKER,
  startScheduledGamesWorker
)
startWorkerIfEnabled(
  'nba-schedule',
  'RUN_NBA_SCHEDULE_WORKER',
  RUN_NBA_SCHEDULE_WORKER,
  startNbaScheduleWorker
)
startWorkerIfEnabled(
  'nba-live-feed',
  'RUN_NBA_LIVE_WORKER',
  RUN_NBA_LIVE_WORKER,
  startNbaLiveFeedWorker
)
startWorkerIfEnabled(
  'nfl-schedule',
  'RUN_NFL_SCHEDULE_WORKER',
  RUN_NFL_SCHEDULE_WORKER,
  startNflScheduleWorker
)
startWorkerIfEnabled(
  'nfl-live-feed',
  'RUN_NFL_LIVE_WORKER',
  RUN_NFL_LIVE_WORKER,
  startNflLiveFeedWorker
)
startWorkerIfEnabled(
  'season-profiles',
  'RUN_SEASON_PROFILES_WORKER',
  RUN_SEASON_PROFILES_WORKER,
  startSeasonProfilesCacheWorker
)
startWorkerIfEnabled(
  'user-created-slack',
  'RUN_USER_CREATED_SLACK_WORKER',
  RUN_USER_CREATED_SLACK_WORKER,
  startUserCreatedSlackWorker
)
startWorkerIfEnabled(
  'close-expired-questions',
  'RUN_CLOSE_EXPIRED_QUESTIONS_WORKER',
  RUN_CLOSE_EXPIRED_QUESTIONS_WORKER,
  closeExpiredQuestionsWorker
)
