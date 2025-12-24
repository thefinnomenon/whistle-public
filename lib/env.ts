const appEnv = process.env.EXPO_PUBLIC_APP_ENV || 'development'

export const isEnvironment = (environment: string): boolean =>
  appEnv === environment
export const isDevelopment = (): boolean => isEnvironment('development')
export const isStaging = (): boolean => isEnvironment('staging')
export const isProduction = (): boolean => isEnvironment('production')

console.log(
  'GOOGLE WEB CLIENT ID',
  process.env.EXPO_PUBLIC_ANDROID_GOOGLE_WEB_CLIENT_ID,
  process.env.EXPO_PUBLIC_IOS_GOOGLE_WEB_CLIENT_ID
)

export const env = {
  APP_ENV: appEnv,
  MIXPANEL_TOKEN: process.env.EXPO_PUBLIC_MIXPANEL_TOKEN,
  SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  RESEND_API_KEY: process.env.EXPO_PUBLIC_RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  DOMAIN: process.env.EXPO_PUBLIC_DOMAIN,
  GOOGLE_WEB_CLIENT_ID_ANDROID:
    process.env.EXPO_PUBLIC_ANDROID_GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID_IOS: process.env.EXPO_PUBLIC_IOS_GOOGLE_WEB_CLIENT_ID,
}
