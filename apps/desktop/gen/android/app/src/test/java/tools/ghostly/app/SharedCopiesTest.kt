package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SharedCopiesTest {
  @get:Rule val temp = TemporaryFolder()

  private fun copy(root: File, share: String, index: Int, name: String): File =
    File(root, "$share/$index/$name").apply { parentFile!!.mkdirs(); writeText("bytes") }

  @Test
  fun aSharesFilesNameItsFolderOnly() {
    val root = temp.newFolder("shared")
    val video = copy(root, "1000", 0, "VID_1.mp4")
    val photo = copy(root, "1000", 1, "IMG_1.jpg")
    copy(root, "1001", 0, "next.jpg")
    val outside = temp.newFile("photo.jpg")
    assertEquals(
      setOf(File(root, "1000").canonicalFile),
      SharedCopies.foldersOf(root, listOf(video.path, photo.path, "${root.path}/1001/../1000/1/IMG_1.jpg")),
    )
    // Never anything outside a share's folder: a file elsewhere, the root, a share's folder itself, a climb out.
    assertEquals(
      emptySet<File>(),
      SharedCopies.foldersOf(root, listOf(outside.path, root.path, File(root, "1000").path, "${root.path}/1000/../../photo.jpg", "/")),
    )
    copy(root, "notes", 0, "x.txt").let { assertEquals(emptySet<File>(), SharedCopies.foldersOf(root, listOf(it.path))) }
  }

  @Test
  fun aShareWithNoFileNoTextAndNoTitleIsNothing() {
    assertEquals(true, SharedCopies.nothingIn("", "", 0))
    assertEquals(true, SharedCopies.nothingIn(" ", "\n\t", 0))
    assertEquals(false, SharedCopies.nothingIn("", "", 1))
    assertEquals(false, SharedCopies.nothingIn("", "see this", 0))
    assertEquals(false, SharedCopies.nothingIn("A note", "", 0))
  }

  @Test
  fun aCopyOntoAFullDiskIsNoRoomNotUnread() {
    // A full disk as the JVM and Android say it, also when wrapped.
    val full = try {
      java.io.FileOutputStream("/dev/full").use { it.write(ByteArray(1)); it.flush() }
      null
    } catch (e: java.io.IOException) {
      e
    }
    if (full != null) assertEquals(true, SharedCopies.noRoom(full))
    assertEquals(true, SharedCopies.noRoom(java.io.IOException("write failed: ENOSPC (No space left on device)")))
    assertEquals(true, SharedCopies.noRoom(RuntimeException("copy", java.io.IOException("write failed: EDQUOT (Disk quota exceeded)"))))
    // What the other app's stream did: not read, as before.
    assertEquals(false, SharedCopies.noRoom(SecurityException("Permission Denial: reading content://media/external/video/1")))
    assertEquals(false, SharedCopies.noRoom(java.io.IOException("No stream for content://x/1")))
    assertEquals(false, SharedCopies.noRoom(java.io.FileNotFoundException()))
  }

  @Test
  fun aStartLeavesOnlySharesTakenSinceIt() {
    val root = temp.newFolder("shared")
    for (share in listOf("900", "1000", "1001", "junk")) copy(root, share, 0, "f")
    File(root, "stray.bin").writeText("x")
    assertEquals(
      setOf("900", "1000", "junk", "stray.bin"),
      SharedCopies.stale(root, 1000).map { it.name }.toSet(),
    )
    assertEquals(emptyList<File>(), SharedCopies.stale(File(root, "missing"), 1000))
  }
}
