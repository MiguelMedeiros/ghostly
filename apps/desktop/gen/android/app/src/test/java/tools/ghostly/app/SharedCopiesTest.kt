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
