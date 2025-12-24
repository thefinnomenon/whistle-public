import * as Sentry from '@sentry/node'
import { Router } from 'express'
import { trackEvent } from '../lib/mixpanel'
import { optionalAuthMiddleware } from '../middleware/optionalAuth'

const router = Router()

// POST /api/log/error
// Accepts: { message: string, context?: any }
// Adds user to scope if bearer token is valid; otherwise still logs without user.
router.post('/error', optionalAuthMiddleware, async (req, res) => {
  const { message, context } = req.body || {}
  console.log('[client error]', message, context)
  const err = new Error(message || 'Logged error from client')
  Sentry.captureException(err, (scope) => {
    scope.setContext('client_error', context || {})
    if (req.user?.uid) {
      scope.setUser({ id: req.user.uid, email: req.user.email || undefined })
    }
    return scope
  })

  trackEvent(
    'client_error_logged',
    {
      userId: req.user?.uid,
      message,
      source: context?.source,
      hasUser: !!req.user?.uid,
    },
    req.user?.uid
  )

  return res.json({ ok: true })
})

// POST /api/log/event
// Accepts: { eventName: string, properties?: any }
// Logs events from notification content extension and other clients
router.post('/event', optionalAuthMiddleware, async (req, res) => {
  const { eventName, properties } = req.body || {}
  console.log('[client event]', req.body, eventName, properties)

  if (!eventName) {
    return res.status(400).json({ error: 'eventName is required' })
  }

  trackEvent(
    eventName,
    {
      ...properties,
      userId: req.user?.uid,
    },
    req.user?.uid
  )

  return res.json({ ok: true })
})

export default router
