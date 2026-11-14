package tools.ghostly.app

import android.app.ActivityManager
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
 * "Ghostly is connected": a foreground service, with a quiet notification, while the person keeps "Stay connected in
 * the background" on (the page's `connection_service`, GhostlyHostPlugin.kt). Out of sight (Home, another app, the
 * screen off) Android freezes an app that runs nothing in the foreground: Rust's network and the WebView's renderer
 * stop with it, every chat's and group's link went down within seconds, and on return each had to connect again. The
 * service keeps the process in the foreground, so the links are still up on return. A partial wake lock only while
 * links are up (the page says so again every few minutes; the lock runs out by itself should it stop saying), so
 * the phone sleeps when there is nobody to stay connected to. Files that move meanwhile are held here too, with the
 * transfer's line in the notification (ConnectionHolds.kt). Type `remoteMessaging` on Android 14 and up (no daily
 * limit, unlike `dataSync`); none below, where a type is not required. Started with the app in front (Android 12 and
 * up start none from the background); it ends with the app's task.
 */
class ConnectionService : Service() {
  companion object {
    private const val CHANNEL = "connection"
    private const val NOTIFICATION = 4
    private const val EXTRA_FILES = "tools.ghostly.app.connection.files"
    private const val EXTRA_LINKS = "tools.ghostly.app.connection.links"
    /** Kept while the service runs, so the next start knows the system ended the app under it. */
    private const val PREFS = "ghostly_connection"
    private const val RUNNING = "running"

    /** Whether a stop may reach Android now (TransferHold.kt): the same rule as the transfer service's. */
    private val hold = TransferHold()

    /** The one in the foreground now: told what changed without a start, which Android refuses from the background. */
    private var current: ConnectionService? = null

    /** Whether it holds the app in the foreground now. */
    val running: Boolean
      get() = synchronized(hold) { current != null }

    /**
     * Starts it, or tells the running one whether files move (its line) and links are up (its wake lock). False when
     * Android refuses the start (an app already in the background may not start one, Android 12 and up).
     */
    fun start(context: Context, files: Boolean, links: Boolean): Boolean = synchronized(hold) {
      current?.let {
        it.update(files, links)
        return true
      }
      hold.starting()
      try {
        val intent = Intent(context, ConnectionService::class.java).putExtra(EXTRA_FILES, files).putExtra(EXTRA_LINKS, links)
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (e: Exception) {
        hold.refused()
        false
      }
    }

    /** Stops it, or leaves that to a start still on its way: stopped before it is in the foreground, Android ends the app. */
    fun stop(context: Context) {
      synchronized(hold) {
        if (!hold.stopping()) return
        if (current == null) return
        current = null
        context.stopService(Intent(context, ConnectionService::class.java))
      }
    }

    /**
     * Whether the system ended the app while the service ran in its last run (ConnectionHolds.killedBySystem), and the
     * app's battery use is still optimized: the one case where "Unrestricted" may help. Read once, as it starts.
     */
    fun killedLastRun(context: Context): Boolean {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val wasRunning = prefs.getBoolean(RUNNING, false)
      if (!wasRunning) return false
      prefs.edit().putBoolean(RUNNING, false).apply()
      val reason = if (Build.VERSION.SDK_INT >= 30) {
        val activities = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        runCatching {
          val exits = activities.getHistoricalProcessExitReasons(context.packageName, 0, 0).map { it.processName to it.reason }
          ConnectionHolds.lastExitReason(exits, context.packageName)
        }.getOrNull() ?: 0
      } else null
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      return ConnectionHolds.killedBySystem(true, reason) && !power.isIgnoringBatteryOptimizations(context.packageName)
    }
  }

  private var wake: PowerManager.WakeLock? = null
  /** Whether the notification shows the files' line now. */
  private var files: Boolean? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val files = intent?.getBooleanExtra(EXTRA_FILES, false) ?: false
    val links = intent?.getBooleanExtra(EXTRA_LINKS, false) ?: false
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION,
        notification(files),
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0,
      )
      this.files = files
    } catch (e: Exception) {
      // Refused (the app went to the background before the service came up): nothing held.
      synchronized(hold) {
        hold.started()
        stopSelf(startId)
      }
      return START_NOT_STICKY
    }
    // The page said stop while this start was on its way: in the foreground now, it may stop. By this start's id, so a
    // start that came in since keeps it.
    val stays = synchronized(hold) {
      hold.started().also { if (it) current = this else stopSelf(startId) }
    }
    if (!stays) return START_NOT_STICKY
    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(RUNNING, true).apply()
    update(files, links)
    // Not started again by Android after the app's process ends: the page that starts says whether to stay connected.
    return START_NOT_STICKY
  }

  /** Files move or not (the notification's line), links are up or not (the wake lock, its lease taken again). */
  private fun update(files: Boolean, links: Boolean) {
    if (files != this.files) {
      this.files = files
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION, notification(files))
    }
    val lease = ConnectionHolds.wakeFor(files, links)
    if (lease == null) {
      wake?.let { if (it.isHeld) it.release() }
      return
    }
    val lock = wake ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ghostly:connection")
      .apply { setReferenceCounted(false) }
      .also { wake = it }
    // Not reference counted: taken again, it runs for `lease` from now.
    lock.acquire(lease)
  }

  /** The person swiped the app away: nothing of it keeps running. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    synchronized(hold) { if (current === this) current = null }
    stopSelf()
  }

  override fun onDestroy() {
    synchronized(hold) { if (current === this) current = null }
    // Stopped (the page, the person): the next start has nothing to say about it.
    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(RUNNING, false).apply()
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }

  /** Quiet (no sound, no heads-up), on its own channel; a tap brings the app forward. Files moving: their line. */
  private fun notification(files: Boolean): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        },
      )
    }
    val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(getString(if (files) R.string.transfer_title else R.string.connection_title))
      .setContentText(getString(if (files) R.string.transfer_text else R.string.connection_text))
      .setCategory(if (files) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setContentIntent(tap)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
