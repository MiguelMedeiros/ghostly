package tools.ghostly.app

/**
 * The environment a debug e2e start (`--ez ghostly_e2e true`, MainActivity) gives Rust: every `GHOSTLY_*` string
 * extra, over the isolated defaults Desktop's e2e gets (packages/cli/test/support/network.ts
 * `isolatedDesktopNetworkEnv`): no public Pkarr relays and no public Mainline DHT (`GHOSTLY_PKARR_RELAYS` alone,
 * pkarr_network.rs), no n0 Iroh relays (paired_transport.rs), and no public STUN servers in the page's WebRTC
 * (`GHOSTLY_STUN=0`, which the page reads through `test_network`). `GHOSTLY_TEST_PUBLIC_NET=1` leaves the defaults
 * out, as on Desktop. Plain Kotlin, so a JVM unit test reads it.
 */
object E2eEnvironment {
  private val NAME = Regex("^GHOSTLY_[A-Z0-9_]+$")

  /** A port nothing listens on (discard), as network.ts `NOWHERE`. */
  private const val NOWHERE = "http://127.0.0.1:9"

  /** Whether an extra by this name may become an environment variable. */
  fun takes(name: String): Boolean = NAME.matches(name)

  /** The variables to set for these string extras; any other name is left out. */
  fun of(extras: Map<String, String>): Map<String, String> {
    val given = extras.filterKeys(::takes)
    if (given["GHOSTLY_TEST_PUBLIC_NET"] == "1") return given
    val isolated = mapOf("GHOSTLY_PKARR_RELAYS" to NOWHERE, "GHOSTLY_IROH_RELAYS" to NOWHERE, "GHOSTLY_STUN" to "0")
    return isolated + given
  }
}
