import type { Request, Response, NextFunction } from 'express'
import { admin } from '../firebase'

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

    const decoded = await admin.auth().verifyIdToken(token)
    req.user = { uid: decoded.uid, email: decoded.email }
    return next()
  } catch (err) {
    console.error('[authMiddleware] Invalid token', err)
    return res.status(401).json({ error: 'Invalid token' })
  }
}
