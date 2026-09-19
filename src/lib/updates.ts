import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { RELEASES_URL } from "./settings";

export interface FoundUpdate {
  version: string;
  /**
   * The exact build, where the platform marks one. The web app deploys many
   * builds of the same version, and putting one aside must not put the next
   * one aside with it.
   */
  build?: string;
  /** Release notes, where the platform publishes them. */
  notes?: string;
  /**
   * What putting it in place takes here. `manual` means this client cannot
   * install it — a `.deb` desktop build, an unpacked extension — and the UI
   * offers the download instead of a button.
   */
  apply: "restart" | "reload" | "manual";
  /** The platform's own handle on the update. Nothing outside the platform looks inside. */
  handle?: unknown;
}

/**
 * Finding out that a new version exists, and putting it in place. What that
 * means differs per client: the desktop app downloads and restarts into it,
 * the web app reloads the tab, and an unpacked extension can only be pointed
 * at the download.
 *
 * Every implementation asks the network only when the user allows it: the
 * check is a request that says this device runs Ghostly, so it is a setting.
 */
export interface UpdatePlatform {
  /** Where someone installing by hand should go. */
  readonly downloadUrl: string;
  /** The newest published version, or null when this client already runs it. */
  check(): Promise<FoundUpdate | null>;
  /** Puts it in place. Never called for `apply: "manual"`. */
  install(update: FoundUpdate, onProgress?: (fraction: number) => void): Promise<void>;
}

/**
 * Desktop: Tauri's updater, against the signed `latest.json` of the newest
 * release. Only an install the updater can replace gets the button — on Linux
 * that is the AppImage, and `.deb` and `.rpm` are handed to the package
 * manager they came from.
 */
export const updatePlatform: UpdatePlatform | null = {
  downloadUrl: RELEASES_URL,

  async check() {
    const update = await check();
    if (!update) return null;
    const installable = await invoke<boolean>("updater_can_install").catch(() => false);
    return {
      version: update.version,
      notes: update.body || undefined,
      apply: installable ? "restart" : "manual",
      handle: update,
    };
  },

  async install(update, onProgress) {
    const handle = update.handle as Update | null;
    if (!handle) throw new Error("That update is no longer available");

    let contentLength = 0;
    let downloaded = 0;
    await handle.downloadAndInstall((event) => {
      if (event.event === "Started") contentLength = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (contentLength) onProgress?.(Math.min(downloaded / contentLength, 1));
      } else if (event.event === "Finished") onProgress?.(1);
    });
    // The peer and every call it holds end here; the user asked for that.
    await relaunch();
  },
};
