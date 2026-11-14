import { createInPageHost } from "@ghostly/browser/inPageHost";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { applyUpdate, buildGone, onBuildGone, prepareUpdate } from "./pwa/serviceWorker";
import { RELEASES_URL } from "../../ui/src/lib/settings";
import { builtInAppOption } from "../../ui/src/lib/apps/builtIns";
import { popupWindow } from "@ghostly/browser/proofs/oidc/popup";
import { atprotoPopupWindow } from "@ghostly/browser/proofs/atproto/popup";
import { DHT_POLL_INTERVALS, GhostlyHttpError, RelayTransport, viewerTag } from "@ghostly/core";
import type { NodeOptions } from "@ghostly/browser/engine/node";
import { defaultWalletsAllowed } from "@ghostly/browser/platform/walletSetupSwitch";
import { engine } from "@ghostly/browser/platform/engine";
import { testSwitch } from "@ghostly/browser/shared/features";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { closeServiceView, parseServicesHost } from "./svc/protocol";
import { SERVICE_LOCKED, hostErrorText, serviceFraming, serviceWindowsClosedSince, setServiceViewCloser, setServiceWindowsCloser } from "../../ui/src/lib/serviceWindows";
import { loadSettings } from "../../ui/src/lib/settings";
import { activeProfileId, listProfiles } from "../../ui/src/lib/profiles";
import { OPENED_KEY } from "../../ui/src/lib/openedServices";
import { chatNamesForPeer } from "../../ui/src/lib/storage";
import { translatorFor } from "../../ui/src/locales";

/**
 * Tests only: `localStorage["ghostly-test-pace"] = "desktop"` makes this page's peer discover the way the
 * desktop app does: its poll intervals (it reaches the DHT directly, so it looks more often than a
 * browser may ask a relay), and no request budget of its own toward the relays (the desktop's Rust client
 * keeps that; here the "relays" are the test's, in the same process, or a front on that Rust client).
 * The pairing timing test is what sets it. A test build only (`testSwitch`). Read once, when the peer is made.
 */
function testPace(): Pick<NodeOptions, "pollIntervals" | "transport"> {
  return testSwitch("ghostly-test-pace") === "desktop"
    ? { pollIntervals: DHT_POLL_INTERVALS, transport: new RelayTransport({ requestsPerMinute: Infinity }) } : {};
}

/**
 * Tests only: `localStorage["ghostly-test-iroh"] = "off"` keeps Iroh out of this page's peer, so the suite stays
 * offline (Iroh would reach its public relays) and a browser is WebRTC only, as specs written before Iroh expect.
 * The fixtures set it unless a spec asks for Iroh (and then points it at the test relay). A test build only: against a
 * deployed one (`E2E_WEB_URL`) the fixtures point Iroh at a closed port instead, as for the extension. Read once.
 */
function testIroh(): boolean {
  return testSwitch("ghostly-test-iroh") !== "off";
}

/**
 * Tests only: `localStorage["ghostly-test-reactions"] = "off"` makes this page's peer an app from before reactions
 * (WISP 401 § Reactions): it never says `react/1`, so the compatibility spec can check what an older contact sees.
 * A test build only. Read once.
 */
function testReactions(): Pick<NodeOptions, "reactions"> {
  return testSwitch("ghostly-test-reactions") === "off" ? { reactions: false } : {};
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
/**
 * The `viewerTag` of each chat this page's profile has, once the engine has loaded them all (`transfersRestored`): a
 * state it sends while it starts may list only some. Before that, undefined. A group's edges count too.
 */
function chatTags(): string[] | undefined {
  const state = engine.state;
  if (!state?.transfersRestored) return undefined;
  return [...state.links, ...(state.edges ?? [])].map((link) => viewerTag(link.myPubKeyZ32));
}
/**
 * What the contacts' apps a deleted profile or chat opened kept on their origins, where Delete profile or Delete chat
 * could not reach them (offline, the services host down, the tab closed during the clear): cleared at each start
 * (a deleted chat's once the chats are loaded) and each return online (`forgetServicesOfGone`,
 * `forgetServicesOfChatsGone`). Nothing of it loads while no app was ever noted.
 */
let forgettingGone = false;
let forgetAgain = false;
function forgetServicesOfDeleted(): void {
  const host = servicesHost;
  try {
    if (!host || !navigator.onLine || !localStorage.getItem(OPENED_KEY)) return;
  } catch { return; }
  // The chats loaded during a sweep: one more after it, with them.
  if (forgettingGone) { forgetAgain = true; return; }
  forgettingGone = true;
  void import("./svc/forget")
    .then(async ({ forgetServicesOfGone, forgetServicesOfChatsGone }) => {
      await forgetServicesOfGone(host, listProfiles().map((p) => p.id));
      const tags = chatTags();
      if (tags) await forgetServicesOfChatsGone(host, activeProfileId(), tags);
    })
    .catch(() => {})
    .finally(() => {
      forgettingGone = false;
      if (forgetAgain) { forgetAgain = false; forgetServicesOfDeleted(); }
    });
}
forgetServicesOfDeleted();
addEventListener("online", forgetServicesOfDeleted);
if (servicesHost) {
  const stopWaiting = engine.subscribe(() => {
    if (!chatTags()) return;
    stopWaiting();
    forgetServicesOfDeleted();
  });
}
/**
 * Hide my IP from contacts is on: a contact's app does not open here. No policy this page sends keeps a Chromium browser
 * from connecting to a server a frame in the app points at (its "Preload pages" connects before the policy refuses the
 * frame), and that server would see this device's address. The extension (`RELAY_ONLY_REFUSED` in its background.ts)
 * and `ghostly service open` refuse too; the Desktop app opens one.
 */
const RELAY_ONLY_REFUSED = "A contact's app does not open in the web app while Hide my IP from contacts is on";
let peer: EngineServer | null = null;
// A contact's app closes when the profile locks, as Desktop's windows do: this page answers its requests.
// A reload ends it with the page.
setServiceWindowsCloser(closeServiceView);
// Drawn over the whole app, it makes way for a call that rings or starts: the call's windows are under it.
setServiceViewCloser(closeServiceView);

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
  openService: async (peerPubKeyZ32, serviceId, tag, relayOnly) => {
    if (relayOnly) throw new Error(RELAY_ONLY_REFUSED);
    const node = peer?.node;
    if (!servicesHost || !node) throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
    const t = translatorFor(loadSettings().language);
    const title = engine.linkByPeer(peerPubKeyZ32)?.peerServices?.find((s) => s.id === serviceId)?.name ?? serviceId;
    // The profile locking while it loads closes nothing yet: the app is never shown (`openServiceView` asks too).
    const locked = serviceWindowsClosedSince();
    // Loaded when first used: nothing of it is in the app's start.
    const [{ openServiceView, serviceLabel }, { noteOpened }] = await Promise.all([import("./svc/opener"), import("./svc/forget")]);
    if (locked()) throw new Error(SERVICE_LOCKED);
    // Noted first: what the app keeps on its origin goes with the chat, its data or its profile (`forgetServices`).
    noteOpened({ profile: activeProfileId(), tag, label: await serviceLabel(tag, peerPubKeyZ32, serviceId) });
    if (locked()) throw new Error(SERVICE_LOCKED);
    // The contact is offline once their app no longer says what it shares (the chat's strip drops the app then): a
    // request is answered as unreachable at once, rather than waiting on a connection that is not coming.
    const offline = () => { const link = engine.linkByPeer(peerPubKeyZ32); return !link || link.peerServices === null; };
    await openServiceView({
      host: servicesHost, tag, peer: peerPubKeyZ32, service: serviceId, title, relayOnly,
      send: (request) => offline() ? Promise.reject(new GhostlyHttpError("offline", "Your contact is offline")) : node.request(peerPubKeyZ32, serviceId, request),
      // Try again reaches the contact now, as the chat's Reconnect does.
      presence: { offline, watch: (changed) => engine.subscribe(changed), connect: async () => { const link = engine.linkByPeer(peerPubKeyZ32); if (link) await engine.call("connect", { linkId: link.id }); } },
      words: {
        unreachable: t("services.window.unreachable"), failed: t("services.window.failed"), close: t("common.close"), callOn: t("services.window.callOn", { app: title }),
        tooSlow: t("services.window.tooSlow", { app: title }), offline: t("services.window.offline", { app: title }), retry: t("services.window.retry"),
        reaching: t("services.window.reaching"), stillOffline: t("services.window.stillOffline", { app: title }),
        blocked: t("services.window.blocked", { app: title }), unguarded: t("services.window.unguarded", { app: title }),
        ...serviceFraming(title, chatNamesForPeer(peerPubKeyZ32), peerPubKeyZ32, t),
        hostError: (headers) => hostErrorText(headers, title, t),
      },
    });
  },
  forgetServices: async (which) => {
    if (!servicesHost) return;
    const { forgetServices } = await import("./svc/forget");
    await forgetServices(servicesHost, which);
  },
});
