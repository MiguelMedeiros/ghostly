import type { BrowserHost } from "@ghostly/browser/host";
import { UI_PORT, type RuntimeMessage, type ViewerPage } from "./messages";
import { extensionUpdates } from "./updates";
import { extensionOidc } from "./oidc";
import { extensionAtproto } from "./atproto";
import { loadSettings } from "../../ui/src/lib/settings";
import { languageTag, textDirection } from "../../ui/src/lib/documentLanguage";
import { translatorFor } from "../../ui/src/locales";
import { markEngineRestart, pageProfileIsCurrent, startAsProfileInUse } from "./profile";
import { setServiceWindowsCloser } from "../../ui/src/lib/serviceWindows";
import { forgetLocalAccess, releaseUnusedLocalAccess } from "./localAccess";

// A contact's app tabs close when the profile locks, as Desktop's windows do: the worker serves them, page or not.
setServiceWindowsCloser(() => void chrome.runtime.sendMessage({ target: "background", type: "close-services" } satisfies RuntimeMessage).catch(() => {}));

/** The viewer tab's error page in the profile's language, as it is now. */
export function viewerPage(): ViewerPage {
  const { language } = loadSettings();
  const t = translatorFor(language);
  return { lang: languageTag(language), dir: textDirection(language), unreachable: t("services.window.unreachable"), failed: t("services.window.failed") };
}

/** Ghostly Browser: the peer lives in the offscreen document, reached through extension messaging. */
export const extensionHost: BrowserHost = {
  version: chrome.runtime.getManifest().version,
  features: { shareLocalServices: true, openServices: true, profiles: true },
  updates: extensionUpdates,
  oidc: extensionOidc,
  atproto: extensionAtproto,

  async connect(onMessage, onDisconnect) {
    // Another tab switched profiles since this page started: it starts again as that one (ui/main.tsx)
    // rather than show one profile's pages over the other's peer.
    if (!pageProfileIsCurrent()) {
      startAsProfileInUse();
      throw new Error("Switching profiles…");
    }
    const ready = await chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" } satisfies RuntimeMessage);
    if (!ready?.ok) throw new Error(ready?.error ?? "The Ghostly peer is unavailable. Reopen the extension to retry.");
    // Another switch may have come while the peer started: this page's profile is no longer the one it runs.
    if (!pageProfileIsCurrent()) {
      startAsProfileInUse();
      throw new Error("Switching profiles…");
    }
    const port = chrome.runtime.connect({ name: UI_PORT });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      onDisconnect();
    });
    return { send: (request) => port.postMessage(request) };
  },

  async restartEngine() {
    const reply = await chrome.runtime.sendMessage({ target: "background", type: "restart-engine" } satisfies RuntimeMessage);
    if (!reply?.ok) throw new Error(reply?.error ?? "The Ghostly peer did not start again. Reopen the extension to retry.");
    // Every other tab of the extension is on the new peer now, still showing what the old one told it.
    markEngineRestart();
  },

  // Chrome's own prompt, and only from a user gesture.
  requestLocalAccess: (originPattern) => chrome.permissions.request({ origins: [originPattern] }),
  // Given back once no app of any profile is at that host, on any port (localAccess.ts).
  forgetLocalAccess,
  releaseUnusedLocalAccess,

  async openPaymentLink(uri) {
    const reply = await chrome.runtime.sendMessage({ target: "background", type: "open-payment-link", uri } satisfies RuntimeMessage);
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open a wallet");
  },

  async openService(peerPubKeyZ32, serviceId, tag) {
    // A page of the profile before a switch: the peer runs the other one now, which must not serve this one's app.
    if (!pageProfileIsCurrent()) {
      startAsProfileInUse();
      throw new Error("Switching profiles…");
    }
    const reply = await chrome.runtime.sendMessage({
      target: "background",
      type: "open-service",
      peerPubKeyZ32,
      serviceId,
      tag,
      page: viewerPage(),
    } satisfies RuntimeMessage);
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open the service");
  },
};
