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
  <key>WhistleAppGroup</key>
  <string>${appGroup}</string>
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
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotification.content-extension</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationViewController</string>
  </dict>
</dict>
</plist>
`

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

    const vcContents = `import UIKit
import UserNotifications
import UserNotificationsUI

class NotificationViewController: UIViewController, UNNotificationContentExtension {
  private let titleLabel = UILabel()
  private let bodyLabel = UILabel()
  private let gridStack = UIStackView()
  private let radialContainer = UIView()
  private let countdownLabel = UILabel()
  private let trackLayer = CAShapeLayer()
  private let progressLayer = CAShapeLayer()
  private var questionId: String?
  private var gameId: String?
  private var countdownTimer: Timer?
  private var timeoutAt: TimeInterval?
  private var totalDurationMs: Double?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    titleLabel.isHidden = true
    bodyLabel.font = .systemFont(ofSize: 18)
    bodyLabel.textAlignment = .center
    bodyLabel.numberOfLines = 0
    gridStack.axis = .vertical
    gridStack.spacing = 8
    gridStack.alignment = .fill
    gridStack.translatesAutoresizingMaskIntoConstraints = false
    setupRadialTimer()

    let stack = UIStackView(arrangedSubviews: [bodyLabel, gridStack])
    stack.axis = .vertical
    stack.spacing = 8
    stack.alignment = .fill
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(radialContainer)
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      radialContainer.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
      radialContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      radialContainer.widthAnchor.constraint(equalToConstant: 72),
      radialContainer.heightAnchor.constraint(equalToConstant: 72),

      stack.topAnchor.constraint(equalTo: radialContainer.bottomAnchor, constant: 12),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
    ])
  }

  func didReceive(_ notification: UNNotification) {
    print("[WhistleExtension] didReceive payload:", notification.request.content.userInfo)
    titleLabel.text = notification.request.content.title
    bodyLabel.text = notification.request.content.body
    questionId = notification.request.content.userInfo["questionId"] as? String
    gameId = notification.request.content.userInfo["gameId"] as? String
    timeoutAt = parseTimeout(notification.request.content.userInfo["timeoutAt"])
    print("[WhistleExtension] parsed timeoutAt ms:", timeoutAt as Any)

    gridStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    choiceButtons.removeAll()

    var choicesArray: [[String: Any]] = []
    if let choicesString = notification.request.content.userInfo["choices"] as? String,
       let data = choicesString.data(using: .utf8),
       let decoded = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
      choicesArray = decoded
    }

    // Build a 2-column grid
    var rowButtons: [UIButton] = []
    for choice in choicesArray {
      guard let id = choice["id"] as? String else { continue }
      let value = (choice["value"] as? String) ?? id
      let button = UIButton(type: .system)
      button.setTitle(value, for: .normal)
      button.titleLabel?.numberOfLines = 1
      button.titleLabel?.font = .boldSystemFont(ofSize: 16)
      button.setTitleColor(.white, for: .normal)
      button.backgroundColor = .systemBlue
      button.layer.cornerRadius = 10
      button.contentEdgeInsets = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
      button.heightAnchor.constraint(equalToConstant: 52).isActive = true
      button.addAction(UIAction(handler: { [weak self, weak button] _ in
        guard let self = self, let button = button else { return }
        self.startSubmitting(chosenButton: button, choiceId: id)
      }), for: .touchUpInside)
      rowButtons.append(button)
      choiceButtons.append(button)
      if rowButtons.count == 2 {
        addRow(with: rowButtons)
        rowButtons.removeAll()
      }
    }
    if !rowButtons.isEmpty {
      addRow(with: rowButtons)
    }
    print("[WhistleExtension] choices parsed:", choicesArray.count)
    if choicesArray.isEmpty {
      let label = UILabel()
      label.text = "No choices available"
      label.textAlignment = .center
      gridStack.addArrangedSubview(label)
    }

    startCountdown()
  }

  private func startSubmitting(chosenButton: UIButton, choiceId: String) {
    // Disable all buttons and show spinner on the chosen one
    choiceButtons.forEach { $0.isEnabled = false; $0.alpha = 0.6 }
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.startAnimating()
    chosenButton.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: chosenButton.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: chosenButton.centerYAnchor),
    ])
    post(choiceId: choiceId)
  }

  private func addRow(with buttons: [UIButton]) {
    let row = UIStackView(arrangedSubviews: buttons)
    row.axis = .horizontal
    row.spacing = 8
    row.distribution = .fillEqually
    gridStack.addArrangedSubview(row)
  }

  private func startCountdown() {
    countdownTimer?.invalidate()
    guard timeoutAt != nil else {
      countdownLabel.text = nil
      return
    }
    totalDurationMs = nil
    updateCountdown()
    countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      self?.updateCountdown()
    }
  }

  private func updateCountdown() {
    guard let timeoutAt = timeoutAt else { return }
    let remaining = timeoutAt - Date().timeIntervalSince1970 * 1000
    if totalDurationMs == nil {
      totalDurationMs = max(remaining, 0)
    }
    if remaining <= 0 {
      countdownLabel.text = "0"
      progressLayer.strokeEnd = 0
      countdownTimer?.invalidate()
      gridStack.isUserInteractionEnabled = false
      gridStack.alpha = 0.5
      dismissAllImmediate()
    } else {
      let seconds = Int(remaining / 1000)
      countdownLabel.text = "\\(seconds)"
      if let total = totalDurationMs, total > 0 {
        let progress = max(0, min(1, remaining / total))
        progressLayer.strokeEnd = CGFloat(progress)
      }
    }
  }

  private func post(choiceId: String) {
    let info = Bundle.main.infoDictionary ?? [:]
    let urlString =
      (info["WhistlePostURL"] as? String) ??
      "https://us-east1-whistle-dev-c5bf9.cloudfunctions.net/submitPredictionFromNotification"
    print("[WhistleExtension] Using WhistlePostURL:", urlString)
    guard
      let url = URL(string: urlString),
      let qId = questionId,
      let gId = gameId
    else {
      print("[WhistleExtension] Missing URL or ids, dismissing")
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    let payload: [String: Any] = [
      "questionId": qId,
      "gameId": gId,
      "prediction": choiceId,
    ]

    let appGroup =
      (info["WhistleAppGroup"] as? String) ?? "${appGroup}"
    if let defaults = UserDefaults(suiteName: appGroup) {
      let authToken = defaults.string(forKey: "WhistleAuthToken")
      print("[WhistleExtension] Defaults found tokenNil=\\(authToken == nil)")
      if let authToken {
        request.setValue("Bearer \\(authToken)", forHTTPHeaderField: "Authorization")
      }
    } else {
      print("[WhistleExtension] Unable to load defaults for appGroup \\(appGroup)")
    }

    if let body = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      request.httpBody = body
    } else {
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    print("[WhistleExtension] Posting choice \\(choiceId) to \\(url)")

    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: request) { data, response, error in
      if let error = error {
        print("[WhistleExtension] POST error:", error.localizedDescription)
      } else if let http = response as? HTTPURLResponse {
        let bodyString = data.flatMap { String(data: $0, encoding: .utf8) } ?? "<nil>"
        print("[WhistleExtension] POST status: \\(http.statusCode) body: \\(bodyString)")
      } else {
        print("[WhistleExtension] POST completed with unknown response")
      }
      self.dismissAll()
    }
    print("[WhistleExtension] Resuming POST task")
    task.resume()
  }

  private func parseTimeout(_ value: Any?) -> TimeInterval? {
    guard let value = value else { return nil }
    if let num = value as? NSNumber {
      return num.doubleValue
    }
    if let str = value as? String, let dbl = Double(str) {
      return dbl
    }
    if let nsStr = value as? NSString {
      return nsStr.doubleValue
    }
    return nil
  }

  private func setupRadialTimer() {
    radialContainer.translatesAutoresizingMaskIntoConstraints = false
    countdownLabel.translatesAutoresizingMaskIntoConstraints = false
    countdownLabel.font = .boldSystemFont(ofSize: 16)
    countdownLabel.textColor = .label
    countdownLabel.textAlignment = .center

    let radius: CGFloat = 30 // 50% bigger
    let centerPoint = CGPoint(x: 36, y: 36)
    let circularPath = UIBezierPath(
      arcCenter: centerPoint,
      radius: radius,
      startAngle: -.pi / 2,
      endAngle: 1.5 * .pi,
      clockwise: true
    )

    trackLayer.path = circularPath.cgPath
    trackLayer.strokeColor = UIColor.systemGray5.cgColor
    trackLayer.fillColor = UIColor.clear.cgColor
    trackLayer.lineWidth = 4
    trackLayer.lineCap = .round

    progressLayer.path = circularPath.cgPath
    progressLayer.strokeColor = UIColor.systemBlue.cgColor
    progressLayer.fillColor = UIColor.clear.cgColor
    progressLayer.lineWidth = 4
    progressLayer.lineCap = .round
    progressLayer.strokeEnd = 1

    radialContainer.layer.addSublayer(trackLayer)
    radialContainer.layer.addSublayer(progressLayer)
    radialContainer.addSubview(countdownLabel)

    NSLayoutConstraint.activate([
      countdownLabel.centerXAnchor.constraint(equalTo: radialContainer.centerXAnchor),
      countdownLabel.centerYAnchor.constraint(equalTo: radialContainer.centerYAnchor),
      countdownLabel.widthAnchor.constraint(equalTo: radialContainer.widthAnchor),
      countdownLabel.heightAnchor.constraint(equalTo: radialContainer.heightAnchor),
    ])
  }

  private func dismissNotification() {
    if let id = notificationId {
      UNUserNotificationCenter.current()
        .removeDeliveredNotifications(withIdentifiers: [id])
    }
  }

  private func dismissAll() {
    DispatchQueue.main.async {
      self.extensionContext?.dismissNotificationContentExtension()
      self.dismissNotification()
    }
  }

  private func dismissAllImmediate() {
    extensionContext?.dismissNotificationContentExtension()
    dismissNotification()
  }
}
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
    const project = cfg.modResults
    const target = project.getFirstTarget().uuid
    const projectName =
      cfg.modRequest.projectName ||
      project.getFirstProject().firstProject.productName ||
      'WhistleDev'

    // Add notification content extension target/files
    addNotificationExtension(cfg)

    return cfg
  })

  // Patch AppDelegate to set delegate and allow foreground presentation (no category registration)
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
      /class AppDelegate: ExpoAppDelegate[^\n]*\n/g,
      'class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {\n'
    )

    // inject delegate setup inside didFinishLaunchingWithOptions
    const didFinishRegex =
      /(didFinishLaunchingWithOptions[^\{]+\{)([\s\S]*?)(let delegate = ReactNativeDelegate\(\))/
    contents = contents.replace(
      didFinishRegex,
      (_match, start, beforeDelegate, delegateLine) => {
        const inject = `\n    let center = UNUserNotificationCenter.current()\n    center.delegate = self\n    center.setNotificationCategories([])\n`
        if (beforeDelegate.includes('registerWhistleCategories')) {
          return `${start}${beforeDelegate}${delegateLine}`
        }
        return `${start}${inject}${beforeDelegate}${delegateLine}`
      }
    )

    // append willPresent if missing
    if (
      !contents.includes(
        'userNotificationCenter(_ center: UNUserNotificationCenter'
      )
    ) {
      const helper = `
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    print("[Whistle] willPresent - allowing banner/list/sound")
    completionHandler([.alert, .banner, .list, .sound, .badge])
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
