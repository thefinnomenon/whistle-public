import { createHmac } from 'crypto'
import { Router } from 'express'
import { trackEvent } from '../lib/mixpanel'
import { authMiddleware } from '../middleware/auth'

const router = Router()

router.get('/me', authMiddleware, async (req, res) => {
  console.log('[auth/me] user', req.user?.uid)

  trackEvent(
    'auth_me',
    {
      userId: req.user?.uid,
      hasEmail: !!req.user?.email,
    },
    req.user?.uid
  )

  return res.json({ uid: req.user?.uid, email: req.user?.email || null })
})

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60

const base64url = (input: Buffer | string) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

router.post('/issue-token', authMiddleware, async (req, res) => {
  const secret = process.env.WHISTLE_JWT_SECRET
  if (!secret) {
    return res.status(500).json({ error: 'Missing WHISTLE_JWT_SECRET' })
  }

  const uid = req.user?.uid
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    console.log('[auth/issue-token] issuing for', uid)
    const header = { alg: 'HS256', typ: 'JWT' }
    const exp = Math.floor(Date.now() / 1000) + THIRTY_DAYS_SECONDS
    const payload = { uid, exp }

    const encodedHeader = base64url(JSON.stringify(header))
    const encodedPayload = base64url(JSON.stringify(payload))
    const data = `${encodedHeader}.${encodedPayload}`
    const signature = createHmac('sha256', secret)
      .update(data)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const token = `${data}.${signature}`

    trackEvent(
      'token_issued',
      {
        userId: uid,
        expiresAt: exp,
      },
      uid
    )

    return res.json({ token, expiresAt: exp })
  } catch (err) {
    console.error('[issue-token] error', err)

    trackEvent(
      'token_issue_error',
      {
        userId: uid,
        error: String(err),
      },
      uid
    )

    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

export default router
