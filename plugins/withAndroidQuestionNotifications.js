const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
} = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

const RECEIVER_CLASS = 'QuestionActionReceiver'
const SERVICE_CLASS = 'QuestionMessagingService'
const AUTH_CONFIG_MODULE = 'AuthConfigModule'
const AUTH_CONFIG_PACKAGE = 'AuthConfigPackage'

const timerDrawable = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@android:id/progress">
        <rotate
            android:fromDegrees="-90"
            android:toDegrees="-90"
            android:pivotX="50%"
            android:pivotY="50%">
            <shape
                android:shape="ring"
                android:innerRadiusRatio="2.3"
                android:thickness="3dp"
                android:useLevel="true">
                <solid android:color="#2563EB" />
            </shape>
        </rotate>
    </item>
</layer-list>
`

const notificationLayout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:paddingTop="12dp"
    android:paddingBottom="12dp"
    android:paddingEnd="24dp"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:gravity="center_horizontal">

    <RelativeLayout
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_gravity="center_horizontal"
        android:gravity="center">

        <ProgressBar
            android:id="@+id/timer_ring"
            style="@android:style/Widget.ProgressBar.Horizontal"
            android:layout_width="64dp"
        android:layout_height="64dp"
        android:indeterminate="false"
        android:max="100"
        android:progress="100"
        android:progressDrawable="@drawable/timer_ring_drawable" />

        <TextView
            android:id="@+id/timer_text"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_centerInParent="true"
        android:text=""
        android:textSize="16sp"
        android:textColor="@android:color/black"
        android:textStyle="bold"
        android:gravity="center"
        android:includeFontPadding="false" />

    </RelativeLayout>

    <TextView
        android:id="@+id/question_text"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_gravity="center_horizontal"
        android:gravity="center"
        android:textColor="@android:color/black"
        android:textSize="16sp"
        android:textStyle="bold"
        android:maxLines="3"
        android:ellipsize="end"
        android:paddingTop="8dp"
        android:paddingBottom="12dp" />

    <LinearLayout
        android:id="@+id/choices_container"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:gravity="center"
        android:paddingTop="4dp"/>

</LinearLayout>
`

const templateAuthConfigModule = (pkg) => `package ${pkg}

import android.content.Context
import android.content.SharedPreferences
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ${AUTH_CONFIG_MODULE}(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val prefs: SharedPreferences =
    reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  override fun getName(): String = "AuthConfig"

  @ReactMethod
  fun setDomain(domain: String) {
    prefs.edit()
      .putString(KEY_DOMAIN, domain)
      .apply()
  }

  @ReactMethod
  fun setSession(token: String) {
    prefs.edit()
      .putString(KEY_TOKEN, token)
      .apply()
  }

  companion object {
    const val PREFS_NAME = "whistle_auth"
    const val KEY_DOMAIN = "domain"
    const val KEY_TOKEN = "userToken"
  }
}
`

const templateAuthConfigPackage = (pkg) => `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ${AUTH_CONFIG_PACKAGE} : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(${AUTH_CONFIG_MODULE}(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`

const templateQuestionActionReceiver = (pkg) => `package ${pkg}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.concurrent.thread

class ${RECEIVER_CLASS} : BroadcastReceiver() {
  private val client = OkHttpClient()

  override fun onReceive(context: Context, intent: Intent) {
    val result = goAsync()
    thread {
      try {
        handleReceive(context, intent)
      } finally {
        result.finish()
      }
    }
  }

  private fun handleReceive(context: Context, intent: Intent) {
    val gameId = intent.getStringExtra("gameId") ?: return
    val questionId = intent.getStringExtra("questionId") ?: return
    val choiceId = intent.getStringExtra("choiceId") ?: return
    val timeoutAt = intent.getStringExtra("timeoutAt")?.toLongOrNull()
    val receivedAt = intent.getStringExtra("receivedAt")?.toLongOrNull()
    val sentAt = intent.getStringExtra("sentAt")?.toLongOrNull()
    val buttonIndex = intent.getIntExtra("buttonIndex", -1)
    val questionText = intent.getStringExtra("questionText") ?: ""
    val choicesJson = intent.getStringExtra("choicesJson") ?: "[]"
    val notificationId = intent.getIntExtra("notificationId", questionId.hashCode())
    val collapsedTitle = intent.getStringExtra("collapsedTitle") ?: "Question"
    val notificationDisplayedAt = intent.getStringExtra("notificationDisplayedAt")?.toLongOrNull()
    val questionPayload = intent.getStringExtra("questionPayload")
    val questionSignature = intent.getStringExtra("questionSignature")
    val prefs = context.getSharedPreferences(${AUTH_CONFIG_MODULE}.PREFS_NAME, Context.MODE_PRIVATE)
    val token = prefs.getString(${AUTH_CONFIG_MODULE}.KEY_TOKEN, null)
    val domain = prefs.getString(${AUTH_CONFIG_MODULE}.KEY_DOMAIN, null)
    val choiceTappedAt = System.currentTimeMillis()
    val notificationViewedAt = System.currentTimeMillis()

    if (timeoutAt != null && System.currentTimeMillis() > timeoutAt) {
      Log.w("QuestionAction", "Question already expired, skipping submit")
      logEvent(context, domain, token, "notification_prediction_skipped", mapOf(
        "reason" to "expired",
        "questionId" to questionId,
        "gameId" to gameId,
        "timeoutAt" to timeoutAt,
        "receivedAt" to receivedAt,
        "sentAt" to sentAt
      ))
      return
    }

    if (domain.isNullOrEmpty()) {
      Log.e("QuestionAction", "Missing domain")
      return
    }

    try {
      // Update UI: disable buttons and show spinner on selected
      val contentView = RemoteViews(context.packageName, R.layout.notification_question)
      val isDark =
        (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      applyThemeToRemoteViews(contentView, isDark, context)
      contentView.setTextViewText(R.id.question_text, questionText)
      val choices = parseChoices(choicesJson)
      contentView.removeAllViews(R.id.choices_container)
      choices.chunked(2).forEachIndexed { chunkIndex, chunk ->
        if (chunk.size == 1) {
          val single = RemoteViews(context.packageName, R.layout.notification_choice_single)
          val left = chunk[0]
          single.setTextViewText(R.id.choice_button_single, left.second)
          single.setBoolean(R.id.choice_button_single, "setEnabled", false)
          single.setViewVisibility(R.id.choice_progress_single, if (chunkIndex * 2 == buttonIndex) View.VISIBLE else View.GONE)
          contentView.addView(R.id.choices_container, single)
        } else {
          val row = RemoteViews(context.packageName, R.layout.notification_choice_row)
          val left = chunk[0]
          row.setViewVisibility(R.id.choice_left_container, View.VISIBLE)
          row.setTextViewText(R.id.choice_button_left, left.second)
          row.setBoolean(R.id.choice_button_left, "setEnabled", false)
          row.setViewVisibility(R.id.choice_progress_left, if (chunkIndex * 2 == buttonIndex) View.VISIBLE else View.GONE)

          val right = chunk[1]
          row.setViewVisibility(R.id.choice_right_container, View.VISIBLE)
          row.setTextViewText(R.id.choice_button_right, right.second)
          row.setBoolean(R.id.choice_button_right, "setEnabled", false)
          row.setViewVisibility(R.id.choice_progress_right, if (chunkIndex * 2 + 1 == buttonIndex) View.VISIBLE else View.GONE)

          contentView.addView(R.id.choices_container, row)
        }
      }

      val builder = NotificationCompat.Builder(context, "questions")
        .setSmallIcon(R.drawable.ic_small_icon)
        .setColor(ContextCompat.getColor(context, android.R.color.black))
        .setColorized(true)
        .setContentTitle(collapsedTitle)
        .setCustomBigContentView(contentView)
        .setStyle(NotificationCompat.DecoratedCustomViewStyle())
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)

      NotificationManagerCompat.from(context).notify(notificationId, builder.build())

      val json = JSONObject()
      json.put("prediction", choiceId)
      json.put("source", "android_notification")
      if (timeoutAt != null) json.put("questionTimeoutAt", timeoutAt)
      json.put("choiceTappedAt", choiceTappedAt)
      if (notificationDisplayedAt != null) json.put("notificationDisplayedAt", notificationDisplayedAt)
      json.put("notificationViewedAt", notificationDisplayedAt) // Expansion time not detectable; reuse displayed
      val predictionSentAt = System.currentTimeMillis()
      json.put("predictionSentAt", predictionSentAt)
      if (!questionPayload.isNullOrEmpty()) json.put("questionPayload", questionPayload)
      if (!questionSignature.isNullOrEmpty()) json.put("questionSignature", questionSignature)
      val body = json.toString().toRequestBody("application/json".toMediaType())
      val reqBuilder = Request.Builder()
        .url("$domain/api/games/$gameId/questions/$questionId/prediction")
        .post(body)
        .addHeader("Content-Type", "application/json")
      if (!token.isNullOrEmpty()) {
        reqBuilder.addHeader("Authorization", "Bearer $token")
      }

      logEvent(context, domain, token, "notification_viewed", mapOf(
        "questionId" to questionId,
        "gameId" to gameId,
        "notificationViewedAt" to notificationDisplayedAt, // Same as displayed; expansion time not detectable
        "notificationDisplayedAt" to notificationDisplayedAt,
        "receivedAt" to receivedAt,
        "sentAt" to sentAt
      ))

      val resp = client.newCall(reqBuilder.build()).execute()
      if (!resp.isSuccessful) {
        Log.e("QuestionAction", "Submit failed: ${'$'}{resp.code}")
        logError(context, domain, token, "notification_prediction_submit_failed", mapOf(
          "status" to resp.code,
          "questionId" to questionId,
          "gameId" to gameId,
          "receivedAt" to receivedAt,
          "sentAt" to sentAt,
          "notificationDisplayedAt" to notificationDisplayedAt,
          "notificationViewedAt" to notificationViewedAt,
          "choiceTappedAt" to choiceTappedAt,
          "predictionSentAt" to predictionSentAt
        ))
      } else {
        Log.d("QuestionAction", "Submit success")
        NotificationManagerCompat.from(context).cancel(questionId.hashCode())
      logEvent(context, domain, token, "notification_prediction_submitted", mapOf(
        "questionId" to questionId,
        "gameId" to gameId,
        "timeoutAt" to timeoutAt,
        "receivedAt" to receivedAt,
        "sentAt" to sentAt,
        "notificationDisplayedAt" to notificationDisplayedAt,
        "notificationViewedAt" to notificationViewedAt,
        "choiceTappedAt" to choiceTappedAt,
        "predictionSentAt" to predictionSentAt
      ))
      }
      resp.close()
    } catch (e: Exception) {
      Log.e("QuestionAction", "Error submitting prediction", e)
      logError(context, domain, token, "notification_prediction_exception", mapOf(
        "message" to (e.message ?: "unknown"),
        "questionId" to questionId,
        "gameId" to gameId,
        "receivedAt" to receivedAt,
        "sentAt" to sentAt,
          "notificationDisplayedAt" to notificationDisplayedAt,
          "notificationViewedAt" to notificationViewedAt,
          "choiceTappedAt" to choiceTappedAt
        ))
    }
  }

  private fun applyThemeToRemoteViews(remoteViews: RemoteViews, isDark: Boolean, context: Context) {
    val textColorRes = if (isDark) android.R.color.white else android.R.color.black
    val color = ContextCompat.getColor(context, textColorRes)
    remoteViews.setTextColor(R.id.question_text, color)
    remoteViews.setTextColor(R.id.timer_text, color)
  }

  private fun logEvent(context: Context, domain: String?, token: String?, eventName: String, properties: Map<String, Any?>) {
    if (domain.isNullOrEmpty()) return
    try {
      val url = "$domain/api/log/event"
      val payload = JSONObject()
      payload.put("eventName", eventName)
      val propsJson = JSONObject()
      properties.forEach { (k, v) ->
        if (v != null) propsJson.put(k, v)
      }
      propsJson.put("device", getDeviceInfo(context))
      propsJson.put("source", "android_notification_service")
      payload.put("properties", propsJson)

      val body = payload.toString().toRequestBody("application/json".toMediaType())
      val reqBuilder = Request.Builder()
        .url(url)
        .post(body)
        .addHeader("Content-Type", "application/json")
      if (!token.isNullOrEmpty()) {
        reqBuilder.addHeader("Authorization", "Bearer $token")
      }
      client.newCall(reqBuilder.build()).execute().close()
    } catch (_: Exception) {
    }
  }

  private fun logError(contextObj: Context, domain: String?, token: String?, message: String, context: Map<String, Any?> = emptyMap()) {
    if (domain.isNullOrEmpty()) return
    try {
      val url = "$domain/api/log/error"
      val payload = JSONObject()
      payload.put("message", message)
      val ctx = JSONObject()
      context.forEach { (k, v) ->
        if (v != null) ctx.put(k, v)
      }
      ctx.put("device", getDeviceInfo(contextObj))
      ctx.put("source", "android_notification_service")
      payload.put("context", ctx)

      val body = payload.toString().toRequestBody("application/json".toMediaType())
      val reqBuilder = Request.Builder()
        .url(url)
        .post(body)
        .addHeader("Content-Type", "application/json")
      if (!token.isNullOrEmpty()) {
        reqBuilder.addHeader("Authorization", "Bearer $token")
      }
      client.newCall(reqBuilder.build()).execute().close()
    } catch (_: Exception) {
    }
  }

  private fun getDeviceInfo(context: Context): JSONObject {
    val device = JSONObject()
    try {
      val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
      val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val pct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()) else null
      device.put("batteryLevel", pct)
      device.put("batteryState", when (status) {
        BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
        BatteryManager.BATTERY_STATUS_FULL -> "full"
        BatteryManager.BATTERY_STATUS_DISCHARGING -> "unplugged"
        BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
        else -> "unknown"
      })
    } catch (_: Exception) {
    }

    try {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val active = cm.activeNetwork
      val caps = cm.getNetworkCapabilities(active)
      val reachable = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
      val connectionType = when {
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
        reachable -> "other"
        else -> "none"
      }
      val network = JSONObject()
      network.put("reachable", reachable)
      network.put("connectionType", connectionType)
      device.put("networkStatus", network)
    } catch (_: Exception) {
    }

    try {
      device.put("manufacturer", android.os.Build.MANUFACTURER)
      device.put("model", android.os.Build.MODEL)
      device.put("device", android.os.Build.DEVICE)
      device.put("brand", android.os.Build.BRAND)
      device.put("osVersion", android.os.Build.VERSION.RELEASE)
      device.put("sdkInt", android.os.Build.VERSION.SDK_INT)
    } catch (_: Exception) {
    }

    return device
  }

  private fun parseChoices(json: String): List<Pair<String, String>> {
    return try {
      val arr = org.json.JSONArray(json)
      (0 until arr.length()).map { idx ->
        val obj = arr.getJSONObject(idx)
        val id = obj.optString("id", obj.optString("value", ""))
        val value = obj.optString("value", id)
        id to value
      }
    } catch (e: Exception) {
      listOf("yes" to "Yes", "no" to "No")
    }
  }
}
`

const templateQuestionMessagingService = (pkg) => `package ${pkg}

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.media.AudioAttributes
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import android.service.notification.StatusBarNotification
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.concurrent.thread

class ${SERVICE_CLASS} : FirebaseMessagingService() {
  private val client = OkHttpClient()

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] != "question") return

    val now = System.currentTimeMillis()
    val gameId = data["gameId"] ?: return
    val questionId = data["questionId"] ?: return
    val question = data["question"] ?: "Question"
    val timeoutAt = data["timeoutAt"]?.toLongOrNull() ?: 0L

    val prefs = getSharedPreferences(${AUTH_CONFIG_MODULE}.PREFS_NAME, Context.MODE_PRIVATE)
    val domain = prefs.getString(${AUTH_CONFIG_MODULE}.KEY_DOMAIN, null)
    val userToken = prefs.getString(${AUTH_CONFIG_MODULE}.KEY_TOKEN, null) ?: ""
    if (domain.isNullOrEmpty()) return

    val choicesJson = data["choices"] ?: ""
    val choices = parseChoices(choicesJson, domain, userToken)
    val sentAt = data["sentAt"]?.toLongOrNull()
    val notificationDisplayedAt = System.currentTimeMillis()
    val questionPayload = data["questionPayload"]
    val questionSignature = data["questionSignature"]
    val receivedAt = now
    val notificationId = questionId.hashCode()
    val sound = Uri.parse("android.resource://$packageName/raw/whistle")
    val collapsedTitle = if (gameId == "onboarding") "Expand to answer!" else (message.notification?.title ?: question)

    ensureChannel()
    val contentView = RemoteViews(packageName, R.layout.notification_question)
    val isDark = isDarkModeEnabled()
    applyThemeToRemoteViews(contentView, isDark)
    contentView.setTextViewText(R.id.question_text, question)

    // Bind up to 3 choices for now
    contentView.removeAllViews(R.id.choices_container)
    choices.chunked(2).forEachIndexed { chunkIndex, chunk ->
      if (chunk.size == 1) {
        val single = RemoteViews(packageName, R.layout.notification_choice_single)
        val left = chunk[0]
        single.setTextViewText(R.id.choice_button_single, left.second)
        single.setBoolean(R.id.choice_button_single, "setEnabled", true)
        single.setViewVisibility(R.id.choice_progress_single, View.GONE)
        single.setOnClickPendingIntent(
          R.id.choice_button_single,
          buildActionIntent(
            this,
            gameId,
            questionId,
            left.first,
            timeoutAt.toString(),
            domain,
            userToken,
            receivedAt,
            sentAt,
            chunkIndex * 2,
            question,
            choicesJson,
            notificationId,
            collapsedTitle,
            notificationDisplayedAt,
            questionPayload,
            questionSignature
          )
        )
        contentView.addView(R.id.choices_container, single)
      } else {
        val row = RemoteViews(packageName, R.layout.notification_choice_row)
        val left = chunk[0]
        row.setViewVisibility(R.id.choice_left_container, View.VISIBLE)
        row.setTextViewText(R.id.choice_button_left, left.second)
        row.setBoolean(R.id.choice_button_left, "setEnabled", true)
        row.setViewVisibility(R.id.choice_progress_left, View.GONE)
        row.setOnClickPendingIntent(
          R.id.choice_button_left,
          buildActionIntent(
            this,
            gameId,
            questionId,
            left.first,
            timeoutAt.toString(),
            domain,
            userToken,
            receivedAt,
            sentAt,
            chunkIndex * 2,
            question,
            choicesJson,
            notificationId,
            collapsedTitle,
            notificationDisplayedAt,
            questionPayload,
            questionSignature
          )
        )

        val right = chunk[1]
        row.setViewVisibility(R.id.choice_right_container, View.VISIBLE)
        row.setTextViewText(R.id.choice_button_right, right.second)
        row.setBoolean(R.id.choice_button_right, "setEnabled", true)
        row.setViewVisibility(R.id.choice_progress_right, View.GONE)
        row.setOnClickPendingIntent(
          R.id.choice_button_right,
          buildActionIntent(
            this,
            gameId,
            questionId,
            right.first,
            timeoutAt.toString(),
            domain,
            userToken,
            receivedAt,
            sentAt,
            chunkIndex * 2 + 1,
            question,
            choicesJson,
            notificationId,
            collapsedTitle,
            notificationDisplayedAt,
            questionPayload,
            questionSignature
          )
        )
        contentView.addView(R.id.choices_container, row)
      }
    }

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_small_icon)
      .setColor(ContextCompat.getColor(this, android.R.color.black))
      .setColorized(true)
      .setContentTitle(collapsedTitle)
      .setContentText(message.notification?.body ?: "")
      .setCustomBigContentView(contentView)
      .setStyle(NotificationCompat.DecoratedCustomViewStyle())
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setSound(sound)

    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(notificationId, builder.build())
    scheduleAutoCancel(manager, notificationId, timeoutAt)

    val initialRemaining = timeoutAt - now
    logEvent(this, domain, userToken, "notification_displayed", mapOf(
      "questionText" to question,
      "timeoutAt" to timeoutAt,
      "remainingTimeMs" to initialRemaining,
      "alreadyExpired" to (initialRemaining <= 0),
      "sentAt" to sentAt,
      "notificationDisplayedAt" to notificationDisplayedAt,
      "receivedAt" to receivedAt,
      "questionId" to questionId,
      "gameId" to gameId
    ))

    // Start countdown to update radial timer
    if (timeoutAt > 0) {
      val totalMs = timeoutAt - System.currentTimeMillis()
      if (totalMs > 0) {
        contentView.setViewVisibility(R.id.timer_ring, View.VISIBLE)
        contentView.setViewVisibility(R.id.timer_text, View.VISIBLE)
        val initialSeconds = (totalMs / 1000).toInt().coerceAtLeast(0)
        contentView.setTextViewText(R.id.timer_text, initialSeconds.toString())
        contentView.setProgressBar(R.id.timer_ring, 100, 100, false)
        manager.notify(notificationId, builder.build())
        thread(name = "whistle-timer-$questionId") {
          var remaining = totalMs
          while (remaining > 0) {
            if (!isNotificationActive(manager, notificationId)) {
              return@thread
            }
            val percent = ((remaining.toFloat() / totalMs) * 100).toInt().coerceIn(0, 100)
            contentView.setProgressBar(R.id.timer_ring, 100, percent, false)
            val seconds = (remaining / 1000).toInt().coerceAtLeast(0)
            contentView.setTextViewText(R.id.timer_text, seconds.toString())
            manager.notify(notificationId, builder.build())
            try {
              Thread.sleep(1000)
            } catch (_: InterruptedException) {
              return@thread
            }
            remaining -= 1000
          }
          if (isNotificationActive(manager, notificationId)) {
            contentView.setProgressBar(R.id.timer_ring, 100, 0, false)
            contentView.setTextViewText(R.id.timer_text, "0")
            manager.notify(notificationId, builder.build())
            logEvent(this@${SERVICE_CLASS}, domain, userToken, "question_timed_out", mapOf(
              "timeoutAt" to timeoutAt,
              "timedOutAt" to System.currentTimeMillis(),
              "questionId" to questionId,
              "gameId" to gameId,
              "sentAt" to sentAt,
              "notificationDisplayedAt" to notificationDisplayedAt,
              "receivedAt" to receivedAt
            ))
          }
        }
      } else {
        contentView.setViewVisibility(R.id.timer_ring, View.GONE)
        contentView.setViewVisibility(R.id.timer_text, View.GONE)
        manager.notify(notificationId, builder.build())
      }
    } else {
      contentView.setViewVisibility(R.id.timer_ring, View.GONE)
      contentView.setViewVisibility(R.id.timer_text, View.GONE)
      manager.notify(notificationId, builder.build())
    }
  }

private fun buildActionIntent(
    context: Context,
    gameId: String,
    questionId: String,
    choiceId: String,
    timeoutAt: String,
    domain: String,
    userToken: String,
    receivedAt: Long,
    sentAt: Long?,
    buttonIndex: Int,
    questionText: String,
    choicesJson: String,
    notificationId: Int,
    collapsedTitle: String,
    notificationDisplayedAt: Long,
    questionPayload: String?,
    questionSignature: String?
  ): PendingIntent {
    val intent = Intent(context, ${RECEIVER_CLASS}::class.java).apply {
      putExtra("gameId", gameId)
      putExtra("questionId", questionId)
      putExtra("choiceId", choiceId)
      putExtra("timeoutAt", timeoutAt)
      putExtra("domain", domain)
      putExtra("userToken", userToken)
      putExtra("receivedAt", receivedAt.toString())
      if (sentAt != null) {
        putExtra("sentAt", sentAt.toString())
      }
      putExtra("buttonIndex", buttonIndex)
      putExtra("questionText", questionText)
      putExtra("choicesJson", choicesJson)
      putExtra("notificationId", notificationId)
      putExtra("collapsedTitle", collapsedTitle)
      putExtra("notificationDisplayedAt", notificationDisplayedAt.toString())
      if (!questionPayload.isNullOrEmpty()) {
        putExtra("questionPayload", questionPayload)
      }
      if (!questionSignature.isNullOrEmpty()) {
        putExtra("questionSignature", questionSignature)
      }
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    return PendingIntent.getBroadcast(context, (gameId + questionId + choiceId).hashCode(), intent, flags)
  }

  private fun parseChoices(json: String, domain: String, token: String?): List<Pair<String, String>> {
    // Expect JSON array of objects with id/value
    return try {
      val arr = org.json.JSONArray(json)
      (0 until arr.length()).map { idx ->
        val obj = arr.getJSONObject(idx)
        val id = obj.optString("id", obj.optString("value", ""))
        val value = obj.optString("value", id)
        id to value
      }
    } catch (e: Exception) {
      logError(this, domain, token, "Failed to parse choices", mapOf("raw" to json))
      listOf("yes" to "Yes", "no" to "No")
    }
  }

  private fun applyThemeToRemoteViews(remoteViews: RemoteViews, isDark: Boolean) {
    val textColorRes = if (isDark) android.R.color.white else android.R.color.black
    val color = ContextCompat.getColor(this, textColorRes)
    remoteViews.setTextColor(R.id.question_text, color)
    remoteViews.setTextColor(R.id.timer_text, color)
  }

  private fun isDarkModeEnabled(): Boolean {
    val uiMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    if (uiMode == Configuration.UI_MODE_NIGHT_YES) return true
    if (uiMode == Configuration.UI_MODE_NIGHT_NO) return false
    val uiModeManager = getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager
    return uiModeManager?.nightMode == android.app.UiModeManager.MODE_NIGHT_YES
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val sound = Uri.parse("android.resource://$packageName/raw/whistle")
      val audioAttrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Questions",
        NotificationManager.IMPORTANCE_HIGH
      )
      channel.setSound(sound, audioAttrs)
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.createNotificationChannel(channel)
    }
  }

  private fun isNotificationActive(manager: NotificationManager, id: Int): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      manager.activeNotifications.any { it.id == id }
    } else {
      true
    }
  }

  private fun scheduleAutoCancel(manager: NotificationManager, notificationId: Int, timeoutAt: Long) {
    if (timeoutAt <= 0) return
    val delay = timeoutAt - System.currentTimeMillis()
    if (delay <= 0) {
      manager.cancel(notificationId)
      return
    }
    thread(name = "whistle-autocancel-$notificationId") {
      try {
        Thread.sleep(delay)
      } catch (_: InterruptedException) {
        return@thread
      }
      manager.cancel(notificationId)
    }
  }

  companion object {
    private const val CHANNEL_ID = "questions"
  }

  private fun logEvent(context: Context, domain: String?, token: String?, eventName: String, properties: Map<String, Any?>) {
    if (domain.isNullOrEmpty()) return
    try {
      val url = "$domain/api/log/event"
      val payload = JSONObject()
      payload.put("eventName", eventName)
      val propsJson = JSONObject()
      properties.forEach { (k, v) ->
        if (v != null) propsJson.put(k, v)
      }
      propsJson.put("device", getDeviceInfo(context))
      propsJson.put("source", "android_notification_service")
      payload.put("properties", propsJson)

      val body = payload.toString().toRequestBody("application/json".toMediaType())
      val reqBuilder = Request.Builder()
        .url(url)
        .post(body)
        .addHeader("Content-Type", "application/json")
      if (!token.isNullOrEmpty()) {
        reqBuilder.addHeader("Authorization", "Bearer $token")
      }
      client.newCall(reqBuilder.build()).execute().close()
    } catch (_: Exception) {
    }
  }

  private fun logError(contextObj: Context, domain: String?, token: String?, message: String, context: Map<String, Any?> = emptyMap()) {
    if (domain.isNullOrEmpty()) return
    try {
      val url = "$domain/api/log/error"
      val payload = JSONObject()
      payload.put("message", message)
      val ctx = JSONObject()
      context.forEach { (k, v) ->
        if (v != null) ctx.put(k, v)
      }
      ctx.put("device", getDeviceInfo(contextObj))
      ctx.put("source", "android_notification_service")
      payload.put("context", ctx)

      val body = payload.toString().toRequestBody("application/json".toMediaType())
      val reqBuilder = Request.Builder()
        .url(url)
        .post(body)
        .addHeader("Content-Type", "application/json")
      if (!token.isNullOrEmpty()) {
        reqBuilder.addHeader("Authorization", "Bearer $token")
      }
      client.newCall(reqBuilder.build()).execute().close()
    } catch (_: Exception) {
    }
  }

  private fun getDeviceInfo(context: Context): JSONObject {
    val device = JSONObject()
    try {
      val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
      val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val pct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()) else null
      device.put("batteryLevel", pct)
      device.put("batteryState", when (status) {
        BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
        BatteryManager.BATTERY_STATUS_FULL -> "full"
        BatteryManager.BATTERY_STATUS_DISCHARGING -> "unplugged"
        BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
        else -> "unknown"
      })
    } catch (_: Exception) {
    }

    try {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val active = cm.activeNetwork
      val caps = cm.getNetworkCapabilities(active)
      val reachable = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
      val connectionType = when {
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
        reachable -> "other"
        else -> "none"
      }
      val network = JSONObject()
      network.put("reachable", reachable)
      network.put("connectionType", connectionType)
      device.put("networkStatus", network)
    } catch (_: Exception) {
    }

    return device
  }
}
`

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const writeIfChanged = (filePath, contents) => {
  ensureDir(path.dirname(filePath))
  if (
    !fs.existsSync(filePath) ||
    fs.readFileSync(filePath, 'utf8') !== contents
  ) {
    fs.writeFileSync(filePath, contents, 'utf8')
  }
}

const withAndroidQuestionFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const androidRoot = cfg.modRequest.platformProjectRoot
      const pkg = cfg.android?.package || cfg.expo?.android?.package
      if (!pkg)
        throw new Error(
          'Android package is required for question notification plugin'
        )

      console.log('Adding Android notification extension for', pkg)

      const javaBase = path.join(
        androidRoot,
        'app/src/main/java',
        ...pkg.split('.')
      )
      writeIfChanged(
        path.join(javaBase, `${AUTH_CONFIG_MODULE}.kt`),
        templateAuthConfigModule(pkg)
      )
      writeIfChanged(
        path.join(javaBase, `${AUTH_CONFIG_PACKAGE}.kt`),
        templateAuthConfigPackage(pkg)
      )
      writeIfChanged(
        path.join(javaBase, `${RECEIVER_CLASS}.kt`),
        templateQuestionActionReceiver(pkg)
      )
      writeIfChanged(
        path.join(javaBase, `${SERVICE_CLASS}.kt`),
        templateQuestionMessagingService(pkg)
      )

      // Resources
      const resBase = path.join(androidRoot, 'app/src/main/res')
      writeIfChanged(
        path.join(resBase, 'layout', 'notification_question.xml'),
        notificationLayout
      )
      writeIfChanged(
        path.join(resBase, 'layout', 'notification_choice_row.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="horizontal"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:gravity="center"
    android:paddingTop="4dp"
    android:paddingBottom="4dp"
    android:weightSum="2">

    <FrameLayout
        android:id="@+id/choice_left_container"
        android:layout_width="0dp"
        android:layout_height="wrap_content"
        android:layout_weight="1"
        android:foregroundGravity="center">

        <Button
            android:id="@+id/choice_button_left"
            android:layout_width="match_parent"
            android:layout_height="56dp"
            android:minWidth="140dp"
            android:text="Choice"
            android:backgroundTint="#2563EB"
            android:textColor="@android:color/white"
            android:paddingLeft="16dp"
            android:paddingRight="16dp"
            android:gravity="center"
            android:maxLines="2"
            android:ellipsize="end" />

        <ProgressBar
            android:id="@+id/choice_progress_left"
            style="@android:style/Widget.ProgressBar.Small"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_gravity="center"
            android:visibility="gone" />
    </FrameLayout>

    <FrameLayout
        android:id="@+id/choice_right_container"
        android:layout_width="0dp"
        android:layout_height="wrap_content"
        android:layout_weight="1"
        android:foregroundGravity="center">

        <Button
            android:id="@+id/choice_button_right"
            android:layout_width="match_parent"
            android:layout_height="56dp"
            android:minWidth="140dp"
            android:text="Choice"
            android:backgroundTint="#2563EB"
            android:textColor="@android:color/white"
            android:paddingLeft="16dp"
            android:paddingRight="16dp"
            android:gravity="center"
            android:maxLines="2"
            android:ellipsize="end" />

        <ProgressBar
            android:id="@+id/choice_progress_right"
            style="@android:style/Widget.ProgressBar.Small"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_gravity="center"
        android:visibility="gone" />
    </FrameLayout>

</LinearLayout>`
      )
      writeIfChanged(
        path.join(resBase, 'layout', 'notification_choice_single.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="horizontal"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:gravity="center"
    android:paddingTop="4dp"
    android:paddingBottom="4dp">

    <FrameLayout
        android:id="@+id/choice_single_container"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:foregroundGravity="center">

        <Button
            android:id="@+id/choice_button_single"
            android:layout_width="match_parent"
            android:layout_height="56dp"
            android:minWidth="140dp"
            android:text="Choice"
            android:backgroundTint="#2563EB"
            android:textColor="@android:color/white"
            android:paddingLeft="16dp"
            android:paddingRight="16dp"
            android:gravity="center"
            android:maxLines="2"
            android:ellipsize="end" />

        <ProgressBar
            android:id="@+id/choice_progress_single"
            style="@android:style/Widget.ProgressBar.Small"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_gravity="center"
            android:visibility="gone" />
    </FrameLayout>

</LinearLayout>`
      )
      writeIfChanged(
        path.join(resBase, 'drawable', 'timer_ring_drawable.xml'),
        timerDrawable
      )

      return cfg
    },
  ])

const withAndroidQuestionManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const pkg = cfg.android?.package || cfg.expo?.android?.package
    if (!pkg)
      throw new Error(
        'Android package is required for question notification plugin'
      )
    const manifest = cfg.modResults
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)

    const receiverName = `${pkg}.${RECEIVER_CLASS}`
    const serviceName = `${pkg}.${SERVICE_CLASS}`

    // Remove any stray receiver/service declarations that may have landed at the manifest root
    if (manifest.receiver) {
      manifest.receiver = manifest.receiver.filter(
        (r) => r.$['android:name'] !== receiverName
      )
    }
    if (manifest.service) {
      manifest.service = manifest.service.filter(
        (s) => s.$['android:name'] !== serviceName
      )
    }

    app.receiver = app.receiver || []
    if (!app.receiver.some((r) => r.$['android:name'] === receiverName)) {
      app.receiver.push({
        $: {
          'android:name': receiverName,
          'android:exported': 'false',
        },
      })
    }

    app.service = app.service || []
    if (!app.service.some((s) => s.$['android:name'] === serviceName)) {
      app.service.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'false',
        },
        'intent-filter': [
          {
            action: [
              {
                $: {
                  'android:name': 'com.google.firebase.MESSAGING_EVENT',
                },
              },
            ],
          },
        ],
      })
    }

    return cfg
  })

const withAndroidQuestionMainApplication = (config) =>
  withMainApplication(config, (cfg) => {
    const pkg = cfg.android?.package || cfg.expo?.android?.package
    if (!pkg)
      throw new Error(
        'Android package is required for question notification plugin'
      )
    let src = cfg.modResults.contents

    const importLine = `import ${pkg}.${AUTH_CONFIG_PACKAGE}`
    if (!src.includes(importLine)) {
      src = src.replace(
        /(import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative)/,
        `$1\n${importLine}`
      )
    }

    if (!src.includes(`${AUTH_CONFIG_PACKAGE}()`)) {
      src = src.replace(
        /PackageList\(this\)\.packages\.apply \{\n(.*?)\n\s*\}/s,
        (match, inner) => {
          if (inner.includes(`${AUTH_CONFIG_PACKAGE}()`)) return match
          return match.replace(
            inner,
            `${inner}\n              add(${AUTH_CONFIG_PACKAGE}())`
          )
        }
      )
    }

    cfg.modResults.contents = src
    return cfg
  })

const withAndroidMessagingDependency = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg
    const dep =
      'implementation("com.google.firebase:firebase-messaging:23.4.0")'
    if (!cfg.modResults.contents.includes(dep)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{\n/,
        `dependencies {\n    ${dep}\n`
      )
    }
    return cfg
  })

module.exports = function withAndroidQuestionNotifications(config) {
  config = withAndroidQuestionFiles(config)
  config = withAndroidQuestionManifest(config)
  config = withAndroidQuestionMainApplication(config)
  config = withAndroidMessagingDependency(config)
  return config
}
