/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-content',
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
  buildSettings: {
    APP_GROUP_ID: `group.${config.ios.bundleIdentifier}`,
  },
})
