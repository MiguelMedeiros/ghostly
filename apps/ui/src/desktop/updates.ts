import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdateSource } from "@ghostly/browser/host";
import { checkVersionFeed } from "@ghostly/browser/updateFeed";
import { APP_WEBSITE, RELEASES_URL } from "../lib/settings";
import { androidApp } from "../lib/touchOnly";

/** The newest release's number, as the extension reads it: Ghostly's own site, readable from any origin. */
const LATEST_URL = "https://ghostly.tools/latest.json";

/** The release's APK of `version`, as the release workflow names it. */
export function androidApkUrl(version: string): string {
  return `${APP_WEBSITE}/releases/download/v${encodeURIComponent(version)}/ghostly-${encodeURIComponent(version)}-android-arm64.apk`;
}

/**
 * Desktop: Tauri's updater, against the signed `latest.json` of the newest
 * release. Only an install the updater can replace gets the button — on Linux
 * that is the AppImage, and `.deb` and `.rpm` belong to the package manager
 * that put them there, so those are sent to the download.
 *
 * The Android app has no updater (it is granted on Desktop only,
 * `capabilities/desktop.json`): it reads the newest version number and offers
 * that release's APK, which the browser hands to Android's installer.
 *
 * This lives with the host rather than in `/src/lib`, because every client
 * builds `/src` and the browsers have no Tauri to call into.
 */
export const desktopUpdates: UpdateSource = {
  downloadUrl: RELEASES_URL,

  async check() {
    if (androidApp()) {
      const found = await checkVersionFeed({ url: LATEST_URL, currentVersion: await getVersion(), apply: "manual" });
      return found && { ...found, downloadUrl: androidApkUrl(found.version) };
    }
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
