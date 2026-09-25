import { createInPageHost } from "@ghostly/browser/inPageHost";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { RELEASES_URL } from "../../src/lib/settings";
import { popupWindow } from "@ghostly/browser/proofs/oidc/popup";
import { DHT_POLL_INTERVALS, RelayTransport } from "@ghostly/core";
import type { NodeOptions } from "@ghostly/browser/engine/node";

/**
 * Tests only: `localStorage["ghostly-test-pace"] = "desktop"` makes this page's peer discover the way the
 * desktop app does: its poll intervals (it reaches the DHT directly, so it looks more often than a
 * browser may ask a relay), and no request budget of its own toward the relays (the desktop's Rust client
 * keeps that; here the "relays" are the test's, in the same process, or a front on that Rust client).
 * The pairing timing test is what sets it. Read once, when the peer is made.
 */
function testPace(): Pick<NodeOptions, "pollIntervals" | "transport"> {
  try {
    return localStorage.getItem("ghostly-test-pace") === "desktop"
      ? { pollIntervals: DHT_POLL_INTERVALS, transport: new RelayTransport({ requestsPerMinute: Infinity }) } : {};
  } catch { return {}; }
}

/**
 * Tests only: `localStorage["ghostly-test-iroh"] = "off"` keeps Iroh out of this page's peer, so the suite stays
 * offline (Iroh would reach its public relays) and a browser is WebRTC only, as specs written before Iroh expect.
 * The fixtures set it unless a spec asks for Iroh (and then points it at the test relay). Read once.
 */
function testIroh(): boolean {
  try { return localStorage.getItem("ghostly-test-iroh") !== "off"; } catch { return true; }
}

/**
 * Ghostly on the web: the peer runs in this page and lives as long as the tab.
 * Two things a web page cannot do stay with the extension and the desktop app:
 * reaching web apps on the user's machine (no way to be granted access, only
 * CORS), and giving a contact's web app an origin of its own to run on.
 */
export const webHost = createInPageHost({
  version: __APP_VERSION__,
  notice: "Beta. Keys and wallet data live in this browser. Pocket money only.",
  features: { shareLocalServices: false, openServices: false, profiles: true },
  // Iroh through a relay (WISP 102): where WebRTC cannot connect, before the chat drops to the DHT.
  node: { ...testPace(), irohWeb: testIroh() },

  /**
   * The deployed build says what it is in `/version.json`, on this origin and
   * nowhere else: nothing third-party learns that this tab is running Ghostly.
   * Applying it is a reload, which ends the peer and every call it holds, so
   * it only ever happens because the user pressed the button.
   */
  updates: {
    downloadUrl: RELEASES_URL,
    check: () =>
      checkVersionFeed({
        url: new URL("version.json", document.baseURI).toString(),
        currentVersion: __APP_VERSION__,
        currentBuild: __APP_BUILD__,
        apply: "reload",
      }),
    install: async () => window.location.reload(),
  },
  requestLocalAccess: async () => false,
  // A popup on this origin; the provider returns to /oidc-callback.html.
  oidc: { platform: "web", open: async () => popupWindow() },
  openService: async () => {
    throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
  },
});
