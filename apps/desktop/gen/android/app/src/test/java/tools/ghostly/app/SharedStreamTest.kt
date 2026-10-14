package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedStreamTest {
  private val own = listOf("tools.ghostly.app.fileprovider", "tools.ghostly.app.androidx-startup")

  @Test
  fun readsAnotherAppsProvider() {
    assertTrue(SharedStream.takes("content", "com.android.providers.media.documents", own))
    assertTrue(SharedStream.takes("content", "com.google.android.apps.photos.contentprovider", own))
  }

  @Test
  fun neverAFilePath() {
    // file:///data/user/0/tools.ghostly.app/files/<space>/<id>: the app would open it as itself.
    assertFalse(SharedStream.takes("file", "", own))
    assertFalse(SharedStream.takes("file", null, own))
    assertFalse(SharedStream.takes("FILE", null, own))
  }

  @Test
  fun neverTheAppsOwnProvider() {
    assertFalse(SharedStream.takes("content", "tools.ghostly.app.fileprovider", own))
    assertFalse(SharedStream.takes("content", "Tools.Ghostly.App.FileProvider", own))
    assertFalse(SharedStream.takes("content", "tools.ghostly.app.androidx-startup", own))
  }

  @Test
  fun nothingElse() {
    for (scheme in listOf(null, "", "http", "https", "android.resource", "CONTENT")) {
      assertFalse(scheme.toString(), SharedStream.takes(scheme, "com.example.provider", own))
    }
    assertFalse(SharedStream.takes("content", null, own))
    assertFalse(SharedStream.takes("content", "", own))
  }

  // Int stands in for Uri: what matters is that a value of another type is dropped, never cast.
  @Test
  fun onlyStreamsOfTheType() {
    val strings = arrayListOf<Any?>("content://media/external/images/media/1", "content://media/external/images/media/2")
    assertEquals(emptyList<Int>(), SharedStream.of(strings, Int::class.javaObjectType, many = true))
    assertEquals(listOf(1, 3), SharedStream.of(arrayListOf<Any?>(1, "two", null, 3), Int::class.javaObjectType, many = true))
    assertEquals(emptyList<Int>(), SharedStream.of(7, Int::class.javaObjectType, many = true))
    assertEquals(emptyList<Int>(), SharedStream.of(null, Int::class.javaObjectType, many = true))
    assertEquals(listOf(7), SharedStream.of(7, Int::class.javaObjectType, many = false))
    assertEquals(emptyList<Int>(), SharedStream.of("content://x/1", Int::class.javaObjectType, many = false))
    assertEquals(emptyList<Int>(), SharedStream.of(arrayListOf<Any?>(7), Int::class.javaObjectType, many = false))
    assertEquals(emptyList<Int>(), SharedStream.of(null, Int::class.javaObjectType, many = false))
  }
}
