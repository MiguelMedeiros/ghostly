package tools.ghostly.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * "Call with …": a foreground service of type microphone (camera too, while the call sends the camera's picture), with
 * an ongoing notification and a partial wake lock, while a call is on (the page's `call_service`, GhostlyHostPlugin.kt).
 * Out of sight (Home, another app, the screen off) Android silences the microphone of an app that runs no such service,
 * 6-10 s after it leaves, and the backgrounded WebView let the call's connection go: the contact stopped hearing the
 * phone and the call ended by itself. Started as the call is placed or answered, with the app in front (Android 12 and
 * up start none from the background); stopped with the call, and it ends with the app's task. The notification's tap
 * brings the app (and its call window) forward; its Hang up ends the call in the page.
 */
class CallService : Service() {
  companion object {
    private const val CHANNEL = "calls"
    private const val NOTIFICATION = 3
    private const val EXTRA_NAME = "tools.ghostly.app.call.name"
    private const val EXTRA_VIDEO = "tools.ghostly.app.call.video"
    private const val ACTION_HANG_UP = "tools.ghostly.app.call.HANG_UP"
    /** Never held past this, should the page never say the call ended (a wake lock left held drains a battery). */
    private const val WAKE_AT_MOST_MS = 12L * 60 * 60 * 1000

    /** Whether a stop may reach Android now (TransferHold.kt): the same rule as the transfer service's. */
    private val hold = TransferHold()

    /** The notification's Hang up: GhostlyHostPlugin tells the page, which ends the call (and stops this). */
    @Volatile
    var hangUp: (() -> Unit)? = null

    /**
     * Starts it, or tells the running one who the call is with and whether it sends the camera's picture. False when
     * there is nothing to keep (no microphone allowed) or Android refuses (an app already in the background may not
     * start one, Android 12 and up): a call already held stays as it was.
     */
    fun start(context: Context, name: String, video: Boolean): Boolean = synchronized(hold) {
      if (types(context, video) == null) return false
      hold.starting()
      try {
        val intent = Intent(context, CallService::class.java).putExtra(EXTRA_NAME, name).putExtra(EXTRA_VIDEO, video)
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
        if (hold.stopping()) context.stopService(Intent(context, CallService::class.java))
      }
    }

    private fun types(context: Context, video: Boolean): Int? {
      val granted = { permission: String -> ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED }
      return CallTypes.of(Build.VERSION.SDK_INT, granted(Manifest.permission.RECORD_AUDIO), granted(Manifest.permission.CAMERA), video)
    }
  }

  private var wake: PowerManager.WakeLock? = null
  /** In the foreground for a call: a later start that Android refuses (a camera turned on) leaves it as it is. */
  private var foreground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_HANG_UP) {
      hangUp?.invoke()
      // A notification left from a run that is gone: nothing to end, nothing held.
      if (!foreground) stopSelf(startId)
      return START_NOT_STICKY
    }
    val name = intent?.getStringExtra(EXTRA_NAME) ?: ""
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    try {
      val types = types(this, video) ?: throw SecurityException("The microphone is not allowed")
      ServiceCompat.startForeground(this, NOTIFICATION, notification(name), types)
      foreground = true
    } catch (e: Exception) {
      // Refused (the app went to the background before the service came up, a permission taken back): nothing held,
      // unless it already holds the call, which goes on as it was.
      synchronized(hold) {
        val stays = hold.started()
        if (!foreground || !stays) stopSelf(startId)
      }
      return START_NOT_STICKY
    }
    // The page said stop while this start was on its way (a call that ended at once): in the foreground now, it may
    // stop. By this start's id, so a start that came in since keeps it.
    val stays = synchronized(hold) { hold.started().also { if (!it) stopSelf(startId) } }
    if (!stays) return START_NOT_STICKY
    if (wake == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ghostly:call").apply {
        setReferenceCounted(false)
        acquire(WAKE_AT_MOST_MS)
      }
    }
    // Not started again by Android after the app's process ends: the call ended with it.
    return START_NOT_STICKY
  }

  /** The person swiped the app away: the call went with it, and nothing of it keeps running. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
  }

  override fun onDestroy() {
    foreground = false
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }

  /**
   * Ongoing and quiet (the call window rings and sounds, not this), on its own channel. A tap brings the app forward,
   * where the call window shows over any screen; Hang up ends the call. The lock screen shows it without the name.
   */
  private fun notification(name: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_calls), NotificationManager.IMPORTANCE_LOW))
    }
    val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = PendingIntent.getActivity(this, NOTIFICATION, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val end = PendingIntent.getService(
      this,
      NOTIFICATION,
      Intent(this, CallService::class.java).setAction(ACTION_HANG_UP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val title = if (name.isBlank()) getString(R.string.call_public) else getString(R.string.call_title, name)
    val shown = { text: String ->
      NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(text)
        .setContentText(getString(R.string.call_text))
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setSilent(true)
        .setContentIntent(tap)
        .addAction(0, getString(R.string.call_hang_up), end)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }
    return shown(title)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(shown(getString(R.string.call_public)).build())
      .build()
  }
}
