import { Request, Response, NextFunction } from 'express'
import { admin } from '../firebase'

export const optionalAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization || ''
    const idToken =
      authHeader.startsWith('Bearer ') && authHeader.slice('Bearer '.length)
    if (!idToken) {
      return next()
    }
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.user = { uid: decoded.uid, email: decoded.email || undefined }
    return next()
  } catch {
    // Swallow errors: proceed without req.user
    return next()
  }
}
