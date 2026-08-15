import { randomBytes } from 'crypto'
import { Router } from 'express'
import { admin, db } from '../firebase'
import {
  buildFeaturedJoinAnalytics,
  FeaturedAnnouncementTimes,
  FeaturedJoinRecord,
  FeaturedPoolAmount,
  getFeaturedPoolState,
  getFeaturedWeekKey,
  parseFeaturedPoolAmount,
} from '../lib/featuredGame'
import { trackEvent } from '../lib/mixpanel'
import { authMiddleware } from '../middleware/auth'
import { isAdminMiddleware } from '../middleware/isAdmin'

const router = Router()

type PlayerPlatform = 'ios' | 'android' | 'web' | 'unknown'

type JoinRequestBody = {
  platform?: string
  source?: string
  referralCode?: string
}

type FeaturedRequestBody = {
  featured?: boolean
}

type AnnouncementRequestBody = {
  amount?: number
}

type GameDocument = {
  state?: string
  homeTeam?: string
  awayTeam?: string
  startTime?: admin.firestore.Timestamp
  playerCount?: number
  playerCountByPlatform?: Partial<Record<PlayerPlatform, number>>
  prizeAmount?: number
  prizeAmountCents?: number
  prizeType?: 'USD' | 'POINTS'
  isFeatured?: boolean
  featuredWeekKey?: string
  featuredPoolAmount?: number
  featuredOriginalPrizeAmount?: number
  featuredOriginalPrizeAmountCents?: number
  featuredOriginalPrizeType?: 'USD' | 'POINTS'
  featuredPoolAnnouncements?: Partial<Record<string, admin.firestore.Timestamp>>
}

type JoinEventDocument = {
  firstJoinedAt?: admin.firestore.Timestamp
  firstSource?: string
  firstReferredByUserId?: string
  shareReferralCode?: string
}

type MemberDocument = {
  joinedAt?: admin.firestore.Timestamp
}

type JoinResult = {
  joined: boolean
  playerCount: number
  prizeAmount: number
  featuredPoolAmount: number | null
}

const sanitizeAttributionValue = (
  value: string | undefined,
  fallback: string
): string => {
  if (!value) return fallback
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return normalized || fallback
}

const normalizePlatform = (value: string | undefined): PlayerPlatform => {
  if (value === 'ios' || value === 'android' || value === 'web') return value
  return 'unknown'
}

const asFiniteCount = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0

const publicOrigin = (protocol: string, host: string | undefined): string => {
  const configured = process.env.DOMAIN?.trim().replace(/\/$/, '')
  if (configured) {
    return /^https?:\/\//i.test(configured)
      ? configured
      : `https://${configured}`
  }
  return `${protocol}://${host || 'localhost:4000'}`
}

const buildShareUrl = (
  origin: string,
  gameId: string,
  source: string,
  referralCode?: string
): string => {
  const params = new URLSearchParams({ source })
  if (referralCode) params.set('ref', referralCode)
  return `${origin}/join/${encodeURIComponent(gameId)}?${params.toString()}`
}

const buildPlayerShareText = (
  game: GameDocument,
  playerCount: number,
  poolAmount: number
): string => {
  const matchup = `${game.awayTeam || 'Away'} vs ${game.homeTeam || 'Home'}`
  const poolState = getFeaturedPoolState(playerCount, poolAmount)
  if (poolState.nextAmount === null) {
    return `${matchup} is Whistle's Featured Game. The prize pool is $${poolState.amount}. Join me now.`
  }
  return `${matchup} is Whistle's Featured Game with a $${poolState.amount} prize pool. ${poolState.playersNeeded} more players unlock $${poolState.nextAmount}. Join me now.`
}

const buildAnnouncementShareText = (
  game: GameDocument,
  amount: FeaturedPoolAmount
): string => {
  const matchup = `${game.awayTeam || 'Away'} vs ${game.homeTeam || 'Home'}`
  if (amount === 25) {
    return `${matchup} is Whistle's Featured Game. $25 guaranteed. The pool grows to $50 at 50 players and $100 at 100. Join now.`
  }
  if (amount === 50) {
    return `${matchup} just unlocked a $50 prize pool on Whistle. The pool grows to $100 at 100 players. Join now.`
  }
  return `${matchup} just unlocked a $100 prize pool on Whistle. Join now.`
}

const getTimestampMs = (
  value: admin.firestore.Timestamp | undefined
): number | null => value?.toMillis() ?? null

const unfeaturedGameUpdate = (game: GameDocument) => ({
  isFeatured: false,
  prizeAmount: game.featuredOriginalPrizeAmount ?? game.prizeAmount ?? 0,
  prizeAmountCents:
    game.featuredOriginalPrizeType === 'USD'
      ? (game.featuredOriginalPrizeAmountCents ??
        Math.round((game.featuredOriginalPrizeAmount ?? 0) * 100))
      : admin.firestore.FieldValue.delete(),
  prizeType: game.featuredOriginalPrizeType ?? game.prizeType ?? 'POINTS',
  featuredWeekKey: admin.firestore.FieldValue.delete(),
  featuredPoolAmount: admin.firestore.FieldValue.delete(),
  featuredOriginalPrizeAmount: admin.firestore.FieldValue.delete(),
  featuredOriginalPrizeAmountCents: admin.firestore.FieldValue.delete(),
  featuredOriginalPrizeType: admin.firestore.FieldValue.delete(),
  featuredPoolAnnouncements: admin.firestore.FieldValue.delete(),
  featuredPool50UnlockedAt: admin.firestore.FieldValue.delete(),
  featuredPool100UnlockedAt: admin.firestore.FieldValue.delete(),
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
})

router.post('/:gameId/join', authMiddleware, async (req, res) => {
  const userId = req.user?.uid
  const { gameId } = req.params
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const body = (req.body || {}) as JoinRequestBody
  const platform = normalizePlatform(body.platform)
  const source = sanitizeAttributionValue(body.source, 'direct')
  const referralCode = body.referralCode
    ? sanitizeAttributionValue(body.referralCode, '')
    : ''
  const gameRef = db.collection('games').doc(gameId)
  const memberRef = gameRef.collection('users').doc(userId)
  const userGameRef = db.doc(`users/${userId}/games/${gameId}`)
  const userRef = db.collection('users').doc(userId)
  const joinEventRef = gameRef.collection('joinEvents').doc(userId)
  const referralRef = referralCode
    ? gameRef.collection('referralCodes').doc(referralCode)
    : null

  try {
    const result = await db.runTransaction<JoinResult>(async (transaction) => {
      const [gameSnap, memberSnap, userSnap, joinEventSnap, referralSnap] =
        await Promise.all([
          transaction.get(gameRef),
          transaction.get(memberRef),
          transaction.get(userRef),
          transaction.get(joinEventRef),
          referralRef ? transaction.get(referralRef) : Promise.resolve(null),
        ])

      if (!gameSnap.exists) throw new Error('GAME_NOT_FOUND')
      if (!userSnap.exists) throw new Error('USER_NOT_FOUND')
      const game = gameSnap.data() as GameDocument
      if (game.state === 'resolved' || game.state === 'cancelled') {
        throw new Error('GAME_CLOSED')
      }
      const username = userSnap.data()?.username
      if (typeof username !== 'string' || !username.trim()) {
        throw new Error('USERNAME_REQUIRED')
      }

      const playerCount = asFiniteCount(game.playerCount)
      const featuredPoolAmount = game.isFeatured
        ? getFeaturedPoolState(
            playerCount,
            game.featuredPoolAmount ?? game.prizeAmount ?? 25
          ).amount
        : null

      if (memberSnap.exists) {
        return {
          joined: false,
          playerCount,
          prizeAmount: game.prizeAmount ?? 0,
          featuredPoolAmount,
        }
      }

      const nextPlayerCount = playerCount + 1
      const previousPlatformCounts = game.playerCountByPlatform ?? {}
      const nextPlatformCounts = {
        ios: asFiniteCount(previousPlatformCounts.ios),
        android: asFiniteCount(previousPlatformCounts.android),
        web: asFiniteCount(previousPlatformCounts.web),
        unknown: asFiniteCount(previousPlatformCounts.unknown),
      }
      nextPlatformCounts[platform] += 1

      const referralOwner = referralSnap?.data()?.userId
      const referredByUserId =
        typeof referralOwner === 'string' && referralOwner !== userId
          ? referralOwner
          : null
      const now = admin.firestore.FieldValue.serverTimestamp()
      const existingJoinEvent = joinEventSnap.data() as
        | JoinEventDocument
        | undefined
      const nextPoolState = game.isFeatured
        ? getFeaturedPoolState(
            nextPlayerCount,
            game.featuredPoolAmount ?? game.prizeAmount ?? 25
          )
        : null

      transaction.set(memberRef, {
        score: 0,
        username: username.trim(),
        platform,
        joinedAt: now,
        answersSubmitted: 0,
        predictionsByQuestionId: {},
        updatedAt: now,
      })
      transaction.set(
        userGameRef,
        {
          score: 0,
          joinedAt: now,
          updatedAt: now,
        },
        { merge: true }
      )
      transaction.set(
        joinEventRef,
        {
          userId,
          ...(!joinEventSnap.exists
            ? {
                firstJoinedAt: now,
                firstSource: source,
                ...(referralCode ? { firstReferralCode: referralCode } : {}),
                ...(referredByUserId
                  ? { firstReferredByUserId: referredByUserId }
                  : {}),
              }
            : {}),
          latestJoinedAt: now,
          latestSource: source,
          latestPlatform: platform,
          joinCount: admin.firestore.FieldValue.increment(1),
          playerCountAtLatestJoin: nextPlayerCount,
          ...(nextPoolState
            ? { poolAmountAtLatestJoin: nextPoolState.amount }
            : {}),
          ...(existingJoinEvent?.shareReferralCode
            ? { shareReferralCode: existingJoinEvent.shareReferralCode }
            : {}),
        },
        { merge: true }
      )

      const gameUpdate: Record<string, string | number | object> = {
        playerCount: nextPlayerCount,
        playerCountByPlatform: nextPlatformCounts,
        updatedAt: now,
      }
      if (nextPoolState) {
        gameUpdate.prizeAmount = nextPoolState.amount
        gameUpdate.prizeAmountCents = nextPoolState.amount * 100
        gameUpdate.prizeType = 'USD'
        gameUpdate.featuredPoolAmount = nextPoolState.amount
        if (playerCount < 50 && nextPlayerCount >= 50) {
          gameUpdate.featuredPool50UnlockedAt = now
        }
        if (playerCount < 100 && nextPlayerCount >= 100) {
          gameUpdate.featuredPool100UnlockedAt = now
        }
      }
      transaction.set(gameRef, gameUpdate, { merge: true })

      return {
        joined: true,
        playerCount: nextPlayerCount,
        prizeAmount: nextPoolState?.amount ?? game.prizeAmount ?? 0,
        featuredPoolAmount: nextPoolState?.amount ?? null,
      }
    })

    console.log(
      `[games/join] game=${gameId} user=${userId} joined=${result.joined ? 1 : 0} playerCount=${result.playerCount} source=${source} referred=${referralCode ? 1 : 0}`
    )
    if (result.joined) {
      trackEvent(
        'game_joined',
        {
          gameId,
          userId,
          source,
          referred: Boolean(referralCode),
          playerCount: result.playerCount,
          prizeAmount: result.prizeAmount,
        },
        userId
      )
    }
    return res.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'GAME_NOT_FOUND' || message === 'USER_NOT_FOUND') {
      return res.status(404).json({ error: 'Game or user not found' })
    }
    if (message === 'GAME_CLOSED') {
      return res.status(409).json({ error: 'This game is no longer joinable' })
    }
    if (message === 'USERNAME_REQUIRED') {
      return res.status(400).json({ error: 'Username is required' })
    }
    console.error(`[games/join] game=${gameId} user=${userId} error=${message}`)
    return res.status(500).json({ error: 'Unable to join game' })
  }
})

router.delete('/:gameId/join', authMiddleware, async (req, res) => {
  const userId = req.user?.uid
  const { gameId } = req.params
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const gameRef = db.collection('games').doc(gameId)
  const memberRef = gameRef.collection('users').doc(userId)
  const userGameRef = db.doc(`users/${userId}/games/${gameId}`)

  try {
    const result = await db.runTransaction(async (transaction) => {
      const [gameSnap, memberSnap] = await Promise.all([
        transaction.get(gameRef),
        transaction.get(memberRef),
      ])
      if (!gameSnap.exists) throw new Error('GAME_NOT_FOUND')
      const game = gameSnap.data() as GameDocument
      if (game.state !== 'scheduled') throw new Error('GAME_STARTED')
      if (!memberSnap.exists) {
        return { left: false, playerCount: asFiniteCount(game.playerCount) }
      }

      const memberPlatform = normalizePlatform(memberSnap.data()?.platform)
      const nextPlayerCount = Math.max(0, asFiniteCount(game.playerCount) - 1)
      const previousPlatformCounts = game.playerCountByPlatform ?? {}
      const nextPlatformCounts = {
        ios: asFiniteCount(previousPlatformCounts.ios),
        android: asFiniteCount(previousPlatformCounts.android),
        web: asFiniteCount(previousPlatformCounts.web),
        unknown: asFiniteCount(previousPlatformCounts.unknown),
      }
      nextPlatformCounts[memberPlatform] = Math.max(
        0,
        nextPlatformCounts[memberPlatform] - 1
      )

      transaction.delete(memberRef)
      transaction.delete(userGameRef)
      transaction.set(
        gameRef,
        {
          playerCount: nextPlayerCount,
          playerCountByPlatform: nextPlatformCounts,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      return { left: true, playerCount: nextPlayerCount }
    })

    console.log(
      `[games/leave] game=${gameId} user=${userId} left=${result.left ? 1 : 0} playerCount=${result.playerCount}`
    )
    return res.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'GAME_NOT_FOUND') {
      return res.status(404).json({ error: 'Game not found' })
    }
    if (message === 'GAME_STARTED') {
      return res.status(409).json({ error: 'You cannot leave after kickoff' })
    }
    console.error(
      `[games/leave] game=${gameId} user=${userId} error=${message}`
    )
    return res.status(500).json({ error: 'Unable to leave game' })
  }
})

router.post('/:gameId/referral-link', authMiddleware, async (req, res) => {
  const userId = req.user?.uid
  const { gameId } = req.params
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const gameRef = db.collection('games').doc(gameId)
  const memberRef = gameRef.collection('users').doc(userId)
  const joinEventRef = gameRef.collection('joinEvents').doc(userId)

  try {
    const [gameSnap, memberSnap, joinEventSnap] = await Promise.all([
      gameRef.get(),
      memberRef.get(),
      joinEventRef.get(),
    ])
    if (!gameSnap.exists)
      return res.status(404).json({ error: 'Game not found' })
    if (!memberSnap.exists) {
      return res
        .status(409)
        .json({ error: 'Join the game before inviting friends' })
    }
    const game = gameSnap.data() as GameDocument
    if (!game.isFeatured) {
      return res.status(409).json({ error: 'This is not a featured game' })
    }

    const joinEvent = joinEventSnap.data() as JoinEventDocument | undefined
    const referralCode =
      joinEvent?.shareReferralCode || randomBytes(6).toString('hex')
    if (!joinEvent?.shareReferralCode) {
      const batch = db.batch()
      batch.set(
        joinEventRef,
        {
          userId,
          shareReferralCode: referralCode,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      batch.set(gameRef.collection('referralCodes').doc(referralCode), {
        userId,
        gameId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      await batch.commit()
    }

    const playerCount = asFiniteCount(game.playerCount)
    const poolAmount = getFeaturedPoolState(
      playerCount,
      game.featuredPoolAmount ?? game.prizeAmount ?? 25
    ).amount
    const origin = publicOrigin(req.protocol, req.get('host'))
    return res.json({
      url: buildShareUrl(origin, gameId, 'player_share', referralCode),
      text: buildPlayerShareText(game, playerCount, poolAmount),
      referralCode,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `[games/referral-link] game=${gameId} user=${userId} error=${message}`
    )
    return res.status(500).json({ error: 'Unable to create referral link' })
  }
})

router.post(
  '/:gameId/featured',
  authMiddleware,
  isAdminMiddleware,
  async (req, res) => {
    const { gameId } = req.params
    const body = (req.body || {}) as FeaturedRequestBody
    const shouldFeature = body.featured !== false
    const gameRef = db.collection('games').doc(gameId)

    try {
      const gameSnap = await gameRef.get()
      if (!gameSnap.exists)
        return res.status(404).json({ error: 'Game not found' })
      const game = gameSnap.data() as GameDocument
      if (shouldFeature && game.state !== 'scheduled') {
        return res
          .status(409)
          .json({ error: 'Only scheduled games can be featured' })
      }

      if (!shouldFeature) {
        await gameRef.set(unfeaturedGameUpdate(game), { merge: true })
        return res.json({ ok: true, isFeatured: false })
      }

      const startTime = game.startTime?.toDate()
      if (!startTime) {
        return res.status(400).json({ error: 'Game start time is required' })
      }
      const [playersSnap, joinEventsSnap, weekGamesSnap] = await Promise.all([
        gameRef.collection('users').get(),
        gameRef.collection('joinEvents').get(),
        db
          .collection('games')
          .where('featuredWeekKey', '==', getFeaturedWeekKey(startTime))
          .get(),
      ])
      const playerCount = playersSnap.size
      const poolState = getFeaturedPoolState(playerCount)
      const weekKey = getFeaturedWeekKey(startTime)
      const featuredAt = admin.firestore.FieldValue.serverTimestamp()

      const existingJoinEventIds = new Set(
        joinEventsSnap.docs.map((joinEvent) => joinEvent.id)
      )
      let importBatch = db.batch()
      let importBatchWrites = 0
      const commitImportBatchIfFull = async (): Promise<void> => {
        if (importBatchWrites < 400) return
        await importBatch.commit()
        importBatch = db.batch()
        importBatchWrites = 0
      }
      for (const playerSnap of playersSnap.docs) {
        const member = playerSnap.data() as MemberDocument
        if (!member.joinedAt) {
          importBatch.set(
            playerSnap.ref,
            { joinedAt: featuredAt, updatedAt: featuredAt },
            { merge: true }
          )
          importBatchWrites += 1
          await commitImportBatchIfFull()
        }
        if (!existingJoinEventIds.has(playerSnap.id)) {
          importBatch.set(gameRef.collection('joinEvents').doc(playerSnap.id), {
            userId: playerSnap.id,
            firstSource: 'pre_feature_existing',
            firstJoinedAt: member.joinedAt ?? featuredAt,
            importedAt: featuredAt,
          })
          importBatchWrites += 1
          await commitImportBatchIfFull()
        }
      }
      if (importBatchWrites > 0) await importBatch.commit()

      const batch = db.batch()
      for (const otherSnap of weekGamesSnap.docs) {
        if (otherSnap.id === gameId) continue
        const otherGame = otherSnap.data() as GameDocument
        if (
          otherGame.isFeatured &&
          otherGame.state !== 'resolved' &&
          otherGame.state !== 'cancelled'
        ) {
          batch.set(otherSnap.ref, unfeaturedGameUpdate(otherGame), {
            merge: true,
          })
        }
      }

      batch.set(
        gameRef,
        {
          isFeatured: true,
          featuredWeekKey: weekKey,
          featuredPoolAmount: poolState.amount,
          featuredOriginalPrizeAmount: game.isFeatured
            ? (game.featuredOriginalPrizeAmount ?? 0)
            : (game.prizeAmount ?? 0),
          featuredOriginalPrizeAmountCents: game.isFeatured
            ? (game.featuredOriginalPrizeAmountCents ?? 0)
            : (game.prizeAmountCents ??
              (game.prizeType === 'USD'
                ? Math.round((game.prizeAmount ?? 0) * 100)
                : 0)),
          featuredOriginalPrizeType: game.isFeatured
            ? (game.featuredOriginalPrizeType ?? 'POINTS')
            : (game.prizeType ?? 'POINTS'),
          prizeAmount: poolState.amount,
          prizeAmountCents: poolState.amount * 100,
          prizeType: 'USD',
          playerCount,
          featuredPoolAnnouncements: admin.firestore.FieldValue.delete(),
          featuredPool50UnlockedAt:
            playerCount >= 50
              ? admin.firestore.FieldValue.serverTimestamp()
              : admin.firestore.FieldValue.delete(),
          featuredPool100UnlockedAt:
            playerCount >= 100
              ? admin.firestore.FieldValue.serverTimestamp()
              : admin.firestore.FieldValue.delete(),
          featuredAt,
          featuredBy: req.user?.uid || null,
          updatedAt: featuredAt,
        },
        { merge: true }
      )
      await batch.commit()

      console.log(
        `[games/featured] game=${gameId} featured=1 week=${weekKey} playerCount=${playerCount} pool=${poolState.amount}`
      )
      return res.json({
        ok: true,
        isFeatured: true,
        featuredWeekKey: weekKey,
        playerCount,
        pool: poolState,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[games/featured] game=${gameId} error=${message}`)
      return res.status(500).json({ error: 'Unable to update featured game' })
    }
  }
)

router.post(
  '/:gameId/featured/announce',
  authMiddleware,
  isAdminMiddleware,
  async (req, res) => {
    const { gameId } = req.params
    const body = (req.body || {}) as AnnouncementRequestBody
    const amount = parseFeaturedPoolAmount(body.amount ?? 0)
    if (!amount) return res.status(400).json({ error: 'Invalid pool amount' })

    try {
      const gameRef = db.collection('games').doc(gameId)
      const gameSnap = await gameRef.get()
      if (!gameSnap.exists)
        return res.status(404).json({ error: 'Game not found' })
      const game = gameSnap.data() as GameDocument
      if (!game.isFeatured) {
        return res.status(409).json({ error: 'This is not a featured game' })
      }
      const currentAmount = getFeaturedPoolState(
        asFiniteCount(game.playerCount),
        game.featuredPoolAmount ?? game.prizeAmount ?? 25
      ).amount
      if (amount > currentAmount) {
        return res
          .status(409)
          .json({ error: `$${amount} has not unlocked yet` })
      }

      const announcedAt = admin.firestore.Timestamp.now()
      await gameRef.update({
        [`featuredPoolAnnouncements.${amount}`]: announcedAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      const origin = publicOrigin(req.protocol, req.get('host'))
      return res.json({
        ok: true,
        amount,
        announcedAtMs: announcedAt.toMillis(),
        url: buildShareUrl(origin, gameId, `featured_pool_${amount}`),
        text: buildAnnouncementShareText(game, amount),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[games/featured-announce] game=${gameId} error=${message}`)
      return res.status(500).json({ error: 'Unable to record announcement' })
    }
  }
)

router.get(
  '/:gameId/featured/analytics',
  authMiddleware,
  isAdminMiddleware,
  async (req, res) => {
    const { gameId } = req.params
    try {
      const gameRef = db.collection('games').doc(gameId)
      const [gameSnap, joinsSnap] = await Promise.all([
        gameRef.get(),
        gameRef.collection('joinEvents').get(),
      ])
      if (!gameSnap.exists)
        return res.status(404).json({ error: 'Game not found' })
      const game = gameSnap.data() as GameDocument
      const kickoffAtMs = getTimestampMs(game.startTime)
      if (kickoffAtMs === null) {
        return res.status(400).json({ error: 'Game start time is required' })
      }

      const joins: FeaturedJoinRecord[] = joinsSnap.docs.map((joinSnap) => {
        const join = joinSnap.data() as JoinEventDocument
        return {
          firstJoinedAtMs: getTimestampMs(join.firstJoinedAt),
          source: join.firstSource || 'direct',
          referred: Boolean(join.firstReferredByUserId),
        }
      })
      const announcementTimes: FeaturedAnnouncementTimes = {}
      const rawAnnouncements = game.featuredPoolAnnouncements ?? {}
      for (const amount of [25, 50, 100] as const) {
        const announcedAtMs = getTimestampMs(rawAnnouncements[String(amount)])
        if (announcedAtMs !== null) announcementTimes[amount] = announcedAtMs
      }
      const analytics = buildFeaturedJoinAnalytics(
        joins,
        kickoffAtMs,
        announcementTimes
      )
      const pool = getFeaturedPoolState(
        asFiniteCount(game.playerCount),
        game.featuredPoolAmount ?? game.prizeAmount ?? 25
      )

      return res.json({
        gameId,
        isFeatured: Boolean(game.isFeatured),
        activePlayers: asFiniteCount(game.playerCount),
        pool,
        kickoffAtMs,
        ...analytics,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[games/featured-analytics] game=${gameId} error=${message}`
      )
      return res
        .status(500)
        .json({ error: 'Unable to load featured analytics' })
    }
  }
)

export default router
