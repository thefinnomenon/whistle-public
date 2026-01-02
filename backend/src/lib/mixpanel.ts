import Mixpanel from 'mixpanel'

let mixpanel: Mixpanel.Mixpanel | null = null

if (process.env.MIXPANEL_TOKEN && process.env.NODE_ENV === 'production') {
  mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN)
  console.log('[mixpanel] Initialized')
}

export const trackEvent = (
  eventName: string,
  properties?: Record<string, any>,
  userId?: string
) => {
  const props = {
    ...properties,
    distinct_id: userId || properties?.userId || 'anonymous',
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
