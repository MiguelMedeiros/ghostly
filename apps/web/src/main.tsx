import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../ui/src/Root";
import { PeerLockUnavailable, becomeThePeer } from "@ghostly/browser/inPageHost";
import { webHost } from "./host";
import { openDeviceGate } from "@ghostly/browser/devices/gate";
import { setHandoffProfileHost } from "@ghostly/browser/devices/handoffHost";
import { handoffProfileHost, recoverHandoffPointer } from "../../ui/src/lib/handoffProfile";
import { openProfile } from "../../ui/src/lib/profileStart";
import { loadSettings } from "../../ui/src/lib/settings";
import { bootDetails, missingEssentials, type Essential } from "../../ui/src/lib/bootCheck";
import { UnsupportedBrowser } from "../../ui/src/components/UnsupportedBrowser";
import { OtherTab } from "../../ui/src/components/OtherTab";
import { locales } from "../../ui/src/locales";
import { translateWith } from "../../ui/src/locales/translate";
import { watchInstallPrompt } from "../../ui/src/lib/installPrompt";
import { setPushPlatform } from "../../ui/src/lib/wakePush";
import { APPS_ENABLED } from "@ghostly/browser/shared/features";
import { servicesPlatform } from "../../ui/src/lib/platform";
import { setAppOpener, takedownText } from "../../ui/src/lib/apps/open";
import { webOpener } from "../../ui/src/lib/apps/webOpener";
import { currentPush, pushSupported, subscribePush, syncWakeTable, syncWakeText, unsubscribePush } from "./pwa/push";
import { SHARE_FORWARD_AFTER_MS, askForShare, forwardShare, listenForShares, openedForShare, registerServiceWorker } from "./pwa/serviceWorker";

// A build for the e2e suite runs mini-apps through the real runner and broker before the app has a screen for them.
if (import.meta.env.VITE_APPS_TEST === "1") void import("../../ui/src/lib/apps/testHook").then((hook) => hook.installAppsTestHook());

// The same UI and the same peer as the extension; only the host differs.
const root = createRoot(document.getElementById("root")!);

// The installable web app (apps/web/src/sw): the offer to install can come before anything renders, and the worker
// is registered in every tab, including one that waits for another below.
watchInstallPrompt();
registerServiceWorker();
// Wake-up push (WISP 401 § Wake-up push): this app can be woken while closed; Settings shows the switch.
setPushPlatform({ supported: pushSupported, subscribe: subscribePush, current: currentPush, unsubscribe: unsubscribePush, syncTable: syncWakeTable, syncText: syncWakeText });

// The chosen local profile (WISP 04): its own chats, database, settings and single-peer lock. The
// default profile keeps the original names, so nothing existing moves. A profile a handoff moved whose pointer was lost
// is pointed at its state again before anything opens storage. Its language is on <html> before the first paint (the
// I18nProvider keeps it in step from then on).
const profile = await openProfile(recoverHandoffPointer);

/** The profile's language, for what the entry draws before the app (and its providers) can. */
function profileTranslator() {
  const language = loadSettings().language;
  return translateWith(locales[language] || locales.en, locales[language] ? language : "en");
}

/**
 * "Ghostly can't run in this browser", in the profile's language, instead of the app: said rather than a blank page
 * or an app that never connects. Nothing else starts; the returned promise never settles, so the module stops here.
 */
function cannotRun(missing: Essential[], error?: unknown): Promise<never> {
  const t = profileTranslator();
  root.render(<UnsupportedBrowser missing={missing} details={bootDetails(missing, error)} t={t} />);
  return new Promise<never>(() => {});
}

// What the app cannot run without (storage, IndexedDB, Web Crypto, Web Locks), before anything touches it.
const missing = await missingEssentials();
if (missing.length) await cannotRun(missing);

let isPeer = false;
await becomeThePeer(profile ? `ghostly-peer-${profile}` : "ghostly-peer", () => {
  // Opened for a share while the app runs in another tab: that tab gets it. Not at once: a share posted from this
  // same tab (the system opens the app's window for it) replaces a page that holds the lock a moment longer on its
  // way out, and a forward then would hand the share to that page as it goes. Once the lock is this tab's, it asks.
  const sharing = openedForShare();
  if (sharing) setTimeout(() => { if (!isPeer) forwardShare(); }, SHARE_FORWARD_AFTER_MS);
  root.render(<OtherTab sharing={!!sharing} t={profileTranslator()} />);
  // The lock is there but the browser refuses it: the same screen as a browser without it.
}).catch((error: unknown) => (error instanceof PeerLockUnavailable ? cannotRun(["locks"], error) : Promise.reject(error)));

isPeer = true;
// The device state, before anything of the profile starts (WISP 06 § The gate): one small local read. A profile that
// never enrolled a device is `single` and goes on exactly as before. On a device that is not the active one nothing
// below touches the profile: no session sync, no share taken in, and the host starts device-link-only mode.
const gate = await openDeviceGate();
// What a handoff reads and writes of a profile's storage (WISP 06 § The handoff), before the host starts the engine.
setHandoffProfileHost(handoffProfileHost(webHost.version, "web"));
setBrowserHost(webHost);
if (gate.full) {
  startSessionSync();
  // Shares for this tab: the one it opened for, and any another tab forwards while this one is the app.
  listenForShares();
  askForShare();
}
addEventListener("pagehide", () => webHost.announceDeparture());
// Mini-apps (WISP 1200) open in this server's runner, once the feature is on (or in the e2e suite's build).
if (gate.full && (APPS_ENABLED || import.meta.env.VITE_APPS_TEST === "1")) {
  setAppOpener(webOpener({
    apps: () => servicesPlatform?.apps,
    closeLabel: () => profileTranslator()("common.close"),
    stoppedLabel: (title, takedown) => takedownText(title, takedown, profileTranslator()),
  }));
}

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
