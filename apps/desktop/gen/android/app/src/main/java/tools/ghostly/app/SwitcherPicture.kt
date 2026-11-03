package tools.ghostly.app

/**
 * How the app keeps out of the app switcher's picture while the app lock is on. Android takes that picture before the
 * page hears the app is going, so the page's cover comes too late for it. Android 13 and up lets the activity say it
 * wants no picture (`setRecentsScreenshotEnabled`), which leaves screenshots and screen sharing be; before 13 only a
 * secure window (`FLAG_SECURE`) keeps out of it, and that blocks screenshots and screen sharing too while the lock is
 * on. Plain Kotlin, so a JVM unit test reads it.
 */
object SwitcherPicture {
  enum class Way { NO_RECENTS_PICTURE, SECURE_WINDOW }

  /** The way on Android `sdk`. */
  fun way(sdk: Int): Way = if (sdk >= 33) Way.NO_RECENTS_PICTURE else Way.SECURE_WINDOW
}
