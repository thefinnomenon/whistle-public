import { createHmac } from 'crypto'

const base64url = (input: Buffer | string) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

export function verifyWhistleJwt(
  secret: string,
  token: string
): { uid: string; exp: number } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const [encodedHeader, encodedPayload, signature] = parts

    // Verify signature
    const data = `${encodedHeader}.${encodedPayload}`
    const expectedSignature = createHmac('sha256', secret)
      .update(data)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    if (signature !== expectedSignature) {
      return null
    }

    // Decode payload
    const payloadJson = Buffer.from(encodedPayload, 'base64').toString('utf-8')
    const payload = JSON.parse(payloadJson) as { uid: string; exp: number }

    // Check expiration
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp < now) {
      return null
    }

    return payload
  } catch (err) {
    return null
  }
}
