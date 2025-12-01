import Foundation
import UserNotifications
import UIKit

struct WhistleConfig {
  let postURL: URL

  static var current: WhistleConfig? {
    guard
      let info = Bundle.main.infoDictionary,
      let urlString = info["WhistlePostURL"] as? String,
      let url = URL(string: urlString)
    else {
      return nil
    }
    return WhistleConfig(postURL: url)
  }
}

enum WhistleAppGroup {
  static var suiteName: String? {
    guard let info = Bundle.main.infoDictionary else { return nil }
    return info["WhistleAppGroup"] as? String
  }

  static var userDefaults: UserDefaults? {
    guard let suite = suiteName else { return nil }
    return UserDefaults(suiteName: suite)
  }
}

public final class WhistleSession {
  static let shared = WhistleSession()

  private init() {
    if let defaults = WhistleAppGroup.userDefaults {
      if let storedUserId = defaults.string(forKey: userIdKey) {
        userId = storedUserId
      }
      if let storedToken = defaults.string(forKey: authTokenKey) {
        authToken = storedToken
      }
    }
  }

  private let userIdKey = "WhistleUserId"
  private let authTokenKey = "WhistleAuthToken"
  private let lastActivityKey = "WhistleLastActivity"

  var userId: String? {
    didSet {
      touchLastActivity()
      if let uid = userId, let defaults = WhistleAppGroup.userDefaults {
        defaults.set(uid, forKey: userIdKey)
      }
    }
  }

  var authToken: String? {
    didSet {
      touchLastActivity()
      if let token = authToken, let defaults = WhistleAppGroup.userDefaults {
        defaults.set(token, forKey: authTokenKey)
      }
    }
  }

  func touchLastActivity() {
    WhistleAppGroup.userDefaults?.set(Date().timeIntervalSince1970, forKey: lastActivityKey)
  }
}

enum WhistleNotificationHandler {
  private class BackgroundPostDelegate: NSObject, URLSessionDataDelegate {
    private var data = Data()
    private let completion: () -> Void
    private let logContext: String

    init(logContext: String, completion: @escaping () -> Void) {
      self.logContext = logContext
      self.completion = completion
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      self.data.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      if let error = error {
        print("[WhistleNotificationHandler] \(logContext) POST failed: \(error)")
      } else if let http = task.response as? HTTPURLResponse {
        let bodyString = String(data: data, encoding: .utf8) ?? "<nil>"
        print("[WhistleNotificationHandler] \(logContext) POST status: \(http.statusCode) body: \(bodyString)")
      } else {
        print("[WhistleNotificationHandler] \(logContext) POST completed with unknown response")
      }
      completion()
    }
  }

  private static func predictionValue(from identifier: String) -> Bool? {
    switch identifier {
    case "yes":
      return true
    case "no":
      return false
    default:
      return nil
    }
  }

  @discardableResult
  static func handle(response: UNNotificationResponse, completion: @escaping () -> Void) -> Bool {
    print("[WhistleNotificationHandler] Received response with actionIdentifier=\(response.actionIdentifier)")
    print("[WhistleNotificationHandler] Category=\(response.notification.request.content.categoryIdentifier)")

    guard response.notification.request.content.categoryIdentifier == "question" else {
      return false
    }

    guard
      let questionId = response.notification.request.content.userInfo["questionId"] as? String,
      let gameId = response.notification.request.content.userInfo["gameId"] as? String,
      let prediction = predictionValue(from: response.actionIdentifier)
    else {
      print("[WhistleNotificationHandler] Missing required fields; userInfo=\(response.notification.request.content.userInfo)")
      completion()
      return false
    }

    guard let config = WhistleConfig.current else {
      print("[WhistleNotificationHandler] Missing WhistleConfig (WhistlePostURL/WhistleAppGroup)")
      completion()
      return false
    }

    let userId = WhistleSession.shared.userId ?? "unknown"
    let authToken = WhistleSession.shared.authToken

    print("[WhistleNotificationHandler] Posting prediction for gameId=\(gameId) questionId=\(questionId) prediction=\(prediction) userId=\(userId) hasToken=\(authToken != nil)")

    postPrediction(
      url: config.postURL,
      questionId: questionId,
      gameId: gameId,
      prediction: prediction,
      userId: userId,
      authToken: authToken,
      completion: completion
    )

    return true
  }

  private static func postPrediction(
    url: URL,
    questionId: String,
    gameId: String,
    prediction: Bool,
    userId: String,
    authToken: String?,
    completion: @escaping () -> Void
  ) {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = authToken {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    let payload: [String: Any] = [
      "questionId": questionId,
      "gameId": gameId,
      "prediction": prediction,
      "userId": userId,
      "source": "ios_notification",
    ]

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])
    } catch {
      print("[WhistleNotificationHandler] Failed to serialize payload: \(error)")
      completion()
      return
    }

    print("[WhistleNotificationHandler] POSTing to \(url.absoluteString)")
    let identifier = "com.finnternet.whistle.bgpost.\(UUID().uuidString)"
    let config = URLSessionConfiguration.background(withIdentifier: identifier)
    config.sharedContainerIdentifier = WhistleAppGroup.suiteName
    config.waitsForConnectivity = false
    config.isDiscretionary = false
    config.allowsCellularAccess = true

    let delegate = BackgroundPostDelegate(logContext: identifier, completion: completion)
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: request)
    task.resume()
  }
}
