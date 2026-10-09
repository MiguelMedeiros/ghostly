package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CameraFilesTest {
  @get:Rule
  val temp = TemporaryFolder()

  @Test
  fun aPhotoGoesToThePrivateCacheOnly() {
    val cache = temp.newFolder("cache")
    val photo = CameraFiles.create(cache)
    assertEquals(File(cache, "camera").canonicalFile, photo.parentFile!!.canonicalFile)
    assertTrue(photo.name, Regex("JPEG_\\d{8}_\\d{6}_\\d+\\.jpg").matches(photo.name))
    assertEquals(0L, photo.length())
    // Two photos in the same second are two files.
    assertTrue(CameraFiles.create(cache) != photo)
  }

  @Test
  fun theNextStartSweepsEveryPhoto() {
    val cache = temp.newFolder("cache")
    val shared = File(cache, "shared/1").apply { mkdirs() }
    val photos = List(3) { CameraFiles.create(cache).apply { writeBytes(ByteArray(16)) } }
    CameraFiles.sweep(cache)
    for (photo in photos) assertFalse(photo.path, photo.exists())
    assertFalse(File(cache, "camera").exists())
    // The rest of the cache is not the camera's.
    assertTrue(shared.exists())
    // Nothing to sweep is no error.
    CameraFiles.sweep(cache)
  }

  @Test
  fun takesOnlyAPhotoFromTheCamera() {
    assertTrue(CameraFiles.takesPhoto(true, arrayOf("image/*")))
    assertFalse(CameraFiles.takesPhoto(false, arrayOf("image/*")))
    assertFalse(CameraFiles.takesPhoto(true, arrayOf("video/*")))
    assertFalse(CameraFiles.takesPhoto(true, arrayOf("image/*", "video/*")))
    assertFalse(CameraFiles.takesPhoto(true, arrayOf("")))
  }
}
