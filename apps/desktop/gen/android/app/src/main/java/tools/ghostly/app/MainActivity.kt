package tools.ghostly.app

import android.os.Bundle
import android.system.Os
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Debug builds only: the CI emulator's smoke test starts the app with `--ez ghostly_e2e true`, which Rust's
    // `under_test` reads as GHOSTLY_E2E=1 (no name step, never a new profile's default Mainnet wallets). adb cannot
    // set a process's environment, so the activity does. A release build ignores the extra.
    if (BuildConfig.DEBUG && intent?.getBooleanExtra("ghostly_e2e", false) == true) {
      Os.setenv("GHOSTLY_E2E", "1", true)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge is enforced from Android 15 (target SDK 35 and up), so the page would draw under the status bar,
    // the gesture bar and the keyboard. The page sits between them instead: the content view is padded by the system
    // bars, the display cutout and the keyboard, and the WebView inside it sees no insets of its own.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}
