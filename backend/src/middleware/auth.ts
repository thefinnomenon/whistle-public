import type { Request, Response, NextFunction } from 'express'
import { admin } from '../firebase'
import { verifyWhistleJwt } from '../lib/jwt'

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization || ''
    const token =
      authHeader.startsWith('Bearer ') && authHeader.slice('Bearer '.length)

    if (!token) {
      return res.status(401).json({ error: 'Missing token' })
    }

    // Try Whistle JWT first
    const secret = process.env.WHISTLE_JWT_SECRET
    if (secret) {
      const whistleDecoded = verifyWhistleJwt(secret, token)
      if (whistleDecoded) {
        req.user = { uid: whistleDecoded.uid, email: undefined }
        return next()
      }
    }

    // Fall back to Firebase ID token
    try {
      const decoded = await admin.auth().verifyIdToken(token)
      req.user = { uid: decoded.uid, email: decoded.email }
      return next()
    } catch (firebaseErr) {
      console.error('[authMiddleware] Invalid token', firebaseErr)
      return res.status(401).json({ error: 'Invalid token' })
    }
  } catch (err) {
    console.error('[authMiddleware] Auth error', err)
    return res.status(401).json({ error: 'Invalid token' })
  }
}
