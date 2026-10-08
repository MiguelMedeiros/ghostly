package tools.ghostly.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class E2eEnvironmentTest {
  @Test
  fun takesOnlyGhostlyNames() {
    for (name in listOf("GHOSTLY_PKARR_RELAYS", "GHOSTLY_STUN", "GHOSTLY_E2E_2")) assertTrue(name, E2eEnvironment.takes(name))
    for (name in listOf("ghostly_e2e", "GHOSTLY_", "PATH", "LD_PRELOAD", "GHOSTLY_pkarr", "GHOSTLY_A-B", "GHOSTLY_A B", "XGHOSTLY_A", "GHOSTLY_A\n")) {
      assertFalse(name, E2eEnvironment.takes(name))
    }
  }

  @Test
  fun isolatedUnlessTheLauncherSaysOtherwise() {
    assertEquals(
      mapOf("GHOSTLY_PKARR_RELAYS" to "http://127.0.0.1:9", "GHOSTLY_IROH_RELAYS" to "http://127.0.0.1:9", "GHOSTLY_STUN" to "0"),
      E2eEnvironment.of(mapOf("LD_PRELOAD" to "/x.so", "tools.ghostly.app.notification" to "x")),
    )
    val given = E2eEnvironment.of(mapOf("GHOSTLY_PKARR_RELAYS" to "http://127.0.0.1:4000"))
    assertEquals("http://127.0.0.1:4000", given["GHOSTLY_PKARR_RELAYS"])
    assertEquals("http://127.0.0.1:9", given["GHOSTLY_IROH_RELAYS"])
    assertEquals("0", given["GHOSTLY_STUN"])
  }

  @Test
  fun publicNetworksOnlyWithTheOptIn() {
    assertEquals(mapOf("GHOSTLY_TEST_PUBLIC_NET" to "1"), E2eEnvironment.of(mapOf("GHOSTLY_TEST_PUBLIC_NET" to "1")))
  }
}
