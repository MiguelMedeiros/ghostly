package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Test

class ShareTurnsTest {
  @Test
  fun aShareThatEndsUpWithNothingDoesNotStopOneStillCopying() {
    val turns = ShareTurns(1000)
    val video = turns.arrive()
    // A newer share arrives while the video copies: its one file too big, or a stream that cannot be opened.
    val tooBig = turns.arrive()
    assertEquals(true, turns.going(video))
    assertEquals(true, turns.going(tooBig))
    // The video is copied whole: it is the one handed over, and the newer share, still with nothing, stops.
    turns.has(video)
    assertEquals(true, turns.latest(video))
    assertEquals(false, turns.going(tooBig))
    assertEquals(false, turns.latest(tooBig))
  }

  @Test
  fun aNewerShareWithSomethingOvertakesOlderOnes() {
    val turns = ShareTurns(1000)
    val video = turns.arrive()
    val photo = turns.arrive()
    turns.has(photo)
    assertEquals(false, turns.going(video))
    assertEquals(true, turns.latest(photo))
    // The older one ending late never takes its place back.
    turns.has(video)
    assertEquals(false, turns.latest(video))
    assertEquals(true, turns.latest(photo))
  }

  @Test
  fun sharesAreNumberedAfterTheStart() {
    val turns = ShareTurns(1000)
    assertEquals(1000L, turns.last())
    assertEquals(false, turns.latest(1000))
    assertEquals(1001L, turns.arrive())
    assertEquals(1001L, turns.last())
    // A share with nothing yet is not the one handed over.
    assertEquals(false, turns.latest(1001))
  }
}
