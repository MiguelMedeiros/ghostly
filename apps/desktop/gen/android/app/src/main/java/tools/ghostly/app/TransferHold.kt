package tools.ghostly.app

/**
 * When the transfer service (TransferService.kt) may be stopped. Android ends the whole app ("Context.
 * startForegroundService() did not then call Service.startForeground()") when a service started for the foreground is
 * stopped before its onStartCommand has put it there, and a file through in a few milliseconds has the page say stop
 * that soon after start. So a stop that comes while a start is still on its way leaves the service be: once in the
 * foreground it sees it is no longer wanted and stops itself. Plain Kotlin, so a JVM unit test reads it.
 */
class TransferHold {
  /** What the page asked for last. */
  private var wanted = false
  /** Starts handed to Android that have not reached onStartCommand yet. */
  private var pending = 0

  /** The page wants the service: a start is handed to Android. */
  @Synchronized
  fun starting() {
    wanted = true
    pending += 1
  }

  /** Android refused that start: it never reaches onStartCommand. */
  @Synchronized
  fun refused() {
    if (pending > 0) pending -= 1
  }

  /** The page wants it stopped: whether to stop it now, or (false) leave it to a start still on its way. */
  @Synchronized
  fun stopping(): Boolean {
    wanted = false
    return pending == 0
  }

  /** A start reached onStartCommand: whether the service stays (wanted, or another start still on its way). */
  @Synchronized
  fun started(): Boolean {
    if (pending > 0) pending -= 1
    return wanted || pending > 0
  }
}
