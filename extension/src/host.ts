import type { BrowserHost } from "@ghostly/browser/host";
import { UI_PORT, type RuntimeMessage } from "./messages";

/** Ghostly Browser: the peer lives in the offscreen document, reached through extension messaging. */
export const extensionHost: BrowserHost = {
  version: chrome.runtime.getManifest().version,
  features: { shareLocalServices: true, openServices: true },

  async connect(onMessage, onDisconnect) {
    await chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" } satisfies RuntimeMessage);
    const port = chrome.runtime.connect({ name: UI_PORT });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      onDisconnect();
    });
    return { send: (request) => port.postMessage(request) };
  },

  // Chrome's own prompt, and only from a user gesture.
  requestLocalAccess: (originPattern) => chrome.permissions.request({ origins: [originPattern] }),

  async openService(peerPubKeyZ32, serviceId) {
    const reply = await chrome.runtime.sendMessage({
      target: "background",
      type: "open-service",
      peerPubKeyZ32,
      serviceId,
    } satisfies RuntimeMessage);
    if (!reply?.ok) throw new Error(reply?.error ?? "Could not open the service");
  },
};
