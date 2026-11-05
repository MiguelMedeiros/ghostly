package tools.ghostly.app

/**
 * How the app keeps out of the app switcher's picture while the app lock is on. Android takes that picture before the
 * page hears the app is going, so the page's cover comes too late for it. Android 13 and up lets the activity say it
 * wants no picture (`setRecentsScreenshotEnabled`), which leaves screenshots and screen sharing be; before 13 only a
 * secure window (`FLAG_SECURE`) keeps out of it, and that blocks screenshots and screen sharing too while the lock is
 * on. Plain Kotlin, so a JVM unit test reads it.
 *
 * Neither covers the switcher opened straight from the app: it shows the app's live window, not a picture. The
 * activity's cover (MainActivity) goes over the page for that, whenever the lock is on and the app is not in front.
 */
object SwitcherPicture {
  enum class Way { NO_RECENTS_PICTURE, SECURE_WINDOW }

  /** The way on Android `sdk`. */
  fun way(sdk: Int): Way = if (sdk >= 33) Way.NO_RECENTS_PICTURE else Way.SECURE_WINDOW

  /**
   * Whether the cover goes over the page: the lock is on and the app is not in front, paused or without its window's
   * focus (the switcher takes it while the app's live window still shows, as does the notification shade).
   */
  fun covered(lockOn: Boolean, resumed: Boolean, focused: Boolean): Boolean = lockOn && !(resumed && focused)
}
