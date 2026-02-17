import { Router } from 'express'
import { admin } from '../firebase'
import { trackEvent } from '../lib/mixpanel'
import { sendTesterWaitlistToSlack } from '../lib/slack'

const router = Router()

type WaitlistBody = {
  email?: string
}

const MAX_EMAIL_LENGTH = 320
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const normalizeEmail = (value: string) => value.trim().toLowerCase()

const maskEmailForLog = (email: string) => {
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return 'invalid'
  const prefix = localPart.slice(0, 2)
  return `${prefix || '*'}***@${domain}`
}

router.post('/waitlist', async (req, res) => {
  const { email: emailRaw } = (req.body || {}) as WaitlistBody

  if (typeof emailRaw !== 'string') {
    trackEvent('testers_waitlist_submit_failed', {
      reason: 'missing_email',
      http_status: 400,
      source: 'backend',
    })
    return res.status(400).json({ error: 'Email is required' })
  }

  const email = normalizeEmail(emailRaw)

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    trackEvent('testers_waitlist_submit_failed', {
      reason: 'invalid_email',
      http_status: 400,
      source: 'backend',
    })
    return res.status(400).json({ error: 'Please enter a valid email address' })
  }

  const emailDomain = email.split('@')[1] || 'unknown'
  const docId = encodeURIComponent(email)
  const waitlistRef = admin.firestore().collection('testerWaitlist').doc(docId)
  let created = false

  try {
    await admin.firestore().runTransaction(async (tx) => {
      const waitlistDoc = await tx.get(waitlistRef)
      const baseData = {
        email,
        source: 'testers_page',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }

      if (waitlistDoc.exists) {
        tx.set(waitlistRef, baseData, { merge: true })
        return
      }

      created = true
      tx.set(waitlistRef, {
        ...baseData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    })

    console.log(
      `[testers/waitlist] upserted email=${maskEmailForLog(email)} domain=${emailDomain}`
    )
    trackEvent('testers_waitlist_submitted', {
      created,
      email_domain: emailDomain,
      source: 'backend',
    })

    if (created) {
      trackEvent('testers_waitlist_added', {
        email_domain: emailDomain,
        source: 'backend',
      })
    } else {
      trackEvent('testers_waitlist_resubmitted', {
        email_domain: emailDomain,
        source: 'backend',
      })
    }

    if (created) {
      try {
        await sendTesterWaitlistToSlack({
          email,
          emailDomain,
          source: 'testers_page',
        })
        console.log(
          `[testers/waitlist/slack] delivered email=${maskEmailForLog(email)} domain=${emailDomain}`
        )
      } catch (slackError) {
        console.error(
          `[testers/waitlist/slack] failed email=${maskEmailForLog(email)} domain=${emailDomain}`,
          slackError
        )
      }
    }

    return res.status(201).json({ ok: true, created })
  } catch (error) {
    console.error(
      `[testers/waitlist] failed email=${maskEmailForLog(email)} domain=${emailDomain}`,
      error
    )
    trackEvent('testers_waitlist_submit_failed', {
      reason: 'server_error',
      http_status: 500,
      email_domain: emailDomain,
      source: 'backend',
    })
    return res.status(500).json({ error: 'Failed to submit email right now' })
  }
})

export default router
