package tools.ghostly.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File

class CameraPhotoTest {
  @get:Rule
  val temp = TemporaryFolder()

  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  private fun ascii(text: String) = text.toByteArray(Charsets.US_ASCII)

  private fun join(vararg parts: ByteArray) = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()

  private fun segment(marker: Int, payload: ByteArray) =
    join(bytes(0xFF, marker, (payload.size + 2) shr 8, (payload.size + 2) and 0xFF), payload)

  private val soi = bytes(0xFF, 0xD8)
  private val eoi = bytes(0xFF, 0xD9)
  private val jfif = segment(0xE0, join(ascii("JFIF\u0000"), bytes(1, 1, 0, 0, 1, 0, 1, 0, 0)))
  private val icc = segment(0xE2, join(ascii("ICC_PROFILE\u0000"), bytes(1, 1), ByteArray(16) { 7 }))
  private val adobe = segment(0xEE, join(ascii("Adobe"), bytes(0, 100, 0, 0, 0, 0, 1)))
  private val dqt = segment(0xDB, join(bytes(0), ByteArray(64) { 1 }))
  private val sof0 = segment(0xC0, bytes(8, 0x0B, 0xB8, 0x0F, 0xA0, 1, 1, 0x11, 0))
  private val sof2 = segment(0xC2, bytes(8, 0x0B, 0xB8, 0x0F, 0xA0, 1, 1, 0x11, 0))
  // A table whose values hold FF D9, which is no end of the image inside a segment.
  private val dht = segment(0xC4, join(bytes(0), ByteArray(15), bytes(2, 0xFF, 0xD9)))
  private val sos = segment(0xDA, bytes(1, 1, 0, 0, 0x3F, 0))
  // Image data with a stuffed FF 00 and a restart marker, both kept as they are.
  private val scan = bytes(0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56)

  /** A camera app's APP1 Exif, big-endian: Make, Orientation, and a GPS IFD at 48°51'29.6"N. */
  private fun cameraExif(orientation: Int): ByteArray {
    val tiff = join(
      ascii("MM"), bytes(0, 42, 0, 0, 0, 8),
      // IFD0 at 8: 3 entries, ends at 50.
      bytes(0, 3),
      bytes(0x01, 0x0F, 0, 2, 0, 0, 0, 8, 0, 0, 0, 50),
      bytes(0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0),
      bytes(0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 58),
      bytes(0, 0, 0, 0),
      ascii("Pixel 9\u0000"),
      // GPS IFD at 58: LatitudeRef N, Latitude at 88.
      bytes(0, 2),
      bytes(0x00, 0x01, 0, 2, 0, 0, 0, 2, 'N'.code, 0, 0, 0),
      bytes(0x00, 0x02, 0, 5, 0, 0, 0, 3, 0, 0, 0, 88),
      bytes(0, 0, 0, 0),
      bytes(0, 0, 0, 48, 0, 0, 0, 1, 0, 0, 0, 51, 0, 0, 0, 1, 0, 0, 1, 0x28, 0, 0, 0, 10),
    )
    return segment(0xE1, join(ascii("Exif\u0000\u0000"), tiff))
  }

  /** What is left of the camera's Exif: Orientation alone. */
  private fun orientationOnly(orientation: Int) = segment(
    0xE1,
    join(
      ascii("Exif\u0000\u0000"), ascii("MM"), bytes(0, 42, 0, 0, 0, 8),
      bytes(0, 1), bytes(0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0), bytes(0, 0, 0, 0),
    ),
  )

  private val xmp = segment(
    0xE1,
    join(ascii("http://ns.adobe.com/xap/1.0/\u0000"), ascii("<x:xmpmeta exif:GPSLatitude=\"48,51.49N\"/>")),
  )
  private val mpf = segment(0xE2, join(ascii("MPF\u0000"), ascii("MM"), bytes(0, 42, 0, 0, 0, 8)))
  private val iptc = segment(0xED, join(ascii("Photoshop 3.0\u0000"), ascii("8BIM Sublocation")))
  private val comment = segment(0xFE, ascii("Pixel 9 serial 1A2B3C"))

  private fun stripped(input: ByteArray): ByteArray? {
    val photo = File(temp.newFolder(), "JPEG_20261017_144100_123.jpg").apply { writeBytes(input) }
    val ok = CameraPhoto.strip(photo)
    // In place, under its name, and nothing left beside it.
    assertEquals(listOf(photo.name), photo.parentFile!!.list()!!.toList())
    return if (ok) photo.readBytes() else null
  }

  private fun contains(haystack: ByteArray, needle: ByteArray) =
    (0..haystack.size - needle.size).any { at -> needle.indices.all { haystack[at + it] == needle[it] } }

  @Test
  fun aCameraPhotoLeavesWithoutWhereOrWhatTookIt() {
    // A second image after the end (a gain map or a motion photo) with Exif of its own.
    val trailer = join(soi, cameraExif(1), dqt, sof0, dht, sos, scan, eoi, ascii("MotionPhoto_Data"))
    val camera = join(soi, jfif, cameraExif(6), xmp, icc, mpf, iptc, comment, adobe, dqt, sof0, dht, sos, scan, eoi, trailer)
    val out = stripped(camera)!!
    assertArrayEquals(join(soi, jfif, orientationOnly(6), icc, adobe, dqt, sof0, dht, sos, scan, eoi), out)
    for (leak in listOf("Pixel", "GPS", "xap", "MPF", "Photoshop", "MotionPhoto")) assertFalse(leak, contains(out, ascii(leak)))
    assertFalse(contains(out, bytes(0x88, 0x25)))
  }

  @Test
  fun anUprightPhotoKeepsNoExifAtAll() {
    assertArrayEquals(join(soi, dqt, sof0, sos, scan, eoi), stripped(join(soi, cameraExif(1), dqt, sof0, sos, scan, eoi)))
    assertArrayEquals(join(soi, dqt, sof0, sos, scan, eoi), stripped(join(soi, dqt, sof0, sos, scan, eoi)))
  }

  @Test
  fun aLittleEndianOrientationIsRead() {
    val exif = segment(
      0xE1,
      join(
        ascii("Exif\u0000\u0000"), ascii("II"), bytes(42, 0, 8, 0, 0, 0),
        bytes(2, 0), bytes(0x0F, 0x01, 2, 0, 2, 0, 0, 0, 'X'.code, 0, 0, 0), bytes(0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0),
        bytes(0, 0, 0, 0),
      ),
    )
    assertArrayEquals(join(soi, orientationOnly(8), dqt, sof0, sos, scan, eoi), stripped(join(soi, exif, dqt, sof0, sos, scan, eoi)))
  }

  @Test
  fun aProgressivePhotoKeepsEveryScanAndDropsMetadataBetweenThem() {
    val camera = join(soi, cameraExif(3), dqt, sof2, dht, sos, scan, dht, cameraExif(6), comment, sos, scan, eoi)
    assertArrayEquals(join(soi, orientationOnly(3), dqt, sof2, dht, sos, scan, dht, sos, scan, eoi), stripped(camera))
  }

  @Test
  fun whatIsNoWholeJpegIsRefused() {
    val png = join(bytes(0x89), ascii("PNG\r\n\u001a\n"), ByteArray(32))
    val cut = join(soi, cameraExif(6)).copyOf(40)
    val noEnd = join(soi, cameraExif(6), dqt, sof0, sos, scan)
    val noImage = join(soi, cameraExif(6), dqt, eoi)
    for (input in listOf(ByteArray(0), png, cut, noEnd, noImage)) assertNull(stripped(input))
  }
}
