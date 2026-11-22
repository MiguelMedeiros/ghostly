package tools.ghostly.app

/**
 * The one save whose document picker is open. Tauri keeps one callback for an activity's result, so a second picker
 * (a double tap on Save, or Save on another file before the first picker shows) took the first one's answer: the
 * first save never answered and the second picker's document stayed empty. While one is open, another save is not
 * started. Plain Kotlin, so a JVM unit test reads it.
 */
class SaveSlot<T : Any> {
  /** The save whose picker is open, kept in the activity's saved state (SavePicker) while the picker is in front. */
  var open: T? = null
    private set

  /** Takes `save` when no picker is open; false (the save is not started) while one is. */
  fun take(save: T): Boolean {
    if (open != null) return false
    open = save
    return true
  }

  /** The save the picker answered, and the slot free again. */
  fun answered(): T? = open.also { open = null }
}
