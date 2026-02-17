import Mixpanel from 'mixpanel'

let mixpanel: Mixpanel.Mixpanel | null = null

if (process.env.MIXPANEL_TOKEN && process.env.NODE_ENV === 'production') {
  mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN)
  console.log('[mixpanel] Initialized')
}

const normalizeEventName = (eventName: string) =>
  eventName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

export const trackEvent = (
  eventName: string,
  properties?: Record<string, any>,
  userId?: string
) => {
  const normalizedEventName = normalizeEventName(eventName)
  const props = {
    ...properties,
    distinct_id:
      userId || properties?.user_id || properties?.userId || 'anonymous',
    event_name_original: eventName,
    event_name_normalized: normalizedEventName,
    event_schema_version: 1,
    source: properties?.source || 'unknown',
    timestamp: new Date().toISOString(),
  }

  // Always log to stdout for visibility, even when Mixpanel is disabled in dev
  if (process.env.NODE_ENV !== 'production') {
    console.log('[trackEvent]', eventName, props)
  }

  if (!mixpanel) return

  mixpanel.track(eventName, props)
}

export const identifyUser = (
  userId: string,
  properties?: Record<string, any>
) => {
  if (!mixpanel) return

  mixpanel.people.set(userId, properties || {})
}

export const incrementUserProperty = (
  userId: string,
  property: string,
  by: number = 1
) => {
  if (!mixpanel) return

  mixpanel.people.increment(userId, property, by)
}
