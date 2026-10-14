package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SaveSlotTest {
  @Test
  fun aSecondSaveWhileThePickerIsOpenIsNotStarted() {
    val slot = SaveSlot<String>()
    assertEquals(true, slot.take("photo.jpg"))
    // A double tap, or Save on another file before the picker shows.
    assertEquals(false, slot.take("photo.jpg"))
    assertEquals(false, slot.take("report.pdf"))
    // The picker's answer goes to the save that opened it.
    assertEquals("photo.jpg", slot.answered())
    assertNull(slot.answered())
  }

  @Test
  fun aSaveAfterThePickerAnsweredStarts() {
    val slot = SaveSlot<String>()
    slot.take("photo.jpg")
    slot.answered()
    assertEquals(true, slot.take("report.pdf"))
    assertEquals("report.pdf", slot.answered())
  }
}
