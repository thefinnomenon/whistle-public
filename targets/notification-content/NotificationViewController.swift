import UIKit
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
  private var notificationId: String?
  private var countdownTimer: Timer?
  private var timeoutAt: TimeInterval?
  private var totalDurationMs: Double?
  private var choiceButtons: [UIButton] = []
  private var hasExpiredHandled = false

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
    titleLabel.text = notification.request.content.title
    bodyLabel.text = notification.request.content.body
    notificationId = notification.request.identifier
    questionId = notification.request.content.userInfo["questionId"] as? String
    gameId = notification.request.content.userInfo["gameId"] as? String
    timeoutAt = parseTimeout(notification.request.content.userInfo["timeoutAt"])

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
    let info = Bundle.main.infoDictionary ?? [:]
    guard
      let appGroup = info["WhistleAppGroup"] as? String,
      !appGroup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      print("[WhistleExtension] Missing WhistleAppGroup in plist")
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    guard let defaults = UserDefaults(suiteName: appGroup) else {
      print("[WhistleExtension] Unable to load defaults for appGroup \(appGroup)")
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    guard
      let urlString = defaults.string(forKey: "WhistlePostURL")?.trimmingCharacters(in: .whitespacesAndNewlines),
      !urlString.isEmpty
    else {
      print("[WhistleExtension] Missing WhistlePostURL in defaults for group \(appGroup)")
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    print("[WhistleExtension] App group:", appGroup)
    print("[WhistleExtension] WhistlePostURL (defaults):", urlString)
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

    let authToken = defaults.string(forKey: "WhistleAuthToken")
    print("[WhistleExtension] Defaults found tokenNil=\(authToken == nil)")
    if let authToken {
      request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    }

    if let body = try? JSONSerialization.data(withJSONObject: payload, options: []) {
      request.httpBody = body
    } else {
      extensionContext?.dismissNotificationContentExtension()
      return
    }

    print("[WhistleExtension] Posting choice \(choiceId) to \(url)")

    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: request) { data, response, error in
      if let error = error {
        print("[WhistleExtension] POST error:", error.localizedDescription)
      } else if let http = response as? HTTPURLResponse {
        let bodyString = data.flatMap { String(data: $0, encoding: .utf8) } ?? "<nil>"
        print("[WhistleExtension] POST status: \(http.statusCode) body: \(bodyString)")
      } else {
        print("[WhistleExtension] POST completed with unknown response")
      }
      self.dismissAllImmediate()
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
    dismissAllWithDelay()
  }
}
