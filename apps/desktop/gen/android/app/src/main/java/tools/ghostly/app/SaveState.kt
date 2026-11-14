package tools.ghostly.app

/**
 * Save a copy's open picker (SavePicker): the save it waits for, kept in the activity's saved state so an answer that
 * reaches a process Android made again still knows which stored file to copy, and who hears the answer while the
 * process that opened the picker lives ([A]). Plain Kotlin, so a JVM unit test reads it.
 */
class SaveState<A : Any> {
  /** A save asked for: the stored file at `path`, offered under `name`. */
  data class Save(val path: String, val name: String)

  companion object {
    const val PATH = "tools.ghostly.app.save.path"
    const val NAME = "tools.ghostly.app.save.name"
  }

  private val slot = SaveSlot<Save>()
  private var waiting: A? = null

  /** The save a process Android ended kept ([keep]), read back with [get] (the saved state's Bundle). */
  fun restore(get: (String) -> String?) {
    val path = get(PATH) ?: return
    slot.take(Save(path, get(NAME).orEmpty()))
  }

  /** The save whose picker is open, if one is, written with [put] (the saved state's Bundle). */
  fun keep(put: (String, String) -> Unit) {
    val save = slot.open ?: return
    put(PATH, save.path)
    put(NAME, save.name)
  }

  /** Takes [save], [answer] hearing the picker; false, and nothing taken, while another save's picker is open. */
  fun begin(save: Save, answer: A): Boolean {
    if (!slot.take(save)) return false
    waiting = answer
    return true
  }

  /** No picker opened after [begin]: no answer will free the slot. */
  fun cancel() {
    slot.answered()
    waiting = null
  }

  /**
   * The picker answered, [chosen] when the person picked a document. With someone waiting, [answer] hears it. With no
   * one (Android ended the process while the picker was open, and the page that asked went with it), a chosen
   * document is [restore]d from the save kept, or null when none was kept; a cancelled picker does nothing.
   */
  fun settle(chosen: Boolean, answer: (A, Save?) -> Unit, restore: (Save?) -> Unit) {
    val save = slot.answered()
    val waiter = waiting
    waiting = null
    if (waiter != null) return answer(waiter, save)
    if (chosen) restore(save)
  }
}
