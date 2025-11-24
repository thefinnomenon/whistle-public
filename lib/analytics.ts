import * as Application from 'expo-application'
import * as Device from 'expo-device'
import * as Network from 'expo-network'
import { Mixpanel } from 'mixpanel-react-native'
import { Appearance, Platform } from 'react-native'
import { env, isProduction } from './env'

let mixpanel: Mixpanel | null = null

const registerDeviceProperties = async () => {
  if (!mixpanel) return

  try {
    const networkState = await Network.getNetworkStateAsync()
    const colorScheme = Appearance.getColorScheme()

    const superProperties: Record<string, any> = {
      platform: Platform.OS,
      platform_version: Platform.Version?.toString() || 'unknown',
      device_model: Device.modelName || 'unknown',
      device_brand: Device.brand || 'unknown',
      os_version: Device.osVersion || 'unknown',
      app_version: Application.nativeApplicationVersion || 'unknown',
      app_build: Application.nativeBuildVersion || 'unknown',
      color_scheme: colorScheme === 'dark' ? 'dark' : 'light',
    }

    // Add network type if available
    if (networkState.type) {
      superProperties.network_type = networkState.type
    }

    mixpanel.registerSuperProperties(superProperties)
    console.log(
      '[Mixpanel] Registered device super properties:',
      superProperties
    )
  } catch (error) {
    console.error('[Mixpanel] Failed to register device properties:', error)
  }
}

const initializeMixpanel = async () => {
  if (!isProduction()) return

  const token = env.MIXPANEL_TOKEN

  if (!token) {
    console.warn('Mixpanel token not found. Analytics will not be tracked.')
    return
  }

  try {
    mixpanel = new Mixpanel(token, true)
    await mixpanel.init()

    // Register super properties (attached to all events)
    await registerDeviceProperties()
  } catch (error) {
    console.error('Failed to initialize Mixpanel:', error)
  }
}

const track = (eventName: string, properties?: Record<string, any>) => {
  // Skip logging in dev mode
  if (!isProduction()) {
    return
  }
  if (!mixpanel) {
    console.warn(
      '[Mixpanel] Not initialized. APP_ENV:',
      env.APP_ENV,
      'Token:',
      env.MIXPANEL_TOKEN ? 'Present' : 'Missing'
    )
    return
  }
  console.log(`[Mixpanel] Tracking event: ${eventName}`, properties)
  mixpanel.track(eventName, properties)
}

const identify = (userId: string) => {
  // Skip logging in dev mode
  if (!isProduction()) {
    return
  }
  if (!mixpanel) {
    console.warn('Mixpanel not initialized')
    return
  }
  mixpanel.identify(userId)
}

const setUserProperties = (properties: Record<string, any>) => {
  if (!isProduction()) return
  if (!mixpanel) {
    console.warn('Mixpanel not initialized')
    return
  }
  mixpanel.getPeople().set(properties)
}

const reset = () => {
  if (!isProduction()) return
  if (!mixpanel) {
    console.warn('Mixpanel not initialized')
    return
  }
  mixpanel.reset()
}

const registerSuperProperties = (properties: Record<string, any>) => {
  // Skip logging in dev mode
  if (!isProduction()) {
    return
  }
  if (!mixpanel) {
    console.warn('Mixpanel not initialized')
    return
  }
  mixpanel.registerSuperProperties(properties)
}

const timeEvent = (eventName: string) => {
  if (!isProduction()) return
  if (!mixpanel) {
    console.warn('Mixpanel not initialized')
    return
  }
  mixpanel.timeEvent(eventName)
}

const trackScreenView = (
  screenName: string,
  properties?: Record<string, any>
) => {
  track('Screen View', { screen: screenName, ...properties })
}

// Export as namespace
export const analytics = {
  init: initializeMixpanel,
  track,
  identify,
  setUserProperties,
  reset,
  registerSuperProperties,
  timeEvent,
  trackScreenView,
}

// Also export individual functions for backward compatibility
export {
  identify as identifyUser,
  initializeMixpanel,
  registerSuperProperties,
  reset as resetAnalytics,
  setUserProperties,
  timeEvent,
  track as trackEvent,
  trackScreenView,
}
