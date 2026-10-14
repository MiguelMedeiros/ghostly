package tools.ghostly.app

import java.io.InputStream

/**
 * A clipboard item's text read from its stream (a copied file, a provider's URI), never more than the paste takes:
 * at most `max + 1` bytes are read, so a big file or a stream that never ends stops there. Plain Kotlin, so a JVM unit
 * test reads it.
 */
object ClipText {
  /** The most text one paste hands to the page (clipboard.rs `MAX_CLIPBOARD_BYTES`). */
  const val MAX_BYTES = 64 * 1024

  /** The stream's text as UTF-8; null when it holds more than `max` bytes. */
  fun upTo(input: InputStream, max: Int = MAX_BYTES): String? {
    val buffer = ByteArray(max + 1)
    var length = 0
    while (length < buffer.size) {
      val read = input.read(buffer, length, buffer.size - length)
      if (read < 0) break
      length += read
    }
    if (length > max) return null
    return String(buffer, 0, length, Charsets.UTF_8)
  }
}
