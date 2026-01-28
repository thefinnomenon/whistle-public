#!/usr/bin/env node
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const getArg = (name, shortName) => {
  const longIdx = args.findIndex((arg) => arg === `--${name}`)
  if (longIdx !== -1 && args[longIdx + 1]) return args[longIdx + 1]
  if (shortName) {
    const shortIdx = args.findIndex((arg) => arg === `-${shortName}`)
    if (shortIdx !== -1 && args[shortIdx + 1]) return args[shortIdx + 1]
  }
  return null
}

const envName = getArg('env', 'e')
const channel = getArg('channel', 'c')
const message = getArg('message', 'm')

if (!envName || !channel) {
  console.error(
    'Usage: node scripts/eas-update.js --env <env> --channel <channel> --message "<msg>"'
  )
  process.exit(1)
}

const updateArgs = ['update', '--channel', channel]
if (message) {
  updateArgs.push('--message', message)
}

const result = spawnSync('eas', updateArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_PUBLIC_APP_ENV: envName,
  },
})

process.exit(result.status ?? 1)
