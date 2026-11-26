import Constants from 'expo-constants'

const extra = (Constants.expoConfig?.extra || {}) as Record<string, any>
const appEnv = extra.appEnv || process.env.EXPO_PUBLIC_APP_ENV || 'development'

export const isEnvironment = (environment: string): boolean =>
  appEnv === environment
export const isDevelopment = (): boolean => isEnvironment('development')
export const isStaging = (): boolean => isEnvironment('staging')
export const isProduction = (): boolean => isEnvironment('production')

console.log(
  'GOOGLE WEB CLIENT ID',
  extra.googleWebClientIdAndroid ??
    process.env.EXPO_PUBLIC_ANDROID_GOOGLE_WEB_CLIENT_ID,
  extra.googleWebClientIdIos ?? process.env.EXPO_PUBLIC_IOS_GOOGLE_WEB_CLIENT_ID
)

export const env = {
  APP_ENV: appEnv,
  MIXPANEL_TOKEN: extra.mixpanelToken ?? process.env.EXPO_PUBLIC_MIXPANEL_TOKEN,
  SENTRY_DSN: extra.sentryDsn ?? process.env.EXPO_PUBLIC_SENTRY_DSN,
  DOMAIN: extra.domain ?? process.env.EXPO_PUBLIC_DOMAIN,
  GOOGLE_WEB_CLIENT_ID_ANDROID:
    extra.googleWebClientIdAndroid ??
    process.env.EXPO_PUBLIC_ANDROID_GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID_IOS:
    extra.googleWebClientIdIos ??
    process.env.EXPO_PUBLIC_IOS_GOOGLE_WEB_CLIENT_ID,
}
