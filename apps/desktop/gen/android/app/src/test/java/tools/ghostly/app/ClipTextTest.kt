package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class ClipTextTest {
  /** A stream that never ends, counting what was read from it. */
  private class Endless : InputStream() {
    var read = 0L
    override fun read(): Int {
      read++
      return 'a'.code
    }
  }

  @Test
  fun readsTextUpToTheLimit() {
    assertEquals("", ClipText.upTo(ByteArrayInputStream(ByteArray(0))))
    assertEquals("olá", ClipText.upTo(ByteArrayInputStream("olá".toByteArray())))
    val full = "a".repeat(ClipText.MAX_BYTES)
    assertEquals(full, ClipText.upTo(ByteArrayInputStream(full.toByteArray())))
  }

  @Test
  fun refusesOneByteOver() {
    assertNull(ClipText.upTo(ByteArrayInputStream(ByteArray(ClipText.MAX_BYTES + 1) { 'a'.code.toByte() })))
  }

  @Test
  fun stopsOnAStreamThatNeverEnds() {
    val endless = Endless()
    assertNull(ClipText.upTo(endless))
    assertTrue("read ${endless.read}", endless.read <= ClipText.MAX_BYTES + 1L)
  }
}
