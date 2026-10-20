import { createInPageHost } from "@ghostly/browser/inPageHost";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { applyUpdate, buildGone, onBuildGone, prepareUpdate } from "./pwa/serviceWorker";
import { RELEASES_URL } from "../../ui/src/lib/settings";
import { builtInAppOption } from "../../ui/src/lib/apps/builtIns";
import { popupWindow } from "@ghostly/browser/proofs/oidc/popup";
import { atprotoPopupWindow } from "@ghostly/browser/proofs/atproto/popup";
import { DHT_POLL_INTERVALS, RelayTransport } from "@ghostly/core";
import type { NodeOptions } from "@ghostly/browser/engine/node";
import { defaultWalletsAllowed } from "@ghostly/browser/platform/walletSetupSwitch";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { closeServiceView, parseServicesHost } from "./svc/protocol";
import { setServiceWindowsCloser } from "../../ui/src/lib/serviceWindows";
import { loadSettings } from "../../ui/src/lib/settings";
import { translatorFor } from "../../ui/src/locales";

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
 * Where a contact's shared web app runs (src/svc/): an origin of its own under the services host this build was given
 * (`VITE_SERVICES_HOST`, `https://*.<domain>`), never the app's. A build without one, or a browser without service
 * workers, opens none, and the button says the extension or the desktop app can.
 */
const servicesHost = parseServicesHost(import.meta.env.VITE_SERVICES_HOST as string | undefined);
function serviceWorkersHere(): boolean {
  try { return "serviceWorker" in navigator && window.isSecureContext && !!navigator.serviceWorker; } catch { return false; }
}
/**
 * Tests only: the suite's build has a services host on this machine (`http://*.localhost`, which no deployed build can
 * have: plain HTTP is refused anywhere else), and there a page opens contacts' apps only where
 * `localStorage["ghostly-test-services"] = "on"` (web/services-web-open.spec.ts), so every other web spec still meets
 * a web app that offers none. Read once, when the peer is made.
 */
function servicesUnderTest(): boolean {
  if (servicesHost?.protocol !== "http:") return true;
  try { return localStorage.getItem("ghostly-test-services") === "on"; } catch { return false; }
}
/**
 * Whether this page opens a contact's app: then its chats offer `services/1` (WISP 401), so a contact lists what it
 * shares with this side, and the apps strip shows it. Sharing one stays with the extension and the desktop app.
 */
const openServices = !!servicesHost && serviceWorkersHere() && servicesUnderTest();
let peer: EngineServer | null = null;
// A contact's app closes when the profile locks, as Desktop's windows do: this page answers its requests.
// A reload ends it with the page.
setServiceWindowsCloser(closeServiceView);

/**
 * Ghostly on the web: the peer runs in this page and lives as long as the tab.
 * One thing a web page cannot do stays with the extension and the desktop app:
 * reaching web apps on the user's machine (no way to be granted access, only
 * CORS). A contact's web app opens here when the build has a services host.
 */
export const webHost = createInPageHost({
  version: __APP_VERSION__,
  features: { shareLocalServices: false, openServices, profiles: true },
  onServer: (server) => { peer = server; },
  // Mini-apps run in this server's runner page (apps/web/public/app-frame.html, its header in nginx.conf; WISP 1200).
  appRunner: "/app-frame.html",
  appNetRunner: "/app-frame-net.html",
  // Iroh through a relay (WISP 102): where WebRTC cannot connect, before the chat drops to the DHT.
  // A new profile gets its default Mainnet wallets, never under test (see defaultWalletsAllowed).
  // Mini-apps by the build's flag (APPS_ENABLED); on whatever it says in the e2e suite's build (VITE_APPS_TEST, fixed at build time),
  // and held items read from its local S3 server there.
  // The apps that come with Ghostly are read from this build's own files (`builtInAppOption`), never from a server of theirs.
  node: { ...testPace(), ...testReactions(), irohWeb: testIroh(), servicesSupport: openServices, defaultWallets: defaultWalletsAllowed(), ...builtInAppOption(), ...(import.meta.env.VITE_APPS_TEST === "1" ? { apps: true, holdLoopback: true } : {}) },

  /**
   * The deployed build says what it is in `/version.json`, on this origin and
   * nowhere else: nothing third-party learns that this tab is running Ghostly.
   * Applying it is a reload, which ends the peer and every call it holds, so
   * it only ever happens because the user pressed the button. The app's files
   * come from the service worker's cache, so the reload first lets the new
   * worker (fetched as soon as the deploy is found) take over. Once the worker
   * found a file of this build gone from the server, the check runs at once
   * and a redeploy of the same version counts: what runs cannot load its
   * wallets any more.
   */
  updates: {
    downloadUrl: RELEASES_URL,
    check: async () => {
      const found = await checkVersionFeed({
        url: new URL("version.json", document.baseURI).toString(),
        currentVersion: __APP_VERSION__,
        currentBuild: __APP_BUILD__,
        buildGone: buildGone(),
        apply: "reload",
      });
      if (found) prepareUpdate();
      return found;
    },
    install: () => applyUpdate(),
    onBuildGone,
  },
  requestLocalAccess: async () => false,
  // A popup on this origin; the provider returns to /oidc-callback.html.
  oidc: { platform: "web", open: async () => popupWindow() },
  // The same popup and callback page, for an AT Protocol server (Bluesky or another PDS).
  atproto: { platform: "web", open: async () => atprotoPopupWindow() },
  openService: async (peerPubKeyZ32, serviceId, tag) => {
    const node = peer?.node;
    if (!servicesHost || !node) throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
    const t = translatorFor(loadSettings().language);
    const title = engine.linkByPeer(peerPubKeyZ32)?.peerServices?.find((s) => s.id === serviceId)?.name ?? serviceId;
    // Loaded when first used: nothing of it is in the app's start.
    const { openServiceView } = await import("./svc/opener");
    await openServiceView({
      host: servicesHost, tag, peer: peerPubKeyZ32, service: serviceId, title,
      send: (request) => node.request(peerPubKeyZ32, serviceId, request),
      words: { unreachable: t("services.window.unreachable"), failed: t("services.window.failed"), close: t("common.close") },
    });
  },
});
