import { createInPageHost } from "@ghostly/browser/inPageHost";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { RELEASES_URL } from "../../src/lib/settings";

/**
 * Ghostly on the web: the peer runs in this page and lives as long as the tab.
 * Two things a web page cannot do stay with the extension and the desktop app:
 * reaching web apps on the user's machine (no way to be granted access, only
 * CORS), and giving a contact's web app an origin of its own to run on.
 */
export const webHost = createInPageHost({
  version: __APP_VERSION__,
  notice: "Beta. Keys and sats live in this browser. Pocket money only.",
  features: { shareLocalServices: false, openServices: false },

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
  openService: async () => {
    throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
  },
});
