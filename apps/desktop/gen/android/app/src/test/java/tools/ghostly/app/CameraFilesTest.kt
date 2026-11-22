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
  fun anActivityMadeAgainKeepsThePhotoTheCameraIsTaking() {
    // Android ended the process while the camera app was in front: the activity made again gets the camera's answer,
    // and the photo the camera wrote is still to be offered.
    val cache = temp.newFolder("cache")
    val old = CameraFiles.create(cache).apply { writeBytes(ByteArray(16)) }
    val taking = CameraFiles.create(cache).apply { writeBytes(ByteArray(16)) }
    CameraFiles.sweep(cache, taking.name)
    assertTrue(taking.exists())
    assertFalse(old.exists())
    // A name that is no file of the folder keeps nothing.
    for (name in listOf("", "..", "../camera", "../${taking.name}")) {
      val again = CameraFiles.create(cache)
      CameraFiles.sweep(cache, name)
      assertFalse(name, again.exists())
    }
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
