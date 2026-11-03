package tools.ghostly.app

import org.junit.Assert.assertEquals
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
}
