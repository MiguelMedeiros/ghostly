package tools.ghostly.app

/**
 * When the activity's cover (MainActivity) goes over the page while the app lock is on. The app switcher's picture and
 * any capture of the live window it shows as it opens are kept out by the secure window
 * (GhostlyHostPlugin.hideFromSwitcher), since both come before the activity hears the app is going; the cover is for
 * the moment after. Plain Kotlin, so a JVM unit test reads it.
 */
object SwitcherPicture {
  /**
   * Whether the cover goes over the page: the lock is on and the app is not in front, paused or without its window's
   * focus (the switcher takes it while the app's live window still shows, as does the notification shade).
   */
  fun covered(lockOn: Boolean, resumed: Boolean, focused: Boolean): Boolean = lockOn && !(resumed && focused)
}
