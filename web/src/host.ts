import { createInPageHost } from "@ghostly/browser/inPageHost";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { applyUpdate, prepareUpdate } from "./pwa/serviceWorker";
import { RELEASES_URL } from "../../src/lib/settings";
import { popupWindow } from "@ghostly/browser/proofs/oidc/popup";
import { atprotoPopupWindow } from "@ghostly/browser/proofs/atproto/popup";
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
 * Tests only: `localStorage["ghostly-test-reactions"] = "off"` makes this page's peer an app from before reactions
 * (WISP 401 § Reactions): it never says `react/1`, so the compatibility spec can check what an older contact sees.
 * Read once.
 */
function testReactions(): Pick<NodeOptions, "reactions"> {
  try { return localStorage.getItem("ghostly-test-reactions") === "off" ? { reactions: false } : {}; } catch { return {}; }
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
  node: { ...testPace(), ...testReactions(), irohWeb: testIroh() },

  /**
   * The deployed build says what it is in `/version.json`, on this origin and
   * nowhere else: nothing third-party learns that this tab is running Ghostly.
   * Applying it is a reload, which ends the peer and every call it holds, so
   * it only ever happens because the user pressed the button. The app's files
   * come from the service worker's cache, so the reload first lets the new
   * worker (fetched as soon as the deploy is found) take over.
   */
  updates: {
    downloadUrl: RELEASES_URL,
    check: async () => {
      const found = await checkVersionFeed({
        url: new URL("version.json", document.baseURI).toString(),
        currentVersion: __APP_VERSION__,
        currentBuild: __APP_BUILD__,
        apply: "reload",
      });
      if (found) prepareUpdate();
      return found;
    },
    install: () => applyUpdate(),
  },
  requestLocalAccess: async () => false,
  // A popup on this origin; the provider returns to /oidc-callback.html.
  oidc: { platform: "web", open: async () => popupWindow() },
  // The same popup and callback page, for an AT Protocol server (Bluesky or another PDS).
  atproto: { platform: "web", open: async () => atprotoPopupWindow() },
  openService: async () => {
    throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
  },
});
