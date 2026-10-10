package tools.ghostly.app

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.WindowCompat
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

@InvokeArg
class UrlArgs {
  lateinit var url: String
}

@InvokeArg
class TextArgs {
  lateinit var text: String
}

@InvokeArg
class PermissionArgs {
  var request: Boolean = false
}

@InvokeArg
class NotifyArgs {
  lateinit var id: String
  lateinit var body: String
}

@InvokeArg
class TagArgs {
  lateinit var id: String
}

@InvokeArg
class SaveArgs {
  lateinit var path: String
  lateinit var name: String
}

@InvokeArg
class PathsArgs {
  var paths: List<String> = emptyList()
}

@InvokeArg
class BarsArgs {
  var color: Int = 0
  var dark: Boolean = true
}

/**
 * The Android host of the app (src/android.rs calls it): what Desktop does with the system's processes and windows,
 * done through Android, and what Android hands the app, passed to Rust (`received`): a sign-in's deep link, a share
 * from another app, a tap on a notification, a network change. Every command runs on Android's main thread.
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = GhostlyHostPlugin.NOTIFICATIONS),
  ],
)
class GhostlyHostPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    const val NOTIFICATIONS = "notifications"
    /** The extra a notification's tap carries: the page's id for it, which names the chat only in the page. */
    const val EXTRA_NOTIFICATION = "tools.ghostly.app.notification"
    /** Marks an intent handled, so the one that started the app is not taken again when the activity comes back. */
    private const val EXTRA_HANDLED = "tools.ghostly.app.handled"
    private const val CHANNEL = "messages"
    /** At most this many files from one share, as a paste (clipboard.rs `MAX_PASTED_FILES`). */
    private const val MAX_SHARED_FILES = 32
    /**
     * The latest share's number: an older share still copying stops, and is never handed over after a newer one.
     * Starts at the clock, so a share's folder is newer than any a previous run left.
     */
    private val shareGeneration = AtomicLong(System.currentTimeMillis())
    /** Whether this run swept what earlier runs left in the share cache: once, as an activity made again may come. */
    private val sharesSwept = AtomicBoolean(false)
  }

  /** Rust (src/android.rs): `kind` is "oidc", "share", "notification" or "network". */
  private external fun received(kind: String, value: String)

  private var pendingSave: SaveArgs? = null

  override fun load(webView: WebView) {
    // Copies an earlier run left (a share never read, the app stopped): only shares this run takes are kept.
    if (sharesSwept.compareAndSet(false, true)) {
      val since = shareGeneration.get()
      thread(name = "ghostly-share-clean") { SharedCopies.stale(sharedRoot(), since).forEach { it.deleteRecursively() } }
    }
    take(activity.intent)
    watchNetwork()
  }

  override fun onNewIntent(intent: Intent) {
    take(intent)
  }

  /*
   * Away and back. Android's WebView keeps `document.visibilityState` "visible" and `hasFocus()` true when the app goes
   * to the background (Home, another app, the screen off): the page would never know it is away, so a message that
   * comes then gets no notification (AttentionFeedback notifies only while away). The activity's stop and restart (its
   * start again after a stop) say it.
   */
  override fun onStop() {
    received("visibility", "hidden")
  }

  override fun onRestart() {
    received("visibility", "visible")
  }

  private fun take(intent: Intent?) {
    if (intent == null || intent.getBooleanExtra(EXTRA_HANDLED, false)) return
    when {
      intent.hasExtra(EXTRA_NOTIFICATION) -> received("notification", intent.getStringExtra(EXTRA_NOTIFICATION) ?: return)
      intent.action == Intent.ACTION_VIEW && intent.data?.scheme == "ghostly" && intent.data?.host == "oidc" ->
        received("oidc", intent.dataString ?: return)
      intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE -> shared(intent)
      else -> return
    }
    intent.putExtra(EXTRA_HANDLED, true)
  }

  // ---- Opener ----

  /** A link the Rust side checked, in the app Android has for it. An error when there is none. */
  @Command
  fun view(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    // No CATEGORY_BROWSABLE: a wallet's `lightning:` filter does not always declare it.
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: ActivityNotFoundException) {
      invoke.reject("No app on this phone opens this link")
    }
  }

  // ---- Share sheet ----

  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(TextArgs::class.java)
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, args.text)
    activity.startActivity(Intent.createChooser(send, null))
    invoke.resolve()
  }

  /**
   * "Share to Ghostly" from another app: its text and its streams. Each stream is copied into the app's cache (a
   * folder per share and per file, under the name the sharing app gave), off the main thread, then handed to Rust.
   * Shares are numbered as they arrive: one that a newer share overtook stops copying and is never handed over, so a
   * big share that ends late cannot replace the one made after it. Older shares' copies go once a newer one is
   * handed over. The page reads the copies by token, as a paste's, then says it is done with them (`shareDone`).
   * Only another app's `content://` streams are read (SharedStream): the app opens a stream as itself.
   */
  private fun shared(intent: Intent) {
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
    val title = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE) ?: ""
    val authorities = ownAuthorities()
    val streams =
      streamsOf(intent).filter { SharedStream.takes(it.scheme, it.authority, authorities) }.take(MAX_SHARED_FILES)
    val resolver = activity.contentResolver
    val root = sharedRoot()
    val generation = shareGeneration.incrementAndGet()
    val latest = { shareGeneration.get() == generation }
    thread(name = "ghostly-share") {
      val own = File(root, generation.toString())
      own.deleteRecursively()
      val files = JSONArray()
      for ((index, uri) in streams.withIndex()) {
        if (!latest()) break
        try {
          val folder = File(own, index.toString()).apply { mkdirs() }
          val file = File(folder, SharedName.of(displayName(uri), index))
          val copied = resolver.openInputStream(uri)?.use { input -> file.outputStream().use { copyWhile(input, it, latest) } }
          if (copied != true) continue
          files.put(JSONObject().put("path", file.path).put("mime", resolver.getType(uri) ?: JSONObject.NULL))
        } catch (e: Exception) {
          // One file that cannot be read (a revoked permission, a broken stream) leaves the rest of the share.
        }
      }
      // No file to read (none copied whole): nothing names the folder to the page, so it goes now.
      if (!latest() || files.length() == 0) own.deleteRecursively()
      if (!latest()) return@thread
      val share = JSONObject().put("title", title).put("text", text).put("files", files)
      activity.runOnUiThread {
        // Checked again on the main thread, where shares arrive: a newer one may have come during the hop.
        if (!latest()) return@runOnUiThread
        received("share", share.toString())
        // Only older ones: a newer share may be copying into its own folder already.
        thread(name = "ghostly-share-clean") {
          root.listFiles()?.filter { (it.name.toLongOrNull() ?: 0L) < generation }?.forEach { it.deleteRecursively() }
        }
      }
    }
  }

  private fun sharedRoot() = File(activity.cacheDir, "shared")

  /**
   * The page read a share's files (Rust's `incoming_share_done`, with the paths it had them under): their share's
   * folder goes. Only folders of shares in the share cache, whatever the paths say.
   */
  @Command
  fun shareDone(invoke: Invoke) {
    val args = invoke.parseArgs(PathsArgs::class.java)
    val root = sharedRoot()
    thread(name = "ghostly-share-clean") { SharedCopies.foldersOf(root, args.paths).forEach { it.deleteRecursively() } }
    invoke.resolve()
  }

  /** Copies `input` whole while `going` holds; false when it stopped first. */
  private fun copyWhile(input: InputStream, output: OutputStream, going: () -> Boolean): Boolean {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE * 8)
    while (true) {
      if (!going()) return false
      val read = input.read(buffer)
      if (read < 0) return true
      output.write(buffer, 0, read)
    }
  }

  @Suppress("DEPRECATION")
  private fun streamsOf(intent: Intent): List<Uri> = when (intent.action) {
    Intent.ACTION_SEND_MULTIPLE ->
      if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
      else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    else ->
      listOfNotNull(
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
      )
  }

  /** The authorities of the app's own content providers (its FileProvider, the libraries'), from its manifest. */
  @Suppress("DEPRECATION")
  private fun ownAuthorities(): List<String> = try {
    val info = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PROVIDERS)
    info.providers.orEmpty().flatMap { it.authority?.split(';').orEmpty() } + "${activity.packageName}.fileprovider"
  } catch (e: Exception) {
    listOf("${activity.packageName}.fileprovider")
  }

  private fun displayName(uri: Uri): String? {
    return try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
      }
    } catch (e: Exception) {
      null
    }
  }

  // ---- Clipboard ----

  /**
   * The clipboard's text; none when it holds something else. Android 10 and up gives it to the app in front only.
   * A copied URI (a file, a provider's stream) is read as `coerceToText` would, but off the main thread and never
   * past the paste's limit: a big file or a slow provider froze the app while `coerceToText` read all of it.
   */
  @Command
  fun clipboardRead(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = clipboard.primaryClip
    val item = if (clip != null && clip.itemCount > 0) clip.getItemAt(0) else null
    val uri = item?.uri
    if (item?.text != null || uri == null) {
      val text = item?.text ?: item?.intent?.toUri(Intent.URI_INTENT_SCHEME)
      invoke.resolve(JSObject().put("text", text?.toString() ?: ""))
      return
    }
    thread(name = "ghostly-clipboard") {
      val text = try {
        activity.contentResolver.openTypedAssetFileDescriptor(uri, "text/*", null)?.createInputStream()?.use {
          ClipText.upTo(it) ?: return@thread invoke.reject("The clipboard holds too much text")
        }
      } catch (e: Exception) {
        null
      }
      // Not text (or gone): the URI itself, as coerceToText gives.
      invoke.resolve(JSObject().put("text", text ?: uri.toString()))
    }
  }

  // ---- Notifications ----

  /** "granted", "denied" or "default". With `request`, Android 13 and up asks (once; then only Settings can). */
  @Command
  fun notificationPermission(invoke: Invoke) {
    val args = invoke.parseArgs(PermissionArgs::class.java)
    if (args.request && Build.VERSION.SDK_INT >= 33 && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
      requestPermissionForAlias(NOTIFICATIONS, invoke, "notificationsAsked")
      return
    }
    invoke.resolve(JSObject().put("state", notificationState()))
  }

  @PermissionCallback
  private fun notificationsAsked(invoke: Invoke) {
    invoke.resolve(JSObject().put("state", notificationState()))
  }

  private fun notificationState(): String {
    if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) return "granted"
    if (Build.VERSION.SDK_INT < 33) return "denied"
    return when (getPermissionState(NOTIFICATIONS)) {
      PermissionState.DENIED -> "denied"
      // Granted, but turned off in Settings since.
      PermissionState.GRANTED -> "denied"
      else -> "default"
    }
  }

  /**
   * A silent notification on the Messages channel (the page plays its own sound); a tap opens the chat. One posted
   * again under the same id (a chat's next message) replaces it with no new heads-up.
   */
  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NotifyArgs::class.java)
    val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      val channel = NotificationChannel(CHANNEL, activity.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH)
      channel.setSound(null, null)
      manager.createNotificationChannel(channel)
    }
    val open = Intent(activity, MainActivity::class.java)
      .putExtra(EXTRA_NOTIFICATION, args.id)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = PendingIntent.getActivity(
      activity,
      args.id.hashCode(),
      open,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification = NotificationCompat.Builder(activity, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Ghostly")
      .setContentText(args.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(args.body))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(tap)
      .build()
    try {
      manager.notify(args.id, 1, notification)
      invoke.resolve()
    } catch (e: SecurityException) {
      invoke.reject("Notifications are off for Ghostly")
    }
  }

  /** Takes away the notification posted as `id` (its chat was read in the app); nothing when it is gone already. */
  @Command
  fun cancelNotification(invoke: Invoke) {
    val args = invoke.parseArgs(TagArgs::class.java)
    val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(args.id, 1)
    invoke.resolve()
  }

  @Command
  fun openNotificationSettings(invoke: Invoke) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: ActivityNotFoundException) {
      invoke.reject("No notification settings to open")
    }
  }

  // ---- Saving a file ----

  /** Android's document picker, then a copy of the stored file to where the person chose. */
  @Command
  fun saveFile(invoke: Invoke) {
    val args = invoke.parseArgs(SaveArgs::class.java)
    pendingSave = args
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("*/*")
      .putExtra(Intent.EXTRA_TITLE, args.name)
    startActivityForResult(invoke, intent, "saveChosen")
  }

  @ActivityCallback
  private fun saveChosen(invoke: Invoke, result: ActivityResult) {
    val args = pendingSave
    pendingSave = null
    val target = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || target == null || args == null) {
      invoke.resolve(JSObject().put("saved", false))
      return
    }
    thread(name = "ghostly-save") {
      try {
        val out = activity.contentResolver.openOutputStream(target, "wt") ?: throw IllegalStateException("No output")
        out.use { to -> File(args.path).inputStream().use { it.copyTo(to) } }
        invoke.resolve(JSObject().put("saved", true))
      } catch (e: Exception) {
        invoke.reject("The file could not be saved there")
      }
    }
  }

  // ---- System bars ----

  /** The strips around the page take its background colour, and icons that read on it. */
  @Command
  fun systemBars(invoke: Invoke) {
    val args = invoke.parseArgs(BarsArgs::class.java)
    // On the main thread: a view's background set from the plugin's thread is not drawn again, so the bars kept the
    // first theme's colour while their icons followed the second (dark icons on a dark bar, seen on the emulator).
    activity.runOnUiThread {
      // The WebView-update screen (MainActivity) shows instead of the page, which still loads behind it: the bars keep
      // that screen's colours.
      if ((activity as? MainActivity)?.webViewTooOld != null) {
        invoke.resolve()
        return@runOnUiThread
      }
      val window = activity.window
      window.decorView.setBackgroundColor(Color.rgb((args.color shr 16) and 0xff, (args.color shr 8) and 0xff, args.color and 0xff))
      val controller = WindowCompat.getInsetsController(window, window.decorView)
      controller.isAppearanceLightStatusBars = !args.dark
      controller.isAppearanceLightNavigationBars = !args.dark
      invoke.resolve()
    }
  }

  // ---- Network ----

  /**
   * Android denies Iroh's netwatch the routing table (SELinux, `nlmsg_readpriv`), so a new network may go unseen
   * there: Android's own callback tells Rust, which tells every Iroh endpoint and the Pkarr client.
   */
  private fun watchNetwork() {
    val connectivity = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    try {
      connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        private var last: Network? = null

        override fun onAvailable(network: Network) {
          // The first call names the network there was at start: nothing changed.
          if (last != null && last != network) changed("available")
          last = network
        }

        override fun onLost(network: Network) = changed("lost")

        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
          if (last == network) changed("addresses")
        }

        private fun changed(what: String) = activity.runOnUiThread { received("network", what) }
      })
    } catch (e: Exception) {
      // Without the callback, Iroh notices a new network itself, later.
    }
  }
}
