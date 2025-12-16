import * as Sentry from '@sentry/node'
import cors from 'cors'
import express from 'express'
import authRouter from './routes/auth'
import gameRouter, {
  closeExpiredQuestions,
  startScheduledGames,
  updatePlayerCountsForActiveGames,
} from './routes/game'
import logsRouter from './routes/logs'

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
  console.log(`[request] ${req.method} ${req.path}`)
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/api/games', gameRouter)
app.use('/api', authRouter)
app.use('/api/log', logsRouter)
app.use(Sentry.Handlers.errorHandler())

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`[backend] Domain: ${process.env.DOMAIN}`)
  if (process.env.SENTRY_DSN) console.log('[backend] Sentry initialized')
})

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
