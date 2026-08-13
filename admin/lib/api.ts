import { getAuth } from 'firebase/auth'

const BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000'

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string
    body?: object
    token?: string
  } = {}
): Promise<T> {
  const auth = getAuth()
  const user = auth.currentUser
  const idToken = options.token || (user ? await user.getIdToken() : undefined)

  const resp = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      msg = data?.error || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  return resp.json()
}
