package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Test

class TransferHoldTest {
  @Test
  fun aStopBeforeTheStartArrivesLeavesTheServiceToStopItself() {
    val hold = TransferHold()
    // A small file: the page says start, then stop, before Android runs the service's onStartCommand.
    hold.starting()
    assertEquals(false, hold.stopping())
    // In the foreground now: no longer wanted, so it stops itself.
    assertEquals(false, hold.started())
  }

  @Test
  fun aStopOnceStartedStopsAtOnce() {
    val hold = TransferHold()
    hold.starting()
    assertEquals(true, hold.started())
    assertEquals(true, hold.stopping())
  }

  @Test
  fun aStartAgainBeforeTheFirstArrivesKeepsTheService() {
    val hold = TransferHold()
    hold.starting()
    assertEquals(false, hold.stopping())
    hold.starting()
    // The first start arrives: another is on its way, and wanted.
    assertEquals(true, hold.started())
    assertEquals(true, hold.started())
    assertEquals(true, hold.stopping())
  }

  @Test
  fun aStopWaitsForTheLastStartOnItsWay() {
    val hold = TransferHold()
    hold.starting()
    hold.starting()
    assertEquals(false, hold.stopping())
    // The first one in stays for the second, which then stops it.
    assertEquals(true, hold.started())
    assertEquals(false, hold.started())
  }

  @Test
  fun aRefusedStartLeavesNothingOnItsWay() {
    val hold = TransferHold()
    hold.starting()
    hold.refused()
    assertEquals(true, hold.stopping())
  }
}
