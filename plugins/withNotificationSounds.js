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
 * Copy notification sound to iOS and add to Xcode project
 */
const withIOSNotificationSound = (config) => {
  return withXcodeProject(config, async (config) => {
    const projectRoot = config.modRequest.projectRoot
    const iosRoot = config.modRequest.platformProjectRoot
    const projectName = config.modRequest.projectName
    const soundFile = path.join(projectRoot, 'assets/audio/whistle.wav')

    if (!fs.existsSync(soundFile)) {
      console.warn('⚠️  Could not find whistle.wav in assets/audio')
      return config
    }

    // 1) Copy into ios/<ProjectName>/
    const targetDir = path.join(iosRoot, projectName)
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
    const targetFile = path.join(targetDir, 'whistle.wav')
    if (!fs.existsSync(targetFile)) {
      fs.copyFileSync(soundFile, targetFile)
      console.log('✅ Copied whistle.wav to iOS project directory')
    } else {
      console.log('ℹ️  whistle.wav already exists in iOS project directory')
    }

    // 2) Ensure "Resources" group exists and get its UUID
    const xcodeProject = config.modResults
    let resourcesGroup = xcodeProject.pbxGroupByName('Resources')
    if (!resourcesGroup) {
      const newGroup = xcodeProject.addPbxGroup([], 'Resources', 'Resources')
      const mainGroupId = xcodeProject.getFirstProject().firstProject.mainGroup
      xcodeProject.addToPbxGroup(newGroup.uuid, mainGroupId)
      resourcesGroup = xcodeProject.pbxGroupByName('Resources')
      console.log('🧰 Created Resources group in Xcode project')
    }
    const resourcesGroupUuid = resourcesGroup && resourcesGroup.uuid

    // 3) Add resource if not already present, using the GROUP UUID (not the name)
    const firstTarget = xcodeProject.getFirstTarget().uuid

    // Check if already added
    const hasWhistle = Object.values(
      xcodeProject.pbxFileReferenceSection() || {}
    ).some((entry) => entry && entry.path === 'whistle.wav')
    if (hasWhistle) {
      console.log(
        'ℹ️  whistle.wav already referenced in Xcode project; skipping add.'
      )
      return config
    }

    const added = xcodeProject.addResourceFile(
      'whistle.wav',
      { target: firstTarget },
      resourcesGroupUuid // <- ✅ pass UUID, not 'Resources'
    )

    if (added) {
      console.log('✅ Added whistle.wav to Xcode project (Resources group)')
    } else {
      console.warn(
        '⚠️  Could not add whistle.wav to Xcode project (already exists?)'
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
  config = withIOSNotificationSound(config)
  return config
}
