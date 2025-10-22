const {
  withProjectBuildGradle,
  withXcodeProject,
} = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

/**
 * Copy notification sound and icons to Android
 */
const withAndroidNotificationSound = (config) => {
  return withProjectBuildGradle(config, async (config) => {
    const projectRoot = config.modRequest.projectRoot
    const platformRoot = config.modRequest.platformProjectRoot

    // Copy sound file
    const soundFile = path.join(projectRoot, 'assets/audio/whistle.wav')
    const soundTargetDir = path.join(platformRoot, 'app/src/main/res/raw')

    if (!fs.existsSync(soundTargetDir)) {
      fs.mkdirSync(soundTargetDir, { recursive: true })
    }

    if (fs.existsSync(soundFile)) {
      fs.copyFileSync(soundFile, path.join(soundTargetDir, 'whistle.wav'))
      console.log('✅ Copied whistle.wav to Android res/raw')
    } else {
      console.warn('⚠️  Could not find whistle.wav in assets/audio')
    }

    // Copy notification icons from assets/images/res to Android res
    const resSourceDir = path.join(projectRoot, 'assets/images/res')
    const resTargetDir = path.join(platformRoot, 'app/src/main/res')

    if (fs.existsSync(resSourceDir)) {
      // Copy all drawable folders
      const drawableDirs = fs
        .readdirSync(resSourceDir)
        .filter((dir) => dir.startsWith('drawable') || dir.startsWith('mipmap'))

      drawableDirs.forEach((dir) => {
        const sourceDir = path.join(resSourceDir, dir)
        const targetDir = path.join(resTargetDir, dir)

        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }

        // Copy all files in the drawable directory
        const files = fs.readdirSync(sourceDir)
        files.forEach((file) => {
          fs.copyFileSync(
            path.join(sourceDir, file),
            path.join(targetDir, file)
          )
        })

        console.log(
          `✅ Copied ${files.length} file(s) from ${dir} to Android res`
        )
      })
    } else {
      console.log(
        'ℹ️  No assets/images/res directory found, skipping icon copy'
      )
    }

    return config
  })
}

/**
 * Config plugin to add notification sounds
 */
module.exports = function withNotificationSounds(config) {
  config = withAndroidNotificationSound(config)
  return config
}
