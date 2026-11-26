import dotenv from 'dotenv'
import packageJson from './package.json'

const appEnv = process.env.EXPO_PUBLIC_APP_ENV || 'development'
dotenv.config()
dotenv.config({ path: `.env.${appEnv}`, override: true })

const IS_DEV = appEnv === 'development'
const IS_STAGING = appEnv === 'staging'

const getAppName = () => {
  if (IS_DEV) return 'Whistle (Dev)'
  if (IS_STAGING) return 'Whistle (Staging)'
  return 'Whistle'
}

const getAppScheme = () => {
  if (IS_DEV) return 'whistle-dev'
  if (IS_STAGING) return 'whistle-staging'
  return 'whistle'
}

const getAppIcon = () => {
  // You can use different icons for different environments
  return './assets/images/icon.png'
}

const getBundleIdentifier = () => {
  if (IS_DEV) return 'com.finnternet.whistle.dev'
  if (IS_STAGING) return 'com.finnternet.whistle.staging'
  return 'com.finnternet.whistle'
}

const getAppGroup = () => `group.${getBundleIdentifier()}`

export default {
  expo: {
    name: getAppName(),
    slug: 'whistle',
    version: packageJson.version,
    orientation: 'portrait',
    icon: getAppIcon(),
    scheme: getAppScheme(),
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    runtimeVersion: '2.0.0',
    updates: {
      enabled: false,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 3000,
      url: 'https://u.expo.dev/00000000-0000-0000-0000-000000000000',
    },
    ios: {
      appleTeamId: process.env.APPLE_TEAM_ID,
      supportsTablet: true,
      usesAppleSignIn: true,
      bundleIdentifier: getBundleIdentifier(),
      googleServicesFile: IS_DEV
        ? './GoogleService-Info.dev.plist'
        : './GoogleService-Info.plist',
      config: {
        usesNonExemptEncryption: false,
      },
      entitlements: {
        'aps-environment': 'production',
        'com.apple.security.application-groups': [
          `group.${getBundleIdentifier()}`,
        ],
      },
      infoPlist: {
        UIBackgroundModes: ['remote-notification'],
        WhistleAppGroup: `group.${getBundleIdentifier()}`,
      },
    },
    android: {
      package: getBundleIdentifier(),
      googleServicesFile: IS_DEV
        ? './google-services.dev.json'
        : './google-services.json',
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      notification: {
        icon: './assets/images/notification-icon.png',
        color: '#000000',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      output: 'static',
      favicon: './assets/images/favicon.png',
      bundler: 'metro',
    },
    plugins: [
      './plugins/withNotificationSounds',
      'expo-updates',
      'expo-video',
      'expo-router',
      '@bacons/apple-targets',
      [
        'expo-splash-screen',
        {
          image: './assets/images/adaptive-icon.png',
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
          dark: {
            image: './assets/images/adaptive-icon-dark.png',
            resizeMode: 'contain',
            backgroundColor: '#000000',
          },
        },
      ],
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          project: 'whistle',
          organization: 'the-finnternet',
        },
      ],
      '@react-native-firebase/app',
      '@react-native-firebase/auth',
      '@react-native-firebase/messaging',
      '@react-native-google-signin/google-signin',
      'expo-apple-authentication',
      [
        'expo-build-properties',
        {
          ios: {
            useFrameworks: 'static',
            forceStaticLinking: [
              'RNFBApp',
              'RNFBAuth',
              'RNFBFirestore',
              'RNFBMessaging',
            ],
          },
        },
      ],
      [
        'expo-notifications',
        {
          sounds: ['./assets/audio/whistle.wav'],
        },
      ],
      [
        './plugins/withAppGroupIdentifier',
        {
          appGroup: getAppGroup(),
        },
      ],
      './plugins/withAndroidQuestionNotifications',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      eas: {
        projectId: '00000000-0000-0000-0000-000000000000',
      },
      appEnv,
      domain: process.env.EXPO_PUBLIC_DOMAIN,
      mixpanelToken: process.env.EXPO_PUBLIC_MIXPANEL_TOKEN,
      sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      googleWebClientIdAndroid:
        process.env.EXPO_PUBLIC_ANDROID_GOOGLE_WEB_CLIENT_ID,
      googleWebClientIdIos: process.env.EXPO_PUBLIC_IOS_GOOGLE_WEB_CLIENT_ID,
    },
  },
}
