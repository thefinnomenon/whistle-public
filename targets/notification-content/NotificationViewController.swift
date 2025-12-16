import UIKit
import UserNotifications
import UserNotificationsUI
import Network

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
  private var notificationId: String?
  private var lastNotificationContent: UNNotificationContent?
  private var countdownTimer: Timer?
  private var timeoutAt: TimeInterval?
  private var totalDurationMs: Double?
  private var choiceButtons: [UIButton] = []
  private var hasExpiredHandled = false
  private var notificationViewedAt: TimeInterval?
  private var notificationSentAt: TimeInterval?
  private var notificationReceivedAt: TimeInterval?
  private let userDefaults: UserDefaults? = {
    guard
      let info = Bundle.main.infoDictionary,
      let appGroup = info["WhistleAppGroup"] as? String,
      !appGroup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return UserDefaults(suiteName: appGroup)
  }()

  private func backendBaseURL() -> URL? {
    guard
      let defaults = userDefaults,
      let domainString = defaults.string(forKey: "WhistleDomain"),
      let domain = URL(string: domainString)
    else { return nil }
    return domain
  }

  private func getNetworkStatus() -> [String: Any] {
    let monitor = NWPathMonitor()
    let path = monitor.currentPath

    var status: [String: Any] = [
      "reachable": path.status == .satisfied,
      "connectionType": "none"
    ]

    if path.status == .satisfied {
      if path.usesInterfaceType(.wifi) {
        status["connectionType"] = "wifi"
      } else if path.usesInterfaceType(.cellular) {
        status["connectionType"] = "cellular"
      } else if path.usesInterfaceType(.wiredEthernet) {
        status["connectionType"] = "ethernet"
      } else {
        status["connectionType"] = "other"
      }
    }

    return status
  }

  private func logError(_ message: String, context: [String: Any] = [:]) {
    guard let base = backendBaseURL() else { return }
    let url = base.appendingPathComponent("api/log/error")

    var mergedContext = context.merging(["source": "ios_notification_content_extension"]) { $1 }
    // Attach notification and device info for richer context
    if let content = lastNotificationContent {
      var notificationContext: [String: Any] = [
        "title": content.title,
        "body": content.body,
        "subtitle": content.subtitle,
        "userInfo": content.userInfo,
        "identifier": notificationId ?? "",
        "categoryIdentifier": content.categoryIdentifier,
        "threadIdentifier": content.threadIdentifier,
        "questionId": questionId ?? "",
        "gameId": gameId ?? "",
      ]

      if #available(iOS 15.0, *) {
        notificationContext["interruptionLevel"] = String(describing: content.interruptionLevel)
        notificationContext["relevanceScore"] = content.relevanceScore
      }

      if #available(iOS 16.0, *) {
        notificationContext["filterCriteria"] = content.filterCriteria ?? ""
      }

      mergedContext["notification"] = notificationContext
    }

    let device = UIDevice.current
    var deviceContext: [String: Any] = [
      "systemName": device.systemName,
      "systemVersion": device.systemVersion,
      "model": device.model,
      "localizedModel": device.localizedModel,
      "name": device.name,
      "identifierForVendor": device.identifierForVendor?.uuidString ?? "",
    ]

    // Battery info
    device.isBatteryMonitoringEnabled = true
    deviceContext["batteryLevel"] = device.batteryLevel
    deviceContext["batteryState"] = String(describing: device.batteryState)

    // Screen info
    let screen = UIScreen.main
    deviceContext["screenBounds"] = [
      "width": screen.bounds.width,
      "height": screen.bounds.height,
    ]
    deviceContext["screenScale"] = screen.scale
    deviceContext["screenNativeScale"] = screen.nativeScale

    // Memory info
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size)/4
    let kerr: kern_return_t = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
      }
    }
    if kerr == KERN_SUCCESS {
      deviceContext["memoryUsageMB"] = Double(info.resident_size) / 1024.0 / 1024.0
    }

    // Locale and timezone
    deviceContext["locale"] = Locale.current.identifier
    deviceContext["timezone"] = TimeZone.current.identifier

    // Network status
    deviceContext["networkStatus"] = getNetworkStatus()

    mergedContext["device"] = deviceContext

    var payload: [String: Any] = [
      "message": message,
      "context": mergedContext,
    ]

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    if let token = userDefaults?.string(forKey: "WhistleAuthToken") {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      request.httpBody = data
    }

    URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
      DispatchQueue.main.async {
        self?.dismissAllImmediate()
      }
    }.resume()
  }

  private func logEvent(_ eventName: String, properties: [String: Any] = [:]) {
    guard let base = backendBaseURL() else { return }
    let url = base.appendingPathComponent("api/log/event")

    var eventProperties = properties
    eventProperties["source"] = "ios_notification_content_extension"
    eventProperties["questionId"] = questionId ?? ""
    eventProperties["gameId"] = gameId ?? ""
    eventProperties["notificationId"] = notificationId ?? ""

    // Add device info
    let device = UIDevice.current
    var deviceContext: [String: Any] = [
      "systemName": device.systemName,
      "systemVersion": device.systemVersion,
      "model": device.model,
      "localizedModel": device.localizedModel,
      "name": device.name,
      "identifierForVendor": device.identifierForVendor?.uuidString ?? "",
    ]

    // Battery info
    device.isBatteryMonitoringEnabled = true
    deviceContext["batteryLevel"] = device.batteryLevel
    deviceContext["batteryState"] = String(describing: device.batteryState)

    // Screen info
    let screen = UIScreen.main
    deviceContext["screenBounds"] = [
      "width": screen.bounds.width,
      "height": screen.bounds.height,
    ]
    deviceContext["screenScale"] = screen.scale
    deviceContext["screenNativeScale"] = screen.nativeScale

    // Memory info
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size)/4
    let kerr: kern_return_t = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
      }
    }
    if kerr == KERN_SUCCESS {
      deviceContext["memoryUsageMB"] = Double(info.resident_size) / 1024.0 / 1024.0
    }

    // Locale and timezone
    deviceContext["locale"] = Locale.current.identifier
    deviceContext["timezone"] = TimeZone.current.identifier

    // Network status
    deviceContext["networkStatus"] = getNetworkStatus()

    eventProperties["device"] = deviceContext

    let payload: [String: Any] = [
      "eventName": eventName,
      "properties": eventProperties,
    ]

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    if let token = userDefaults?.string(forKey: "WhistleAuthToken") {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      request.httpBody = data
    }

    // Use ephemeral session with short timeout to avoid blocking extension
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2
    config.timeoutIntervalForResource = 2

    let session = URLSession(configuration: config)
    session.dataTask(with: request).resume()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    titleLabel.isHidden = true
    bodyLabel.font = .systemFont(ofSize: 18)
    bodyLabel.textAlignment = .center
    bodyLabel.numberOfLines = 0
    gridStack.axis = .vertical
    gridStack.spacing = 16
    gridStack.alignment = .fill
    gridStack.translatesAutoresizingMaskIntoConstraints = false
    setupRadialTimer()

    let stack = UIStackView(arrangedSubviews: [bodyLabel, gridStack])
    stack.axis = .vertical
    stack.spacing = 16
    stack.alignment = .fill
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(radialContainer)
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      radialContainer.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
      radialContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      radialContainer.widthAnchor.constraint(equalToConstant: 72),
      radialContainer.heightAnchor.constraint(equalToConstant: 72),

      stack.topAnchor.constraint(equalTo: radialContainer.bottomAnchor, constant: 16),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -16),
    ])
  }

  func didReceive(_ notification: UNNotification) {
    print("[WhistleExtension] didReceive payload:", notification.request.content.userInfo)
    notificationViewedAt = Date().timeIntervalSince1970 * 1000
    lastNotificationContent = notification.request.content
    titleLabel.text = notification.request.content.title
    bodyLabel.text = notification.request.content.body
    notificationId = notification.request.identifier
    questionId = notification.request.content.userInfo["questionId"] as? String
    gameId = notification.request.content.userInfo["gameId"] as? String
    timeoutAt = parseTimeout(notification.request.content.userInfo["timeoutAt"])
    notificationSentAt = parseTimeout(notification.request.content.userInfo["sentAt"])
    notificationReceivedAt = parseTimeout(notification.request.content.userInfo["notificationReceivedAt"])

    // Track notification viewed event
    var eventProps: [String: Any] = [
      "questionText": notification.request.content.body,
    ]
    if let timeout = timeoutAt {
      eventProps["timeoutAt"] = timeout
      let remaining = timeout - Date().timeIntervalSince1970 * 1000
      eventProps["remainingTimeMs"] = remaining
      eventProps["alreadyExpired"] = remaining <= 0
    }
    logEvent("notification_viewed", properties: eventProps)

    if questionId == nil || gameId == nil {
      logError("Missing questionId or gameId in notification", context: [
        "payload": notification.request.content
      ])
    }

    gridStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    choiceButtons.removeAll()

    var choicesArray: [[String: Any]] = []
    if let choicesString = notification.request.content.userInfo["choices"] as? String,
       let data = choicesString.data(using: .utf8),
       let decoded = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
      choicesArray = decoded
    } else {
      logError("Failed to decode choices", context: [
        "choices": notification.request.content.userInfo["choices"] ?? "nil"
      ])
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
    if choicesArray.isEmpty {
      let label = UILabel()
      label.text = "No choices available"
      label.textAlignment = .center
      gridStack.addArrangedSubview(label)
    }

    // If already expired at open, show closed briefly then dismiss
    if let timeoutAt = timeoutAt {
      let remaining = timeoutAt - Date().timeIntervalSince1970 * 1000
      if remaining <= 0 {
        showClosedAndDismiss()
        return
      }
    }
    
    startCountdown()
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
    if hasExpiredHandled { return }
    guard let timeoutAt = timeoutAt else { return }
    let remaining = timeoutAt - Date().timeIntervalSince1970 * 1000
    if totalDurationMs == nil {
      totalDurationMs = max(remaining, 0)
    }
    if remaining <= 0 {
      handleExpired()
    } else {
      countdownLabel.text = "\(Int(remaining / 1000))"
      if let total = totalDurationMs, total > 0 {
        let progress = max(0, min(1, remaining / total))
        progressLayer.strokeEnd = CGFloat(progress)
      }
    }
  }

  private func startSubmitting(chosenButton: UIButton, choiceId: String) {
    // Disable all buttons and show spinner on the chosen one
    choiceButtons.forEach { $0.isEnabled = false; $0.alpha = 0.6 }
    let spinner = UIActivityIndicatorView(style: .large)
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.startAnimating()
    chosenButton.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: chosenButton.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: chosenButton.centerYAnchor),
    ])
    post(choiceId: choiceId)
  }

  private func post(choiceId: String) {
    guard
      let base = backendBaseURL(),
      let qId = questionId,
      let gId = gameId
    else {
      print("[WhistleExtension] Missing domain or ids, dismissing")
      logError("Missing domain or ids", context: [
        "questionId": questionId ?? "nil",
        "gameId": gameId ?? "nil",
      ])
      return
    }

    let url = base.appendingPathComponent("api/games/\(gId)/questions/\(qId)/prediction")

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    var payload: [String: Any] = [
      "questionId": qId,
      "gameId": gId,
      "prediction": choiceId,
      "source": "ios-notification-content-extension",
    ]

    // Include timestamp of when notification was viewed for response time tracking
    if let viewedAt = notificationViewedAt {
      payload["notificationViewedAt"] = viewedAt
    }

    // Include timestamp of when notification was sent
    if let sentAt = notificationSentAt {
      payload["notificationSentAt"] = sentAt
    }

    // Include timestamp of when notification was received on device
    if let receivedAt = notificationReceivedAt {
      payload["notificationReceivedAt"] = receivedAt
    }

    // Include question timeout for server-side time remaining calculation
    if let timeout = timeoutAt {
      payload["questionTimeoutAt"] = timeout
    }

    let authToken = userDefaults?.string(forKey: "WhistleAuthToken")
    print("[WhistleExtension] Auth token found: \(authToken != nil)")
    if let authToken {
      request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    } else {
      logError("No auth token found")
      return
    }

    if let body = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      request.httpBody = body
    } else {
      logError("Failed to encode payload", context: ["payload": payload])
      return
    }

    print("[WhistleExtension] Posting choice \(choiceId) to \(url)")

    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: request) { data, response, error in
      if let error = error {
        print("[WhistleExtension] POST error:", error.localizedDescription)
        self.logError("Submit prediction error", context: ["error": error.localizedDescription])
        return
      }
      if let http = response as? HTTPURLResponse {
        let bodyString = data.flatMap { String(data: $0, encoding: .utf8) } ?? "<nil>"
        print("[WhistleExtension] POST status: \(http.statusCode) body: \(bodyString)")
        if !(200...299).contains(http.statusCode) {
          self.logError("Submit prediction non-2xx", context: ["status": http.statusCode, "body": bodyString])
          return
        }
        // Success path: dismiss after successful post
        self.dismissAllImmediate()
        return
      }
      print("[WhistleExtension] POST completed with unknown response")
      self.logError("Submit prediction completed with unknown response")
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

  private func dismissAllWithDelay() {
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(2)) {
      self.dismissNotification()
      self.extensionContext?.dismissNotificationContentExtension()
    }
  }

  private func dismissAllImmediate() {
    self.dismissNotification()
    self.extensionContext?.dismissNotificationContentExtension()
  }

  private func handleExpired() {
    if hasExpiredHandled { return }
    hasExpiredHandled = true
    countdownTimer?.invalidate()

    // Track timeout event - expired while user was viewing
    var timeoutProps: [String: Any] = [
      "expiredWhileViewing": true,
      "alreadyExpiredOnOpen": false,
    ]
    if let viewedAt = notificationViewedAt {
      let viewDurationMs = Date().timeIntervalSince1970 * 1000 - viewedAt
      timeoutProps["viewDurationMs"] = viewDurationMs
    }
    logEvent("question_timed_out", properties: timeoutProps)

    dismissAllImmediate()
  }

  private func showClosedAndDismiss() {
    if hasExpiredHandled { return }
    hasExpiredHandled = true
    countdownTimer?.invalidate()
    countdownLabel.text = "0"
    progressLayer.strokeEnd = 0
    gridStack.isUserInteractionEnabled = false
    gridStack.alpha = 0.5
    bodyLabel.text = "Question closed"

    // Track timeout event - already expired when opened
    var timeoutProps: [String: Any] = [
      "expiredWhileViewing": false,
      "alreadyExpiredOnOpen": true,
    ]
    if let timeout = timeoutAt, let viewedAt = notificationViewedAt {
      let expiredForMs = viewedAt - timeout
      timeoutProps["expiredForMs"] = expiredForMs
    }
    logEvent("question_timed_out", properties: timeoutProps)

    dismissAllWithDelay()
  }
}
