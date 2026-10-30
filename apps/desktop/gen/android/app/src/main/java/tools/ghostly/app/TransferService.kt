package tools.ghostly.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * "Sending files…": a foreground service, with its notification and a partial wake lock, while a file moves (the page's
 * `keepAwake` with `files`, GhostlyHostPlugin.kt). Out of sight (Home, another app, the screen off) Android freezes an
 * app that runs nothing in the foreground (the cached apps freezer, Doze): Rust's network and the WebView stop with it,
 * and a transfer stalled until the app came back. The service keeps the process in the foreground for as long as
 * files move, never longer: the page stops it with the last one, and it ends with the app's task.
 */
class TransferService : Service() {
  companion object {
    private const val CHANNEL = "transfers"
    private const val NOTIFICATION = 2
    /** Never held past this, should the page never say the files are through (a wake lock left held drains a battery). */
    private const val WAKE_AT_MOST_MS = 6L * 60 * 60 * 1000

    /** Starts it; false when Android refuses (an app already in the background may not start one, Android 12 and up). */
    fun start(context: Context): Boolean = try {
      ContextCompat.startForegroundService(context, Intent(context, TransferService::class.java))
      true
    } catch (e: Exception) {
      false
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, TransferService::class.java))
    }
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION,
        notification(),
        if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
      )
    } catch (e: Exception) {
      // Refused (the app went to the background before the service came up): nothing held.
      stopSelf()
      return START_NOT_STICKY
    }
    if (wake == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ghostly:transfer").apply {
        setReferenceCounted(false)
        acquire(WAKE_AT_MOST_MS)
      }
    }
    // Not started again by Android after the app's process ends: the page that starts says whether files move.
    return START_NOT_STICKY
  }

  /** Android 15's limit for a data-sync service (6 hours a day): it stops, as Android asks. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  /** The person swiped the app away: nothing of it keeps running. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
  }

  override fun onDestroy() {
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }

  /** Quiet (no sound, no heads-up), on its own channel; a tap brings the app forward. */
  private fun notification(): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_transfers), NotificationManager.IMPORTANCE_LOW))
    }
    val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(getString(R.string.transfer_title))
      .setContentText(getString(R.string.transfer_text))
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(tap)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
