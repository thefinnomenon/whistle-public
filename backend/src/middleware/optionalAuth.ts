import { Request, Response, NextFunction } from 'express'
import { admin } from '../firebase'
import { verifyWhistleJwt } from '../lib/jwt'

export const optionalAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization || ''
    const token =
      authHeader.startsWith('Bearer ') && authHeader.slice('Bearer '.length)
    if (!token) {
      return next()
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
      req.user = { uid: decoded.uid, email: decoded.email || undefined }
      return next()
    } catch {
      // Swallow errors: proceed without req.user
      return next()
    }
  } catch {
    // Swallow errors: proceed without req.user
    return next()
  }
}
