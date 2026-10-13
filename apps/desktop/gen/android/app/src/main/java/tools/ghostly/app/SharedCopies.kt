package tools.ghostly.app

import java.io.File

/**
 * The copies of shares from other apps in the app's cache (GhostlyHostPlugin `shared`): a folder per share under the
 * root, named by the share's number, holding a folder per file. Which of them may go. Plain Kotlin, so a JVM unit
 * test reads it.
 */
object SharedCopies {
  /** The share folders the files at `paths` are in. A path outside the root, or not in a share's folder, names none. */
  fun foldersOf(root: File, paths: List<String>): Set<File> {
    val top = root.canonicalFile
    return paths.mapNotNull { path ->
      val file = File(path).canonicalFile
      var folder: File? = file
      while (folder != null && folder.parentFile != top) folder = folder.parentFile
      folder?.takeIf { it != file && it.name.toLongOrNull() != null }
    }.toSet()
  }

  /** What earlier runs left under the root: everything but the folders of shares numbered after `since`. */
  fun stale(root: File, since: Long): List<File> =
    root.listFiles()?.filter { (it.name.toLongOrNull() ?: Long.MIN_VALUE) <= since } ?: emptyList()
}
