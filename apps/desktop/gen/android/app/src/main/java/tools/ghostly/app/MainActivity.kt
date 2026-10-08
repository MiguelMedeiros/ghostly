package tools.ghostly.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
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
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  companion object {
    /**
     * The oldest WebView (its Chrome version) the page runs in: the UI bundle is built for Vite's default target,
     * "baseline widely available", which is Chrome 111. An older one shows a blank page, so the app says what to do.
     */
    const val MIN_WEBVIEW = 111
    private const val WEBVIEW_PACKAGE = "com.google.android.webview"
  }

  /** The WebView's version when it is older than the minimum: the page is then hidden behind the update screen. */
  var webViewTooOld: String? = null
    private set
  /** The oldest WebView this start takes: [MIN_WEBVIEW], or a debug start's `ghostly_min_webview`. */
  private var minimumWebView = MIN_WEBVIEW

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
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    val background = TypedValue()
    theme.resolveAttribute(android.R.attr.colorBackground, background, true)
    val color = if (background.resourceId != 0) ContextCompat.getColor(this, background.resourceId) else background.data
    window.decorView.setBackgroundColor(color)
    val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !night
    controller.isAppearanceLightNavigationBars = !night
  }

  private fun pad(view: View, insets: WindowInsetsCompat) {
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
    view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
  }
}
