package tools.ghostly.app

/**
 * The name a shared stream's copy takes in its cache folder (GhostlyHostPlugin `shared`): the name the sharing app
 * gave, or `shared-N` when it gave none that a file can have. Plain Kotlin, so a JVM unit test reads it.
 */
object SharedName {
  /** Bytes f2fs and ext4 take in one name (NAME_MAX): 86 CJK characters are over it. */
  private const val NAME_BYTES = 255
  private val EXTENSION = Regex("\\.[^.\\s]{1,15}$")

  fun of(displayName: String?, index: Int): String =
    fit(displayName?.replace('/', '_')?.takeIf { it.isNotBlank() && it != "." && it != ".." } ?: "shared-${index + 1}")

  /**
   * A name over NAME_MAX loses the end of its stem, a whole character at a time, until it fits; its extension stays,
   * so "文…文.pdf" still opens as a PDF (the CLI's `fitName`, packages/cli/src/files.ts).
   */
  private fun fit(name: String): String {
    if (fits(name)) return name
    val extension = EXTENSION.find(name)?.value ?: ""
    var stem = name.dropLast(extension.length)
    while (stem.isNotEmpty() && !fits(stem.trimEnd() + extension)) stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
    return stem.trimEnd().ifEmpty { "file" } + extension
  }

  private fun fits(name: String) = name.toByteArray(Charsets.UTF_8).size <= NAME_BYTES
}
