import UserNotifications
import Network
import UIKit

class NotificationService: UNNotificationServiceExtension {
  var contentHandler: ((UNNotificationContent) -> Void)?
  var bestAttemptContent: UNMutableNotificationContent?

  private let userDefaults: UserDefaults? = {
    guard
      let info = Bundle.main.infoDictionary,
      let appGroup = info["WhistleAppGroup"] as? String,
      !appGroup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return UserDefaults(suiteName: appGroup)
  }()

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.contentHandler = contentHandler
    bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

    if let bestAttemptContent = bestAttemptContent {
      let notificationDisplayedAt = Date().timeIntervalSince1970 * 1000

      // Add notificationDisplayedAt to the notification payload
      bestAttemptContent.userInfo["notificationDisplayedAt"] = notificationDisplayedAt

      // Log notification displayed event
      logEvent(
        "notification_displayed",
        properties: [
          "notificationDisplayedAt": notificationDisplayedAt,
          "questionId": request.content.userInfo["questionId"] ?? "",
          "gameId": request.content.userInfo["gameId"] ?? "",
          "notificationId": request.identifier,
        ]
      )

      contentHandler(bestAttemptContent)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
      contentHandler(bestAttemptContent)
    }
  }

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
    let queue = DispatchQueue(label: "whistle.nwpath.service")
    let group = DispatchGroup()
    var path = monitor.currentPath

    group.enter()
    monitor.pathUpdateHandler = { update in
      path = update
      group.leave()
    }
    monitor.start(queue: queue)
    _ = group.wait(timeout: .now() + 0.2)
    monitor.cancel()

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

  private func logEvent(_ eventName: String, properties: [String: Any] = [:]) {
    guard let base = backendBaseURL() else { return }
    let url = base.appendingPathComponent("api/log/event")

    var eventProperties = properties
    eventProperties["source"] = "ios-notification-service-extension"

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
    deviceContext["batteryState"] = batteryStateString(device.batteryState)

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

  private func batteryStateString(_ state: UIDevice.BatteryState) -> String {
    switch state {
    case .unknown:
      return "unknown"
    case .unplugged:
      return "unplugged"
    case .charging:
      return "charging"
    case .full:
      return "full"
    @unknown default:
      return "unknown"
    }
  }
}
