const {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

const withWhistleNotifications = (config, { postUrl, appGroup }) => {
  // Add entries to app Info.plist
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.WhistleAppGroup = appGroup
    cfg.modResults.WhistlePostURL = postUrl
    return cfg
  })

  config = withEntitlementsPlist(config, (cfg) => {
    const current =
      cfg.modResults['com.apple.security.application-groups'] || []
    const groups = Array.from(new Set([...(current || []), appGroup]))
    cfg.modResults['com.apple.security.application-groups'] = groups
    return cfg
  })

  const addNotificationExtension = (cfg) => {
    const project = cfg.modResults
    const projectName = cfg.modRequest.projectName
    const extName = 'WhistleNotificationExtension'
    const extProductName = `${extName}.appex`
    const mainBundleId = cfg.ios?.bundleIdentifier
    const extBundleId = `${mainBundleId}.notificationextension`
    const mainTargetUuid = project.getFirstTarget().uuid

    console.log('Adding notification extension to Xcode project', projectName)

    // Skip if target already exists
    if (project.pbxTargetByName(extName)) {
      return cfg
    }

    const extDir = path.join('ios', projectName, extName)
    const projectRoot = cfg.modRequest.projectRoot
    const srcDir = path.join(projectRoot, extDir)
    fs.mkdirSync(srcDir, { recursive: true })

    const infoPlistPath = path.join(srcDir, 'Info.plist')
    const vcPath = path.join(srcDir, 'NotificationViewController.swift')
    const entitlementsPath = path.join(srcDir, `${extName}.entitlements`)

    const infoPlistContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WhistlePostURL</key>
  <string>${postUrl}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>UNNotificationExtensionCategory</key>
      <string>question</string>
      <key>UNNotificationExtensionDefaultContentHidden</key>
      <true/>
      <key>UNNotificationExtensionInitialContentSizeRatio</key>
      <real>0.5</real>
      <key>UNNotificationExtensionUserInteractionEnabled</key>
      <true/>
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotification.content-extension</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationViewController</string>
  </dict>
</dict>
</plist>
`

    const vcSourcePath = path.join(
      projectRoot,
      'plugins',
      'NotificationViewController.swift'
    )
    if (!fs.existsSync(vcSourcePath)) {
      throw new Error(
        `Missing NotificationViewController.swift at ${vcSourcePath}`
      )
    }
    const vcContents = fs.readFileSync(vcSourcePath, 'utf8')

    const entitlementsContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${appGroup}</string>
  </array>
</dict>
</plist>
`

    fs.writeFileSync(infoPlistPath, infoPlistContents)
    fs.writeFileSync(vcPath, vcContents)
    fs.writeFileSync(entitlementsPath, entitlementsContents)

    const extTarget = project.addTarget(
      extName,
      'app_extension',
      'com.apple.product-type.app-extension',
      extProductName
    )
    const extTargetUuid = extTarget.uuid

    let extGroup = project.findPBXGroupKey({ name: extName })
    if (!extGroup) {
      extGroup = project.addPbxGroup([], extName, `${projectName}/${extName}`)
    }

    const vcRef = path.join(extName, 'NotificationViewController.swift')
    if (!project.hasFile(vcRef)) {
      project.addSourceFile(vcRef, { target: extTargetUuid }, extGroup.uuid)
    }

    project.addBuildProperty(
      'PRODUCT_BUNDLE_IDENTIFIER',
      extBundleId,
      extTargetUuid
    )
    project.addBuildProperty(
      'INFOPLIST_FILE',
      `"${extDir}/Info.plist"`,
      extTargetUuid
    )
    project.addBuildProperty('SWIFT_VERSION', '5.0', extTargetUuid)
    project.addBuildProperty(
      'CODE_SIGN_ENTITLEMENTS',
      `"${extDir}/${extName}.entitlements"`,
      extTargetUuid
    )
    project.addBuildProperty('SKIP_INSTALL', 'YES', extTargetUuid)

    // Embed the extension in the main app target
    let embedPhase = project.buildPhaseObject(
      'PBXCopyFilesBuildPhase',
      mainTargetUuid,
      (phase) => phase.name === '"Embed App Extensions"'
    )
    if (!embedPhase) {
      embedPhase = project.addBuildPhase(
        [],
        'PBXCopyFilesBuildPhase',
        'Embed App Extensions',
        mainTargetUuid,
        'app_extension'
      )
    }
    const embedPhaseUuid = embedPhase?.uuid || embedPhase
    if (embedPhaseUuid) {
      project.addBuildPhaseFile(extProductName, embedPhaseUuid, mainTargetUuid)
    }

    return cfg
  }

  config = withXcodeProject(config, (cfg) => {
    // Add notification content extension target/files
    addNotificationExtension(cfg)

    return cfg
  })

  return config
}

module.exports = withWhistleNotifications
