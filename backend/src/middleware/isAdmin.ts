import { NextFunction, Request, Response } from 'express'
import { db } from '../firebase'

// Checks Firestore users/{uid} for isAdmin: true
export const isAdminMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const uid = req.user?.uid
    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const userDoc = await db.collection('users').doc(uid).get()
    const isAdmin = userDoc.exists
      ? (userDoc.data()?.isAdmin as boolean)
      : false

    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    return next()
  } catch (err) {
    console.error('[isAdminMiddleware] error', err)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}
