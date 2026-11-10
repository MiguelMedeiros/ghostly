package tools.ghostly.app

/**
 * Which foreground service keeps the app running out of sight: the connection service (ConnectionService.kt), while
 * the person keeps "Stay connected in the background" on, or the transfer service (TransferService.kt), while files
 * move and the connection service is off. Never both: one notification. The connection service already holds the app
 * up, so files that move under it only change its notification's line; it stays for files still moving after the page
 * let it go (the switch turned off, the app locked), so a transfer never needs a start Android may refuse from the
 * background. Plain Kotlin, so a JVM unit test reads it.
 */
object ConnectionHolds {
  /** Whether the connection service holds now: wanted, or files still moving under the one that runs. */
  fun connectionHolds(wanted: Boolean, files: Boolean, running: Boolean): Boolean = wanted || (files && running)

  /** Whether the transfer service holds now: files move and the connection service does not hold them. */
  fun transferHolds(files: Boolean, connectionHeld: Boolean): Boolean = files && !connectionHeld

  /** How long the wake lock is held at a time while links are up: the page says so again before it runs out. */
  const val LINKS_LEASE_MS = 15L * 60 * 1000

  /** At most this long while files move, as the transfer service's: the page says when they are through. */
  const val FILES_AT_MOST_MS = 6L * 60 * 60 * 1000

  /** How long the wake lock is held from now (null: let go): files, else live links, else nothing. */
  fun wakeFor(files: Boolean, links: Boolean): Long? = when {
    files -> FILES_AT_MOST_MS
    links -> LINKS_LEASE_MS
    else -> null
  }

  // ApplicationExitInfo's reasons (Android 11 and up): the ones by which the system, not the person, ended the app.
  private const val REASON_UNKNOWN = 0
  private const val REASON_SIGNALED = 2
  private const val REASON_LOW_MEMORY = 3
  private const val REASON_EXCESSIVE_RESOURCE_USAGE = 9
  private const val REASON_OTHER = 13
  private const val REASON_FREEZER = 14
  private val BY_THE_SYSTEM = setOf(REASON_UNKNOWN, REASON_SIGNALED, REASON_LOW_MEMORY, REASON_EXCESSIVE_RESOURCE_USAGE, REASON_OTHER, REASON_FREEZER)

  /**
   * Whether the system ended the app while the connection service ran (`wasRunning`: it never stopped in the last
   * run). `reason`: how the last run ended, where Android says (11 and up); null below. Not a person's force stop, a
   * crash, an update or a permission taken back: the battery setting would change nothing there.
   */
  fun killedBySystem(wasRunning: Boolean, reason: Int?): Boolean = wasRunning && (reason == null || reason in BY_THE_SYSTEM)
}
