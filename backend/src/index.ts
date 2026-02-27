import * as Sentry from '@sentry/node'
import cors from 'cors'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { syncNbaLiveEvents, syncNbaSchedule } from './lib/nba'
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

const NBA_SCHEDULE_DAYS_AHEAD = Number(process.env.NBA_SCHEDULE_DAYS_AHEAD ?? 7)
const NBA_SCHEDULE_POLL_MS = Number(
  process.env.NBA_SCHEDULE_POLL_MS ?? 3_600_000
)
const NBA_LIVE_POLL_MS = Number(process.env.NBA_LIVE_POLL_MS ?? 1000)

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
  setInterval(run, 60_000)
}

startPlayerCountWorker()

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
  setInterval(run, 60_000)
}

startScheduledGamesWorker()

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

startNbaScheduleWorker()

// Background worker: sync NBA live events for open games
const startNbaLiveFeedWorker = () => {
  console.log('[worker] NBA live feed worker started')
  let stopped = false
  const run = async () => {
    const startedAt = Date.now()
    try {
      const stats = await syncNbaLiveEvents()
      const durationMs = Date.now() - startedAt
      if (stats.actionsProcessed > 0) {
        console.log(
          `[worker] NBA live feed summary durationMs=${durationMs} openGames=${stats.openGames} updatedGames=${stats.updatedGames} actionsProcessed=${stats.actionsProcessed} commitRetries=${stats.commitRetries}`
        )
      }
    } catch (err) {
      console.error('[worker] NBA live feed error', err)
      Sentry.captureException(err)
    } finally {
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > NBA_LIVE_POLL_MS) {
        console.log(
          `[worker] NBA live feed cycle slow elapsedMs=${elapsedMs} pollMs=${NBA_LIVE_POLL_MS}`
        )
      }
    }
  }

  const loop = async () => {
    while (!stopped) {
      await run()
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), NBA_LIVE_POLL_MS)
      })
    }
  }

  void loop()

  return () => {
    stopped = true
  }
}

startNbaLiveFeedWorker()

// Background worker: refresh NBA season profiles every 24h
const startSeasonProfilesCacheWorker = () => {
  console.log('[worker] NBA season profiles worker started')
  startSeasonProfilesWorker().catch((err) => {
    console.error('[worker] season profiles error', err)
    Sentry.captureException(err)
  })
}

startSeasonProfilesCacheWorker()

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
  setInterval(run, 1_000)
}

closeExpiredQuestionsWorker()
