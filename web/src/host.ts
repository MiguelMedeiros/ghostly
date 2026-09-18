import { createInPageHost } from "@ghostly/browser/inPageHost";

/**
 * Ghostly on the web: the peer runs in this page and lives as long as the tab.
 * Two things a web page cannot do stay with the extension and the desktop app:
 * reaching web apps on the user's machine (no way to be granted access, only
 * CORS), and giving a contact's web app an origin of its own to run on.
 */
export const webHost = createInPageHost({
  version: __APP_VERSION__,
  features: { shareLocalServices: false, openServices: false },
  requestLocalAccess: async () => false,
  openService: async () => {
    throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
  },
});
