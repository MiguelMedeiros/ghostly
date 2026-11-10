package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionHoldsTest {
  @Test
  fun oneServiceAtATimeSoOneNotification() {
    for (wanted in listOf(false, true)) for (files in listOf(false, true)) for (running in listOf(false, true)) {
      val connection = ConnectionHolds.connectionHolds(wanted, files, running)
      val transfer = ConnectionHolds.transferHolds(files, connection)
      assertEquals("wanted=$wanted files=$files running=$running", false, connection && transfer)
    }
  }

  @Test
  fun filesMoveUnderTheConnectionServiceWhenItIsOn() {
    assertEquals(true, ConnectionHolds.connectionHolds(wanted = true, files = true, running = false))
    assertEquals(false, ConnectionHolds.transferHolds(files = true, connectionHeld = true))
  }

  @Test
  fun filesMoveUnderTheTransferServiceWhenTheConnectionIsOffOrRefused() {
    assertEquals(false, ConnectionHolds.connectionHolds(wanted = false, files = true, running = false))
    assertEquals(true, ConnectionHolds.transferHolds(files = true, connectionHeld = false))
  }

  @Test
  fun aConnectionLetGoWhileFilesMoveStaysUntilTheyAreThrough() {
    // The switch turned off (or the app locked) with a file still moving: no start Android may refuse from the background.
    assertEquals(true, ConnectionHolds.connectionHolds(wanted = false, files = true, running = true))
    assertEquals(false, ConnectionHolds.connectionHolds(wanted = false, files = false, running = true))
  }

  @Test
  fun theWakeLockOnlyWhileFilesMoveOrLinksAreUp() {
    assertEquals(null, ConnectionHolds.wakeFor(files = false, links = false))
    assertEquals(ConnectionHolds.LINKS_LEASE_MS, ConnectionHolds.wakeFor(files = false, links = true))
    assertEquals(ConnectionHolds.FILES_AT_MOST_MS, ConnectionHolds.wakeFor(files = true, links = false))
  }

  @Test
  fun killedBySystemOnlyWhenItRanAndThePersonDidNotStopIt() {
    assertEquals(false, ConnectionHolds.killedBySystem(false, 3))
    // Android 10 and below say no reason: running at the end is enough.
    assertEquals(true, ConnectionHolds.killedBySystem(true, null))
    // Low memory, the freezer, a signal (a maker's battery saver), "other", unknown.
    for (reason in listOf(0, 2, 3, 9, 13, 14)) assertEquals("reason $reason", true, ConnectionHolds.killedBySystem(true, reason))
    // Exit self, crashes, ANR, a permission changed, a force stop, the app stopped, an update.
    for (reason in listOf(1, 4, 5, 6, 8, 10, 11, 15, 16)) assertEquals("reason $reason", false, ConnectionHolds.killedBySystem(true, reason))
  }
}
