import { Router } from 'express'
import * as Sentry from '@sentry/node'
import { optionalAuthMiddleware } from '../middleware/optionalAuth'

const router = Router()

// POST /api/log/error
// Accepts: { message: string, context?: any }
// Adds user to scope if bearer token is valid; otherwise still logs without user.
router.post('/error', optionalAuthMiddleware, async (req, res) => {
  const { message, context } = req.body || {}
  const err = new Error(message || 'Logged error from client')
  Sentry.captureException(err, (scope) => {
    scope.setContext('client_error', context || {})
    if (req.user?.uid) {
      scope.setUser({ id: req.user.uid, email: req.user.email || undefined })
    }
    return scope
  })
  return res.json({ ok: true })
})

export default router
