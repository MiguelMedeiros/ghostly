package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Test

class ShareTurnsTest {
  @Test
  fun aShareThatEndsUpWithNothingDoesNotStopOneStillCopying() {
    val dropped = mutableListOf<String>()
    val turns = ShareTurns<String>(1000) { dropped += it }
    val video = turns.arrive()
    // A newer share arrives while the video copies: its one file too big, or a stream that cannot be opened.
    val tooBig = turns.arrive()
    assertEquals(true, turns.going(video))
    assertEquals(true, turns.going(tooBig))
    // The video is copied whole, while the newer share is still undecided: it waits, not shown first.
    turns.has(video)
    assertEquals(false, turns.latest(video))
    assertEquals(null, turns.ready(video, "video"))
    // The newer share ends with nothing: the video is handed over now.
    assertEquals("video", turns.nothing(tooBig))
    assertEquals(true, turns.latest(video))
    assertEquals(false, turns.latest(tooBig))
    assertEquals(emptyList<String>(), dropped)
  }

  @Test
  fun aShareThatWaitsIsDroppedWhenANewerOneGetsSomething() {
    val dropped = mutableListOf<String>()
    val turns = ShareTurns<String>(1000) { dropped += it }
    val wrong = turns.arrive()
    val meant = turns.arrive()
    // The replaced clip ends first: it is never handed over while the one meant still copies.
    assertEquals(null, turns.ready(wrong, "wrong"))
    assertEquals(true, turns.going(meant))
    // The one meant is copied whole: the replaced one goes, and the one meant is handed over.
    assertEquals("meant", turns.ready(meant, "meant"))
    assertEquals(listOf("wrong"), dropped)
    assertEquals(null, turns.nothing(meant))
  }

  @Test
  fun aNewerShareWithSomethingOvertakesOlderOnes() {
    val dropped = mutableListOf<String>()
    val turns = ShareTurns<String>(1000) { dropped += it }
    val video = turns.arrive()
    val photo = turns.arrive()
    turns.has(photo)
    assertEquals(false, turns.going(video))
    assertEquals(true, turns.latest(photo))
    // The older one ending late never takes its place back.
    assertEquals(null, turns.ready(video, "video"))
    assertEquals(listOf("video"), dropped)
    assertEquals(false, turns.latest(video))
    assertEquals(true, turns.latest(photo))
  }

  @Test
  fun sharesAreNumberedAfterTheStart() {
    val turns = ShareTurns<String>(1000) {}
    assertEquals(1000L, turns.last())
    assertEquals(false, turns.latest(1000))
    assertEquals(1001L, turns.arrive())
    assertEquals(1001L, turns.last())
    // A share with nothing yet is not the one handed over.
    assertEquals(false, turns.latest(1001))
  }
}
