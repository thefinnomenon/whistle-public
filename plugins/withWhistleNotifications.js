const {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  withAppDelegate,
} = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

const copyNativeFile = (projectRoot, srcRelative, destRelative) => {
  const src = path.join(projectRoot, srcRelative)
  const dest = path.join(projectRoot, 'ios', destRelative)
  if (!fs.existsSync(src)) {
    throw new Error(`Missing native file at ${src}`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

const withWhistleNotifications = (config, { postUrl, appGroup }) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.WhistlePostURL = postUrl
    cfg.modResults.WhistleAppGroup = appGroup
    return cfg
  })

  config = withEntitlementsPlist(config, (cfg) => {
    const current =
      cfg.modResults['com.apple.security.application-groups'] || []
    const groups = Array.from(new Set([...(current || []), appGroup]))
    cfg.modResults['com.apple.security.application-groups'] = groups
    return cfg
  })

  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const target = project.getFirstTarget().uuid
    const projectName =
      cfg.modRequest.projectName ||
      project.getFirstProject().firstProject.productName ||
      'WhistleDev'

    // Copy Swift sources into ios/<projectName> so they exist on clean builds
    const projectRoot = cfg.modRequest.projectRoot
    copyNativeFile(
      projectRoot,
      'plugins/WhistleNotificationHandler.swift',
      `${projectName}/WhistleNotificationHandler.swift`
    )

    const ensureSource = (filePath) => {
      const groupKey =
        project.findPBXGroupKey({ name: 'Whistle' }) ||
        project.findPBXGroupKey({ path: 'Whistle' }) ||
        project.findPBXGroupKey({ name: projectName }) ||
        project.findPBXGroupKey({ name: project.productName }) ||
        project.getFirstProject().firstProject.mainGroup
      project.addSourceFile(
        filePath,
        { target, sourceTree: '"<group>"' },
        groupKey
      )
    }

    ensureSource(`${projectName}/WhistleNotificationHandler.swift`)

    return cfg
  })

  // Patch AppDelegate to register categories and handle notification responses natively
  config = withAppDelegate(config, (cfg) => {
    const { modResults } = cfg
    if (modResults.language !== 'swift') {
      return cfg
    }

    let contents = modResults.contents

    // ensure import
    if (!contents.includes('import UserNotifications')) {
      contents = contents.replace(
        /import React\n/,
        'import React\nimport UserNotifications\n'
      )
    }

    // ensure delegate conformance
    contents = contents.replace(
      /class AppDelegate: ExpoAppDelegate/g,
      'class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate'
    )

    // inject delegate setup inside didFinishLaunchingWithOptions
    const didFinishRegex =
      /(didFinishLaunchingWithOptions[^\{]+\{)([\s\S]*?)(let delegate = ReactNativeDelegate\(\))/
    contents = contents.replace(
      didFinishRegex,
      (_match, start, beforeDelegate, delegateLine) => {
        const inject = `\n    UNUserNotificationCenter.current().delegate = self\n    registerWhistleCategories(center: UNUserNotificationCenter.current())\n`
        if (beforeDelegate.includes('registerWhistleCategories')) {
          return `${start}${beforeDelegate}${delegateLine}`
        }
        return `${start}${inject}${beforeDelegate}${delegateLine}`
      }
    )

    // append helper methods if missing
    if (!contents.includes('func registerWhistleCategories')) {
      const helper = `
  private func registerWhistleCategories(center: UNUserNotificationCenter) {
    let yes = UNNotificationAction(identifier: "yes", title: "Yes", options: [])
    let no = UNNotificationAction(identifier: "no", title: "No", options: [])
    let category = UNNotificationCategory(identifier: "question", actions: [yes, no], intentIdentifiers: [], options: [])
    center.setNotificationCategories([category])
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if WhistleNotificationHandler.handle(response: response, completion: completionHandler) {
      return
    }
    completionHandler()
  }

`
      const marker = contents.indexOf('class ReactNativeDelegate')
      const insertPoint =
        marker > -1
          ? contents.lastIndexOf('}', marker)
          : contents.lastIndexOf('}')
      contents =
        contents.slice(0, insertPoint) + helper + contents.slice(insertPoint)
    }

    modResults.contents = contents
    return cfg
  })

  return config
}

module.exports = withWhistleNotifications
