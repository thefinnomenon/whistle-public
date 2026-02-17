import * as Sentry from '@sentry/node'
import { Router } from 'express'
import { trackEvent } from '../lib/mixpanel'
import { optionalAuthMiddleware } from '../middleware/optionalAuth'

const router = Router()
const CLIENT_EVENT_SCHEMA_VERSION = 1
const MAX_EVENT_NAME_LENGTH = 64

const ALLOWED_CLIENT_EVENT_PREFIXES = ['notification_', 'question_'] as const

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

type ClientEventBody = {
  eventName?: string
  properties?: JsonObject
  schemaVersion?: number | string
}

const parseSchemaVersion = (value: number | string | undefined) => {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

const isAllowedClientEventName = (eventName: string) =>
  ALLOWED_CLIENT_EVENT_PREFIXES.some((prefix) => eventName.startsWith(prefix))

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
  const { eventName, properties, schemaVersion } = (req.body ||
    {}) as ClientEventBody
  const trimmedEventName = typeof eventName === 'string' ? eventName.trim() : ''
  const parsedSchemaVersion = parseSchemaVersion(schemaVersion)
  const effectiveSchemaVersion =
    schemaVersion === undefined ? 1 : parsedSchemaVersion

  if (!trimmedEventName) {
    return res.status(400).json({ error: 'eventName is required' })
  }
  if (trimmedEventName.length > MAX_EVENT_NAME_LENGTH) {
    return res.status(400).json({ error: 'eventName is too long' })
  }
  if (!isAllowedClientEventName(trimmedEventName)) {
    return res.status(400).json({ error: 'eventName is not allowed' })
  }
  if (effectiveSchemaVersion === undefined || effectiveSchemaVersion < 1) {
    return res.status(400).json({ error: 'schemaVersion is invalid' })
  }

  trackEvent(
    trimmedEventName,
    {
      ...properties,
      user_id: req.user?.uid,
      client_event_schema_version: effectiveSchemaVersion,
      server_event_schema_version: CLIENT_EVENT_SCHEMA_VERSION,
      source: 'client_event_ingest',
    },
    req.user?.uid
  )

  return res.json({ ok: true, schemaVersion: CLIENT_EVENT_SCHEMA_VERSION })
})

export default router
