package tools.ghostly.app

import java.io.File
import java.io.OutputStream

/**
 * Save a copy's copy into the document Android's picker made. The picker makes that document, under the file's name,
 * before anything is written: a copy that fails (the phone's storage full, the stored file gone) left it there empty
 * or cut short, as though the file were saved. On a failure the document goes. Plain Kotlin, so a JVM unit test reads
 * it.
 */
object SaveCopy {
  /** Copies [from] into what [open] gives; false, and [drop] asked to delete the document, when it fails. */
  fun copy(from: File, open: () -> OutputStream?, drop: () -> Unit): Boolean {
    try {
      val out = open() ?: throw IllegalStateException("No output")
      out.use { to -> from.inputStream().use { it.copyTo(to) } }
      return true
    } catch (e: Exception) {
      try {
        drop()
      } catch (ignored: Exception) {
        // A provider that deletes nothing keeps it: the save still says it failed.
      }
      return false
    }
  }

  /**
   * The picker's answer when the page that asked is gone (Android ended the process while the picker was open):
   * [from] is the save the activity's saved state kept, copied as [copy] does; with none kept the document goes.
   */
  fun restored(from: File?, open: () -> OutputStream?, drop: () -> Unit): Boolean {
    if (from != null) return copy(from, open, drop)
    try {
      drop()
    } catch (ignored: Exception) {
      // As in copy: the save still failed.
    }
    return false
  }
}
