import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../ui/src/Root";
import { PeerLockUnavailable, becomeThePeer } from "@ghostly/browser/inPageHost";
import { webHost } from "./host";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { openDeviceGate } from "@ghostly/browser/devices/gate";
import { setStorageProfile } from "../../ui/src/lib/storage";
import { activeProfileId, namespaceOf, setRunningProfile } from "../../ui/src/lib/profiles";
import { loadSettings } from "../../ui/src/lib/settings";
import { bootDetails, missingEssentials, type Essential } from "../../ui/src/lib/bootCheck";
import { UnsupportedBrowser } from "../../ui/src/components/UnsupportedBrowser";
import { locales } from "../../ui/src/locales";
import { translateWith } from "../../ui/src/locales/translate";
import { applyDocumentLanguage } from "../../ui/src/lib/documentLanguage";
import { watchInstallPrompt } from "../../ui/src/lib/installPrompt";
import { setPushPlatform } from "../../ui/src/lib/wakePush";
import { currentPush, pushSupported, subscribePush, syncWakeTable, unsubscribePush } from "./pwa/push";
import { SHARE_FORWARD_AFTER_MS, askForShare, forwardShare, listenForShares, openedForShare, registerServiceWorker } from "./pwa/serviceWorker";

// The same UI and the same peer as the extension; only the host differs.
const root = createRoot(document.getElementById("root")!);

// The installable web app (apps/web/src/sw): the offer to install can come before anything renders, and the worker
// is registered in every tab, including one that waits for another below.
watchInstallPrompt();
registerServiceWorker();
// Wake-up push (WISP 401 § Wake-up push): this app can be woken while closed; Settings shows the switch.
setPushPlatform({ supported: pushSupported, subscribe: subscribePush, current: currentPush, unsubscribe: unsubscribePush, syncTable: syncWakeTable });

// The chosen local profile (WISP 04): its own chats, database, settings and single-peer lock. The
// default profile keeps the original names, so nothing existing moves.
const profileId = activeProfileId();
const profile = namespaceOf(profileId);
// This tab stays that profile, even when it waits below and another tab chooses another one meanwhile.
setRunningProfile(profileId);
if (profile) { setStorageProfile(profile); setDatabaseName(`ghostly_${profile}`); }
// The profile's language on <html> before anything is painted (the I18nProvider keeps it in step from then on).
applyDocumentLanguage(loadSettings().language);

/**
 * "Ghostly can't run in this browser", in the profile's language, instead of the app: said rather than a blank page
 * or an app that never connects. Nothing else starts; the returned promise never settles, so the module stops here.
 */
function cannotRun(missing: Essential[], error?: unknown): Promise<never> {
  const language = loadSettings().language;
  const t = translateWith(locales[language] || locales.en, locales[language] ? language : "en");
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
  root.render(
    <div lang="en" style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }}>👻</div>
        <p>{sharing ? "Sent to Ghostly in your other tab." : "Ghostly is already open in another tab."}</p>
        <p style={{ fontSize: 13 }}>{sharing ? "Pick the chat there. You can close this one." : "Close it and this tab takes over."}</p>
      </div>
    </div>,
  );
  // The lock is there but the browser refuses it: the same screen as a browser without it.
}).catch((error: unknown) => (error instanceof PeerLockUnavailable ? cannotRun(["locks"], error) : Promise.reject(error)));

isPeer = true;
// The device state, before anything of the profile starts (WISP 06 § The gate): one small local read. A profile that
// never enrolled a device is `single` and goes on exactly as before. On a device that is not the active one nothing
// below touches the profile: no session sync, no share taken in, and the host starts device-link-only mode.
const gate = await openDeviceGate();
setBrowserHost(webHost);
if (gate.full) {
  startSessionSync();
  // Shares for this tab: the one it opened for, and any another tab forwards while this one is the app.
  listenForShares();
  askForShare();
}
addEventListener("pagehide", () => webHost.announceDeparture());

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
