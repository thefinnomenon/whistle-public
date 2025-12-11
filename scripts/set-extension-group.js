const path = require('path')
const fs = require('fs')
const { getConfig } = require('@expo/config')

// eslint-disable-next-line no-undef
const projectRoot = path.join(__dirname, '..')
const modeEnv = process.env.EXPO_PUBLIC_APP_ENV || process.env.APP_ENV
const mode = modeEnv === 'production' ? 'production' : 'development'

const { exp } = getConfig(projectRoot, { mode })
const group = exp?.ios?.infoPlist?.WhistleAppGroup

if (!group) {
  console.error(
    '[set-extension-group] WhistleAppGroup missing from ios.infoPlist in Expo config'
  )
  process.exit(1)
}

const plistPath = path.join(
  projectRoot,
  'targets',
  'notification-content',
  'Info.plist'
)

const key = '<key>WhistleAppGroup</key>'
const pattern = new RegExp(`${key}\\s*<string>.*?<\\/string>`)
const replacement = `${key}\n  <string>${group}</string>`

const content = fs.readFileSync(plistPath, 'utf8')
const next = pattern.test(content)
  ? content.replace(pattern, replacement)
  : content.replace('</dict>', `  ${key}\n  <string>${group}</string>\n</dict>`)

fs.writeFileSync(plistPath, next)
console.log(
  `[set-extension-group] Set WhistleAppGroup to ${group} (mode: ${mode})`
)
