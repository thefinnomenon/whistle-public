import { render } from '@react-email/render'
import { ReactElement } from 'react'
import { Resend } from 'resend'

interface SendEmailOptions {
  to: string | string[]
  subject: string
  react: ReactElement
  from?: string
}

export async function sendEmail({
  to,
  subject,
  react,
  from = process.env.EMAIL_FROM,
}: SendEmailOptions) {
  try {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) throw new Error('RESEND_API_KEY is not set on the server')
    const resend = new Resend(apiKey)
    const html = await render(react)

    if (!from) {
      throw new Error('EMAIL_FROM is not set')
    }

    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html,
    })

    if (error) {
      console.error('Error sending email:', error)
      throw error
    }

    return { success: true, data }
  } catch (error) {
    console.error('Failed to send email:', error)
    throw error
  }
}
