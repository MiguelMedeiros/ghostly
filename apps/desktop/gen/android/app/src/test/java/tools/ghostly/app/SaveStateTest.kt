package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SaveStateTest {
  private val photo = SaveState.Save("/data/files/space/abc", "photo.jpg")

  /** The activity's saved state (a Bundle) as Android hands it to the activity it makes again. */
  private fun saved(state: SaveState<String>): Map<String, String> {
    val bundle = mutableMapOf<String, String>()
    state.keep { name, value -> bundle[name] = value }
    return bundle
  }

  /** What [SaveState.settle] did: "answer:<who>:<path>", "restore:<path>", or nothing. */
  private fun settle(state: SaveState<String>, chosen: Boolean): String? {
    var done: String? = null
    state.settle(chosen, { who, save -> done = "answer:$who:${save?.path}" }, { save -> done = "restore:${save?.path}" })
    return done
  }

  @Test
  fun anOpenPickersSaveIsKeptAndReadBackByTheProcessMadeAgain() {
    val before = SaveState<String>()
    before.begin(photo, "page")
    val bundle = saved(before)
    assertEquals(mapOf(SaveState.PATH to photo.path, SaveState.NAME to photo.name), bundle)

    // Android ended the process: a new one, with only the saved state.
    val after = SaveState<String>()
    after.restore { bundle[it] }
    assertEquals(bundle, saved(after))
    assertEquals("restore:${photo.path}", settle(after, chosen = true))
  }

  @Test
  fun noPickerOpenKeepsNothing() {
    val state = SaveState<String>()
    assertEquals(emptyMap<String, String>(), saved(state))
    state.begin(photo, "page")
    settle(state, chosen = true)
    assertEquals(emptyMap<String, String>(), saved(state))
  }

  @Test
  fun aSavedStateWithNoPathRestoresNoSave() {
    val state = SaveState<String>()
    state.restore { if (it == SaveState.NAME) "photo.jpg" else null }
    assertEquals(emptyMap<String, String>(), saved(state))
    // The document is still chosen: restored with no save, so SaveCopy.restored deletes it.
    assertEquals("restore:null", settle(state, chosen = true))
  }

  @Test
  fun theAnswerGoesToWhoWaitsInTheSameProcess() {
    val state = SaveState<String>()
    state.begin(photo, "page")
    assertEquals("answer:page:${photo.path}", settle(state, chosen = true))
    // Cancelled: still the page's answer, which says not saved.
    state.begin(photo, "page")
    assertEquals("answer:page:${photo.path}", settle(state, chosen = false))
  }

  @Test
  fun aCancelledPickerAfterTheProcessEndedDoesNothing() {
    val state = SaveState<String>()
    state.restore { mapOf(SaveState.PATH to photo.path, SaveState.NAME to photo.name)[it] }
    assertNull(settle(state, chosen = false))
    // The slot is free again: the next save opens.
    assertEquals(true, state.begin(photo, "page"))
  }

  @Test
  fun aSecondSaveWhileAPickerIsOpenOpensNone() {
    val state = SaveState<String>()
    assertEquals(true, state.begin(photo, "first"))
    assertEquals(false, state.begin(SaveState.Save("/other", "report.pdf"), "second"))
    assertEquals("answer:first:${photo.path}", settle(state, chosen = true))
  }

  @Test
  fun aPickerThatNeverOpenedFreesTheSlot() {
    val state = SaveState<String>()
    state.begin(photo, "page")
    state.cancel()
    assertEquals(emptyMap<String, String>(), saved(state))
    assertEquals(true, state.begin(photo, "page"))
    assertEquals("answer:page:${photo.path}", settle(state, chosen = true))
  }
}
