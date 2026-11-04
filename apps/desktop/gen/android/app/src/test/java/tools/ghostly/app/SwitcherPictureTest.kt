package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SwitcherPictureTest {
  @Test
  fun android13AndUpTurnsOffOnlyTheSwitchersPicture() {
    assertEquals(SwitcherPicture.Way.NO_RECENTS_PICTURE, SwitcherPicture.way(33))
    assertEquals(SwitcherPicture.Way.NO_RECENTS_PICTURE, SwitcherPicture.way(35))
  }

  @Test
  fun beforeAndroid13TheWindowIsSecure() {
    assertEquals(SwitcherPicture.Way.SECURE_WINDOW, SwitcherPicture.way(32))
    assertEquals(SwitcherPicture.Way.SECURE_WINDOW, SwitcherPicture.way(26))
  }

  @Test
  fun withTheLockOnTheCoverGoesOverAnAppNotInFront() {
    // The switcher opened from the app: still resumed, its window without focus.
    assertTrue(SwitcherPicture.covered(lockOn = true, resumed = true, focused = false))
    assertTrue(SwitcherPicture.covered(lockOn = true, resumed = false, focused = false))
    assertTrue(SwitcherPicture.covered(lockOn = true, resumed = false, focused = true))
    assertFalse(SwitcherPicture.covered(lockOn = true, resumed = true, focused = true))
  }

  @Test
  fun withNoLockThereIsNoCover() {
    assertFalse(SwitcherPicture.covered(lockOn = false, resumed = true, focused = false))
    assertFalse(SwitcherPicture.covered(lockOn = false, resumed = false, focused = false))
  }
}
