package tools.ghostly.app

import android.os.Bundle
import android.system.Os
import androidx.activity.enableEdgeToEdge

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
  }
}
