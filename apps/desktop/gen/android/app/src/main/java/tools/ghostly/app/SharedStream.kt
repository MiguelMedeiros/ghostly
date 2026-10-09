package tools.ghostly.app

/**
 * Which stream of a "Share to Ghostly" the app reads (GhostlyHostPlugin `shared`). The app opens a stream as itself,
 * so a `file://` path, or a `content://` uri of one of the app's own providers, would let the sharing app hand it the
 * app's own private files (another profile's chat files, the WebView's database) to send to a contact. Only a
 * `content://` uri of another app's provider is read; Android 7 and up never has an app share a `file://` path. Plain
 * Kotlin, so a JVM unit test reads it.
 */
object SharedStream {
  /** Whether a stream with this scheme and authority may be read; `own` are the authorities of the app's providers. */
  fun takes(scheme: String?, authority: String?, own: Collection<String>): Boolean {
    if (scheme != "content" || authority.isNullOrEmpty()) return false
    return own.none { it.equals(authority, ignoreCase = true) }
  }
}
