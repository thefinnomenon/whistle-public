import Mixpanel from 'mixpanel'

let mixpanel: Mixpanel.Mixpanel | null = null

if (process.env.MIXPANEL_TOKEN) {
  mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN)
  console.log('[mixpanel] Initialized')
} else {
  console.log('[mixpanel] Not initialized - MIXPANEL_TOKEN not set')
}

export const trackEvent = (
  eventName: string,
  properties?: Record<string, any>,
  userId?: string
) => {
  if (!mixpanel) return

  const props = {
    ...properties,
    distinct_id: userId || properties?.userId || 'anonymous',
    source: 'backend',
    timestamp: new Date().toISOString(),
  }

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
