package tools.ghostly.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.OutputStream

class SaveCopyTest {
  @get:Rule
  val folder = TemporaryFolder()

  /** The document the picker made, empty until the copy writes it. */
  private fun picked(): File = folder.newFile("photo.jpg")

  private fun stored(size: Int): File = folder.newFile("stored").apply { writeBytes(ByteArray(size) { it.toByte() }) }

  @Test
  fun aWholeCopyKeepsTheDocument() {
    val document = picked()
    val from = stored(100_000)
    var dropped = 0
    assertEquals(true, SaveCopy.copy(from, { document.outputStream() }, { dropped++ }))
    assertArrayEquals(from.readBytes(), document.readBytes())
    assertEquals(0, dropped)
  }

  @Test
  fun aCopyCutShortDeletesTheDocument() {
    val document = picked()
    // The phone's storage fills after 8 KiB: what was written stays unless the document goes.
    val full = object : OutputStream() {
      private val to = document.outputStream()
      private var written = 0
      override fun write(b: Int) {
        if (written >= 8192) throw IOException("ENOSPC (No space left on device)")
        to.write(b)
        written++
      }
      override fun close() = to.close()
    }
    assertEquals(false, SaveCopy.copy(stored(100_000), { full }, { document.delete() }))
    assertEquals(false, document.exists())
  }

  @Test
  fun aStoredFileGoneDeletesTheEmptyDocument() {
    val document = picked()
    assertEquals(false, SaveCopy.copy(File(folder.root, "gone"), { document.outputStream() }, { document.delete() }))
    assertEquals(false, document.exists())
  }

  @Test
  fun noOutputDeletesTheDocument() {
    val document = picked()
    assertEquals(false, SaveCopy.copy(stored(10), { null }, { document.delete() }))
    assertEquals(false, document.exists())
  }

  @Test
  fun aProviderThatDeletesNothingStillFails() {
    val document = picked()
    val failed = SaveCopy.copy(File(folder.root, "gone"), { document.outputStream() }, { throw UnsupportedOperationException("Delete not supported") })
    assertEquals(false, failed)
  }
}
