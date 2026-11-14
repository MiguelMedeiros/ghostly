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

  @Test
  fun theAppsOwnExitCountsNotItsWebViewRenderers() {
    val app = "tools.ghostly.app"
    val renderer = "com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0"
    // A force stop as the API 35 emulator records it: the renderer goes a few ms after the app, "other kills by system"
    // (isolated not needed), so it is the newest record.
    val forceStopped = listOf(renderer to 13, app to 10, renderer to 13, app to 2)
    assertEquals(10, ConnectionHolds.lastExitReason(forceStopped, app))
    assertEquals(false, ConnectionHolds.killedBySystem(true, ConnectionHolds.lastExitReason(forceStopped, app)))
    // Killed by a signal, its renderer ending by itself after: still the system's.
    val signaled = listOf(renderer to 1, app to 2)
    assertEquals(true, ConnectionHolds.killedBySystem(true, ConnectionHolds.lastExitReason(signaled, app)))
    // No record of the app at all: not known.
    assertEquals(null, ConnectionHolds.lastExitReason(listOf(renderer to 13), app))
  }
}
