import { Router } from 'express'
import { db } from '../firebase'

const router = Router()

type LandingGameDocument = {
  homeTeam?: string
  awayTeam?: string
  playerCount?: number
  prizeAmount?: number
  featuredPoolAmount?: number
  isFeatured?: boolean
}

const APP_STORE_URL =
  'https://apps.apple.com/app/whistle-live-prediction-pools/id6755129318'

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const cleanParam = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return cleaned || fallback
}

const cleanGameId = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .slice(0, 128)

router.get('/:gameId', async (req, res) => {
  const gameId = cleanGameId(req.params.gameId)
  if (!gameId) return res.status(404).send('Game not found')

  try {
    const gameSnap = await db.collection('games').doc(gameId).get()
    if (!gameSnap.exists) return res.status(404).send('Game not found')
    const game = gameSnap.data() as LandingGameDocument
    const source = cleanParam(
      typeof req.query.source === 'string' ? req.query.source : undefined,
      'shared_link'
    )
    const referralCode = cleanParam(
      typeof req.query.ref === 'string' ? req.query.ref : undefined,
      ''
    )
    const deepLinkParams = new URLSearchParams({ gameId, source })
    if (referralCode) deepLinkParams.set('ref', referralCode)
    const appUrl = `whistle:///?${deepLinkParams.toString()}`
    const matchup = `${game.awayTeam || 'Away'} vs ${game.homeTeam || 'Home'}`
    const prizeAmount = Math.max(
      25,
      game.featuredPoolAmount ?? game.prizeAmount ?? 25
    )
    const playerCount = Math.max(0, game.playerCount ?? 0)
    const title = game.isFeatured
      ? `${matchup} Featured Game`
      : `${matchup} on Whistle`

    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="Predict ${escapeHtml(matchup)} live with friends on Whistle." />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="$${prizeAmount} prize pool. ${playerCount} players joined." />
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090f1f; color: #fff; }
      main { width: min(92vw, 480px); box-sizing: border-box; padding: 32px; border: 1px solid #263556; border-radius: 24px; background: #111a30; text-align: center; }
      .eyebrow { color: #82b4ff; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 12px 0 8px; font-size: 32px; }
      .pool { margin: 24px 0 6px; font-size: 44px; font-weight: 850; }
      .muted { color: #b6c1d6; }
      .tiers { margin: 24px 0; padding: 14px; border-radius: 14px; background: #0b1326; line-height: 1.7; }
      a { display: block; margin-top: 12px; padding: 14px 18px; border-radius: 12px; text-decoration: none; font-weight: 750; }
      .primary { background: #2878ff; color: #fff; }
      .secondary { border: 1px solid #50617f; color: #fff; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">${game.isFeatured ? 'Featured Game' : 'Live Predictions'}</div>
      <h1>${escapeHtml(matchup)}</h1>
      <div class="pool">$${prizeAmount}</div>
      <div class="muted">${playerCount} ${playerCount === 1 ? 'player' : 'players'} joined</div>
      <div class="tiers">$25 guaranteed<br />$50 at 50 players<br />$100 at 100 players</div>
      <a class="primary" href="${escapeHtml(appUrl)}">Open Whistle</a>
      <a class="secondary" href="${APP_STORE_URL}">Get Whistle on the App Store</a>
    </main>
  </body>
</html>`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[referral-landing] game=${gameId} error=${message}`)
    return res.status(500).send('Unable to load this game')
  }
})

export default router
