package tools.ghostly.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.system.Os
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import kotlin.concurrent.thread

class MainActivity : TauriActivity() {
  companion object {
    /**
     * The oldest WebView (its Chrome version) the page runs in: the UI bundle is built for Vite's default target,
     * "baseline widely available", which is Chrome 111. An older one shows a blank page, so the app says what to do.
     */
    const val MIN_WEBVIEW = 111
    private const val WEBVIEW_PACKAGE = "com.google.android.webview"
    /** The saved state's name of the photo the camera app is taking ([cameraPhoto]). */
    private const val CAMERA_PHOTO = "tools.ghostly.app.cameraPhoto"
  }

  /** The WebView's version when it is older than the minimum: the page is then hidden behind the update screen. */
  var webViewTooOld: String? = null
    private set
  /** The oldest WebView this start takes: [MIN_WEBVIEW], or a debug start's `ghostly_min_webview`. */
  private var minimumWebView = MIN_WEBVIEW

  /**
   * Whether the app lock is on (GhostlyHostPlugin's `hideFromSwitcher`). The page's own cover comes only once it hears
   * the app is going, after the switcher already shows the app's live window: this one goes over the page as soon as
   * the app leaves the front (SwitcherPicture.covered), and goes again when it is back.
   */
  var lockOn = false
    set(value) {
      field = value
      updateCover()
    }
  private var resumed = false
  private var focused = false
  private var cover: View? = null

  /**
   * The composer's Camera (CameraChromeClient): the camera app's answer comes to this launcher. The page that asked
   * waits for it in memory ([cameraAnswer]); the photo's name ([cameraPhoto], in `cache/camera`) is kept in the saved
   * state too, since Android often ends the process behind a camera app and makes the activity again for its answer.
   */
  private lateinit var cameraLauncher: ActivityResultLauncher<Intent>
  private var cameraAnswer: ((ActivityResult) -> Unit)? = null
  private var cameraPhoto: String? = null

  /** Opens the camera app (`intent`) to write `file`; `answer` gets its result while this process lives. */
  fun takePhoto(intent: Intent, file: File, answer: (ActivityResult) -> Unit) {
    cameraAnswer = answer
    cameraPhoto = file.name
    try {
      cameraLauncher.launch(intent)
    } catch (e: ActivityNotFoundException) {
      cameraAnswer = null
      cameraPhoto = null
      throw e
    }
  }

  /**
   * The camera app's answer. With no page waiting for it (Android ended the process meanwhile, and the page that
   * asked went with it), the photo it took is not lost without a word: it comes back as a share, Exif taken away
   * first as for the composer, so the person picks the chat and finds it on the attachment sheet (SharePicker).
   */
  private fun cameraAnswered(result: ActivityResult) {
    val answer = cameraAnswer
    val name = cameraPhoto
    cameraAnswer = null
    cameraPhoto = null
    if (answer != null) return answer(result)
    val file = File(CameraFiles.folder(cacheDir), name ?: return)
    if (result.resultCode != RESULT_OK || file.length() == 0L) {
      file.delete()
      return
    }
    thread(name = "ghostly-camera") {
      val stripped = CameraPhoto.strip(file)
      if (!stripped) file.delete()
      runOnUiThread { if (stripped) GhostlyHostPlugin.photoBack(file) }
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    cameraPhoto?.let { outState.putString(CAMERA_PHOTO, it) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Before the page loads. Debug builds take `--ei ghostly_min_webview <major>`, so the screen can be seen on an
    // emulator whose WebView is new enough.
    minimumWebView = if (BuildConfig.DEBUG) intent?.getIntExtra("ghostly_min_webview", MIN_WEBVIEW) ?: MIN_WEBVIEW else MIN_WEBVIEW
    val version = WebView.getCurrentWebViewPackage()?.versionName ?: ""
    val major = version.substringBefore('.').toIntOrNull()
    if (major != null && major < minimumWebView) webViewTooOld = version
    // Debug builds only: the CI emulator's smoke test and the Android e2e (e2e/android) start the app with
    // `--ez ghostly_e2e true`, which Rust's `under_test` reads as GHOSTLY_E2E=1 (no name step, never a new profile's
    // default Mainnet wallets), and with the network as `--es GHOSTLY_… <value>` extras. adb cannot set a process's
    // environment, so the activity does, before Rust starts (in `super.onCreate`). A release build ignores them all.
    if (BuildConfig.DEBUG && intent?.getBooleanExtra("ghostly_e2e", false) == true) {
      Os.setenv("GHOSTLY_E2E", "1", true)
      // Each `ghostly-file` request, its range and answer (file_stream.rs), for the smoke test to read back.
      Os.setenv("GHOSTLY_STREAM_LOG", "${filesDir.path}/ghostly-file.log", true)
      val extras = intent?.extras
      val strings = extras?.keySet().orEmpty()
        .filter { E2eEnvironment.takes(it) }
        .mapNotNull { name -> extras?.getString(name)?.let { name to it } }
        .toMap()
      for ((name, value) in E2eEnvironment.of(strings)) Os.setenv(name, value, true)
    }
    // A share, a notification's tap or a sign-in's link the task started with, already taken by the run Android ended
    // (LaunchIntent): the plugin's `load` leaves it, so a share sent or cancelled is never offered (nor copied) again.
    if (LaunchIntent.takenBefore(savedInstanceState != null, intent?.flags ?: 0)) {
      intent?.putExtra(GhostlyHostPlugin.EXTRA_HANDLED, true)
    }
    // The camera's photos a previous page held (CameraCapture.kt): this start's page holds none of them. The one the
    // camera app is still taking stays, for its answer (`cameraAnswered`).
    cameraPhoto = savedInstanceState?.getString(CAMERA_PHOTO)
    CameraFiles.sweep(cacheDir, cameraPhoto)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // After wry's and Tauri's own, in the same order at every create: Android hands an answer to the launcher
    // registered in the same place, in an activity made again too.
    cameraLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult(), ::cameraAnswered)
    // Edge to edge is enforced from Android 15 (target SDK 35 and up), so the page would draw under the status bar,
    // the gesture bar and the keyboard. The page sits between them instead: the content view is padded by the system
    // bars, the display cutout and the keyboard, and the WebView inside it sees no insets of its own.
    // The keyboard's inset is followed frame by frame while it opens and closes, so the composer moves with it rather
    // than waiting for the animation's end.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      pad(view, insets)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.setWindowInsetsAnimationCallback(
      content,
      object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
        override fun onProgress(
          insets: WindowInsetsCompat,
          running: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat {
          pad(content, insets)
          return insets
        }
      },
    )
  }

  /** The page's WebView is made: hidden, with the update screen over it, when the WebView is too old to run it. */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // wry sets its WebChromeClient after this callback: the camera's capture goes in over it on the next turn.
    window.decorView.post {
      val wry = webView.webChromeClient
      if (wry != null && wry !is CameraChromeClient) webView.webChromeClient = CameraChromeClient(this, wry)
    }
    val version = webViewTooOld ?: return
    webView.visibility = View.GONE
    val screen = layoutInflater.inflate(R.layout.webview_update, null)
    screen.findViewById<TextView>(R.id.webview_update_text).text = getString(R.string.webview_text, version, minimumWebView)
    screen.findViewById<Button>(R.id.webview_update_button).setOnClickListener {
      val store = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$WEBVIEW_PACKAGE"))
      try {
        startActivity(store)
      } catch (e: ActivityNotFoundException) {
        // No Play Store: its page in the browser, if there is one.
        runCatching {
          startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$WEBVIEW_PACKAGE")))
        }
      }
    }
    // wry calls `setContentView(webView)` right after this callback, which would take away a view added now: the
    // screen goes on once that has run, on the next turn of the main thread.
    window.decorView.post {
      addContentView(screen, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      updateScreenBars()
    }
  }

  /**
   * The bars around the update screen take its own background, light or dark as the system's night mode, since the
   * page's `system_bars` is not for this screen (GhostlyHostPlugin leaves the bars alone while it shows).
   */
  private fun updateScreenBars() {
    window.decorView.setBackgroundColor(themeBackground())
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !night
    controller.isAppearanceLightNavigationBars = !night
  }

  /**
   * A share, a notification's tap or a sign-in's link that comes to the task (singleTask). Kept as the activity's
   * intent before the plugins hear it: when Android ended the process but kept the task in Recents, the activity made
   * again gets it before GhostlyHostPlugin is loaded (no plugin hears it), and the plugin's `load` takes it from here.
   */
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    resumed = true
    updateCover()
  }

  override fun onPause() {
    resumed = false
    updateCover()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    focused = hasFocus
    updateCover()
  }

  /**
   * The cover over the page (layout/lock_cover: the app's mark and one line), shown or hidden. It takes the page's
   * background colour (`system_bars` set it), and a line that reads on it: the app's own prompts (a permission, the
   * share sheet) show over it, so it says whose screen it is.
   */
  private fun updateCover() {
    val show = SwitcherPicture.covered(lockOn, resumed, focused)
    if (!show && cover == null) return
    val view = cover ?: layoutInflater.inflate(R.layout.lock_cover, null).also {
      // Above the WebView (and the update screen): the content view's last child.
      addContentView(it, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      cover = it
    }
    if (show) {
      val background = (window.decorView.background as? ColorDrawable)?.color ?: themeBackground()
      view.setBackgroundColor(background)
      val dark = ColorUtils.calculateLuminance(background) < 0.5
      view.findViewById<TextView>(R.id.lock_cover_line).setTextColor(if (dark) 0xDEFFFFFF.toInt() else 0xDE000000.toInt())
      view.bringToFront()
    }
    view.visibility = if (show) View.VISIBLE else View.GONE
  }

  private fun themeBackground(): Int {
    val background = TypedValue()
    theme.resolveAttribute(android.R.attr.colorBackground, background, true)
    return if (background.resourceId != 0) ContextCompat.getColor(this, background.resourceId) else background.data
  }

  private fun pad(view: View, insets: WindowInsetsCompat) {
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
    view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
  }
}
