package tools.ghostly.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraRefusalTest {
  @Test
  fun aFirstAskDismissedIsNoBlock() {
    // Back on Android's first CAMERA dialog: no rationale before or after, and Android asks again at the next tap.
    assertFalse(CameraRefusal.blocked(before = false, after = false, refusedBefore = false))
  }

  @Test
  fun aFirstDontAllowIsARefusal() {
    assertFalse(CameraRefusal.blocked(before = false, after = true, refusedBefore = false))
  }

  @Test
  fun aSecondDontAllowBlocks() {
    assertTrue(CameraRefusal.blocked(before = true, after = false, refusedBefore = true))
  }

  @Test
  fun aSecondAskDismissedIsNoBlock() {
    assertFalse(CameraRefusal.blocked(before = true, after = true, refusedBefore = true))
  }

  @Test
  fun refusedAtOnceAfterARefusalIsBlocked() {
    // Android no longer shows the dialog: no rationale before or after, and a refusal came first.
    assertTrue(CameraRefusal.blocked(before = false, after = false, refusedBefore = true))
  }
}
