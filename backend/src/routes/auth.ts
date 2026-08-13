import { createHmac } from 'crypto'
import { Router } from 'express'
import { admin, db } from '../firebase'
import { trackEvent } from '../lib/mixpanel'
import { authMiddleware } from '../middleware/auth'

const router = Router()

type AccountGameDocument = {
  state?: string
  playerCount?: number
  playerCountByPlatform?: Partial<
    Record<'ios' | 'android' | 'web' | 'unknown', number>
  >
}

type AccountMemberDocument = {
  platform?: string
}

type AccountUserDocument = {
  username?: string
}

const accountCount = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0

const accountPlatform = (
  value: string | undefined
): 'ios' | 'android' | 'web' | 'unknown' =>
  value === 'ios' || value === 'android' || value === 'web' ? value : 'unknown'

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

router.delete('/account', authMiddleware, async (req, res) => {
  const userId = req.user?.uid
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const userRef = db.collection('users').doc(userId)
    const [userSnap, userGamesSnap] = await Promise.all([
      userRef.get(),
      userRef.collection('games').get(),
    ])
    const user = userSnap.data() as AccountUserDocument | undefined

    for (const userGameSnap of userGamesSnap.docs) {
      const gameRef = db.collection('games').doc(userGameSnap.id)
      const memberRef = gameRef.collection('users').doc(userId)
      await db.runTransaction(async (transaction) => {
        const [gameSnap, memberSnap] = await Promise.all([
          transaction.get(gameRef),
          transaction.get(memberRef),
        ])
        if (!memberSnap.exists) return
        transaction.delete(memberRef)
        if (!gameSnap.exists) return
        const game = gameSnap.data() as AccountGameDocument
        if (game.state !== 'scheduled' && game.state !== 'open') return
        const member = memberSnap.data() as AccountMemberDocument
        const platform = accountPlatform(member.platform)
        const counts = game.playerCountByPlatform ?? {}
        transaction.set(
          gameRef,
          {
            playerCount: Math.max(0, accountCount(game.playerCount) - 1),
            playerCountByPlatform: {
              ios: Math.max(
                0,
                accountCount(counts.ios) - (platform === 'ios' ? 1 : 0)
              ),
              android: Math.max(
                0,
                accountCount(counts.android) - (platform === 'android' ? 1 : 0)
              ),
              web: Math.max(
                0,
                accountCount(counts.web) - (platform === 'web' ? 1 : 0)
              ),
              unknown: Math.max(
                0,
                accountCount(counts.unknown) - (platform === 'unknown' ? 1 : 0)
              ),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      })
    }

    if (user?.username) {
      await db.collection('usernames').doc(user.username.toLowerCase()).delete()
    }
    await db.recursiveDelete(userRef)
    await admin.auth().deleteUser(userId)
    console.log(
      `[account/delete] user=${userId} games=${userGamesSnap.size} result=deleted`
    )
    return res.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[account/delete] user=${userId} error=${message}`)
    return res.status(500).json({ error: 'Unable to delete account' })
  }
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
