package tools.ghostly.app

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchIntentTest {
  /** Intent.FLAG_ACTIVITY_NEW_TASK, which a share from another app carries. */
  private val newTask = 0x10000000

  @Test
  fun aFirstStartTakesItsIntent() {
    assertFalse(LaunchIntent.takenBefore(restored = false, flags = 0))
    assertFalse(LaunchIntent.takenBefore(restored = false, flags = newTask))
  }

  @Test
  fun anActivityMadeAgainWithItsSavedStateDoesNot() {
    // The process ended in the background, the task brought back: the record's original intent, as it came.
    assertTrue(LaunchIntent.takenBefore(restored = true, flags = newTask))
  }

  @Test
  fun anActivityMadeAnewFromRecentsDoesNot() {
    assertTrue(LaunchIntent.takenBefore(restored = false, flags = newTask or Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
  }
}
