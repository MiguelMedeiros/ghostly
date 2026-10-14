package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedNameTest {
  private fun bytes(name: String) = name.toByteArray(Charsets.UTF_8).size

  @Test
  fun keepsTheNameTheSharingAppGave() {
    assertEquals("IMG_1.jpg", SharedName.of("IMG_1.jpg", 0))
    assertEquals("a_b.txt", SharedName.of("a/b.txt", 0))
    assertEquals("文".repeat(82) + ".pdf", SharedName.of("文".repeat(82) + ".pdf", 0))
  }

  @Test
  fun namesAStreamWithoutAUsableName() {
    for (name in listOf(null, "", "  ", ".", "..")) assertEquals("$name", "shared-3", SharedName.of(name, 2))
  }

  @Test
  fun shortensANameOver255BytesKeepingItsExtension() {
    // 86 CJK characters + ".pdf": 262 bytes, over NAME_MAX.
    val name = SharedName.of("文".repeat(86) + ".pdf", 0)
    assertEquals("文".repeat(83) + ".pdf", name)
    assertTrue(bytes(name) <= 255)
  }

  @Test
  fun neverSplitsACharacter() {
    // 64 emoji (4 bytes each, a surrogate pair in Kotlin) and no extension.
    val name = SharedName.of("😀".repeat(64), 0)
    assertEquals("😀".repeat(63), name)
  }

  @Test
  fun aStemOfSpacesBecomesFile() {
    assertEquals("file.txt", SharedName.of(" ".repeat(300) + ".txt", 0))
  }
}
