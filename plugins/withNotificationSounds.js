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
 * Copy notification sound to iOS
 * The file is copied to the iOS project directory.
 * You only need to add it to Xcode once manually:
 * 1. Open ios/whistle.xcworkspace in Xcode
 * 2. Drag whistle.wav from ios/whistle/ into the project navigator
 * 3. Make sure "Copy items if needed" is unchecked (it's already there)
 * 4. Make sure your target is selected
 */
const withIOSNotificationSound = (config) => {
  return withXcodeProject(config, async (config) => {
    const soundFile = path.join(
      config.modRequest.projectRoot,
      'assets/audio/whistle.wav'
    )
    const projectName = config.modRequest.projectName || 'whistle'
    const targetDir = path.join(
      config.modRequest.platformProjectRoot,
      projectName
    )

    if (!fs.existsSync(soundFile)) {
      console.warn('⚠️  Could not find whistle.wav in assets/audio')
      return config
    }

    // Copy sound file to iOS project directory
    const targetFile = path.join(targetDir, 'whistle.wav')
    fs.copyFileSync(soundFile, targetFile)
    console.log('✅ Copied whistle.wav to iOS project directory')

    return config
  })
}

/**
 * Config plugin to add notification sounds
 */
module.exports = function withNotificationSounds(config) {
  config = withAndroidNotificationSound(config)
  config = withIOSNotificationSound(config)
  return config
}
