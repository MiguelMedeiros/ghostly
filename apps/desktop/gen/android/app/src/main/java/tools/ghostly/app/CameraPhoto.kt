package tools.ghostly.app

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream

/**
 * What a photo from the composer's Camera leaves with. The camera app writes it straight into [CameraFiles], so
 * Android's location redaction (MediaStore's, behind ACCESS_MEDIA_LOCATION) never reaches it: as the camera wrote it,
 * its Exif and XMP say where it was taken and with what. Only what draws the picture stays: the frame, its tables and
 * scans, JFIF, the ICC colour profile, Adobe's colour transform, and the camera's Orientation alone in an Exif of its
 * own (none when upright). Whatever follows the image's end (a gain map, a motion photo's video) goes too. Desktop's
 * Camera draws its photo on a canvas, which keeps no Exif at all.
 */
object CameraPhoto {
  private val SOI = byteArrayOf(0xFF.toByte(), 0xD8.toByte())
  private val EOI = byteArrayOf(0xFF.toByte(), 0xD9.toByte())
  private val EXIF = "Exif\u0000\u0000".toByteArray(Charsets.US_ASCII)
  private val JFIF = "JFIF\u0000".toByteArray(Charsets.US_ASCII)
  private val ICC = "ICC_PROFILE\u0000".toByteArray(Charsets.US_ASCII)
  private val ADOBE = "Adobe".toByteArray(Charsets.US_ASCII)
  private const val SOS = 0xDA
  private const val APP1 = 0xE1

  /**
   * Rewrites [photo] in place, under the same name. False, and [photo] as it was, when it is no whole JPEG (no frame,
   * no scan or no end, or a segment past the end): the caller then sends nothing.
   */
  fun strip(photo: File): Boolean {
    val part = File(photo.parentFile, "${photo.name}.part")
    val stripped = try {
      DataInputStream(BufferedInputStream(photo.inputStream())).use { input ->
        BufferedOutputStream(part.outputStream()).use { output -> strip(input, output) }
      }
    } catch (e: IOException) {
      false
    }
    if (stripped && part.renameTo(photo)) return true
    part.delete()
    return false
  }

  private fun strip(input: DataInputStream, output: OutputStream): Boolean {
    if (input.read() != 0xFF || input.read() != 0xD8) return false
    output.write(SOI)
    var framed = false
    var scanned = false
    var exif = false
    var marker = marker(input)
    while (true) {
      when (marker) {
        -1 -> return false
        0xD9 -> {
          if (!framed || !scanned) return false
          output.write(EOI)
          return true
        }
        // TEM and restarts stand alone.
        0x01, in 0xD0..0xD7 -> {
          output.write(0xFF)
          output.write(marker)
        }
        else -> {
          val length = input.readUnsignedShort()
          if (length < 2) return false
          val payload = ByteArray(length - 2).also { input.readFully(it) }
          if (keeps(marker, payload)) {
            output.write(0xFF)
            output.write(marker)
            output.write(length shr 8)
            output.write(length and 0xFF)
            output.write(payload)
            if (marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) framed = true
          } else if (marker == APP1 && !scanned && !exif && starts(payload, EXIF)) {
            exif = true
            turn(payload)?.let { output.write(orientationOnly(it)) }
          }
          if (marker == SOS) {
            if (!framed) return false
            scanned = true
            marker = scan(input, output)
            continue
          }
        }
      }
      marker = marker(input)
    }
  }

  /** The next marker, past any fill bytes; -1 at the end, or where no marker is. */
  private fun marker(input: DataInputStream): Int {
    if (input.read() != 0xFF) return -1
    var marker = input.read()
    while (marker == 0xFF) marker = input.read()
    return marker
  }

  /**
   * Copies a scan's image data, where FF 00 is a data byte and FF D0 to D7 a restart, and returns the marker that ends
   * it (-1 at the end of the file).
   */
  private fun scan(input: DataInputStream, output: OutputStream): Int {
    while (true) {
      val byte = input.read()
      if (byte < 0) return -1
      if (byte != 0xFF) {
        output.write(byte)
        continue
      }
      var next = input.read()
      while (next == 0xFF) next = input.read()
      if (next < 0) return -1
      if (next != 0x00 && next !in 0xD0..0xD7) return next
      output.write(0xFF)
      output.write(next)
    }
  }

  /** Frames, tables, scans and restart intervals (C0 to CF, DA to DF), and the APPn that only say how to draw it. */
  private fun keeps(marker: Int, payload: ByteArray): Boolean = when (marker) {
    in 0xC0..0xCF, in 0xDA..0xDF -> true
    0xE0 -> starts(payload, JFIF)
    0xE2 -> starts(payload, ICC)
    0xEE -> starts(payload, ADOBE)
    else -> false
  }

  private fun starts(payload: ByteArray, prefix: ByteArray): Boolean =
    payload.size >= prefix.size && prefix.indices.all { payload[it] == prefix[it] }

  /** IFD0's Orientation in an APP1 Exif, when it turns or mirrors the picture (2 to 8). */
  private fun turn(exif: ByteArray): Int? {
    val tiff = EXIF.size
    if (exif.size < tiff + 8) return null
    val little = exif[tiff] == 'I'.code.toByte() && exif[tiff + 1] == 'I'.code.toByte()
    if (!little && !(exif[tiff] == 'M'.code.toByte() && exif[tiff + 1] == 'M'.code.toByte())) return null
    fun u8(at: Int) = exif[at].toInt() and 0xFF
    fun u16(at: Int) = if (little) u8(at) or (u8(at + 1) shl 8) else (u8(at) shl 8) or u8(at + 1)
    fun u32(at: Int) = if (little) u16(at).toLong() or (u16(at + 2).toLong() shl 16) else (u16(at).toLong() shl 16) or u16(at + 2).toLong()
    if (u16(tiff + 2) != 42) return null
    val ifd = tiff + u32(tiff + 4)
    if (ifd + 2 > exif.size) return null
    val at = ifd.toInt()
    for (i in 0 until u16(at)) {
      val entry = at + 2 + i * 12
      if (entry + 12 > exif.size) return null
      // A SHORT: its value sits in the first two bytes of the value field.
      if (u16(entry) == 0x0112) return u16(entry + 8).takeIf { it in 2..8 }
    }
    return null
  }

  /** An APP1 Exif, big-endian, whose IFD0 holds [orientation] alone. */
  private fun orientationOnly(orientation: Int): ByteArray =
    intArrayOf(
      0xFF, APP1, 0, 34,
      'E'.code, 'x'.code, 'i'.code, 'f'.code, 0, 0,
      'M'.code, 'M'.code, 0, 42, 0, 0, 0, 8,
      0, 1,
      0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
      0, 0, 0, 0,
    ).let { bytes -> ByteArray(bytes.size) { bytes[it].toByte() } }
}
