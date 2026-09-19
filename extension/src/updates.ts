import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import type { UpdateSource } from "@ghostly/browser/host";
import { RELEASES_URL } from "../../src/lib/settings";

/**
 * Where the newest release is published. It is Ghostly's own site, not a third
 * party: asking costs one request that says this browser runs Ghostly, and it
 * only goes out while the user allows the check at all.
 */
const LATEST_URL = "https://ghostly.tools/latest.json";

/** Set by the service worker when Chrome has a version ready. Gone when the browser closes. */
const PENDING_KEY = "ghostly_pending_update";

/**
 * Whether Chrome keeps this install up to date. It does for one from the Web
 * Store or a hosted `.crx`, and the manifest it hands back says so. An unpacked
 * folder is nobody's job but the user's: Chrome never updates it, and no API
 * here can, so the most Ghostly can do is say a new version exists.
 */
function managedByChrome(): boolean {
  return !!chrome.runtime.getManifest().update_url;
}

/** The service worker heard Chrome hold an update back because Ghostly is running. */
export async function rememberPendingUpdate(version: string): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: version });
}

async function pendingUpdate(): Promise<string | null> {
  try {
    const stored = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
    return typeof stored === "string" ? stored : null;
  } catch {
    return null;
  }
}

export const extensionUpdates: UpdateSource = {
  downloadUrl: RELEASES_URL,

  async check() {
    if (!managedByChrome()) {
      // Unpacked: the user replaces the folder themselves, so only say that there is one.
      return checkVersionFeed({
        url: LATEST_URL,
        currentVersion: chrome.runtime.getManifest().version,
        apply: "manual",
      });
    }

    const held = await pendingUpdate();
    if (held) return { version: held, apply: "restart" };

    // Chrome throttles this to a few an hour and answers from its own schedule.
    const result = await chrome.runtime.requestUpdateCheck();
    return result.status === "update_available" && result.version
      ? { version: result.version, apply: "restart" }
      : null;
  },

  /**
   * Chrome swaps the new version in when the extension stops running, which is
   * what this does. Every Ghostly page goes with it, so it only ever runs
   * because the user pressed the button.
   */
  async install() {
    chrome.runtime.reload();
  },
};
