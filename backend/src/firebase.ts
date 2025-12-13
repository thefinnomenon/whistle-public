import admin from 'firebase-admin'

const initAdmin = () => {
  if (admin.apps.length) return

  const rawSaB64 = process.env.FIREBASE_SERVICE_ACCOUNT

  if (!rawSaB64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT (base64) is required')
  }

  let creds
  try {
    const decoded = Buffer.from(rawSaB64.trim(), 'base64').toString('utf8')
    creds = JSON.parse(decoded)
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be base64-encoded JSON')
  }

  admin.initializeApp({
    credential: admin.credential.cert(creds as admin.ServiceAccount),
  })
}

initAdmin()

export { admin }
export const db = admin.firestore()
