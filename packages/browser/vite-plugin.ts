import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = (path: string) => resolve(here, "../../src", path);
const platform = (path: string) => resolve(here, "src/platform", path);

/**
 * Browser clients build the Desktop UI (`/src`) unchanged. These are the only
 * Desktop modules that touch the platform, each swapped for a stand-in with
 * the same exports.
 */
const PLATFORM_MODULES = new Map([
  [desktop("lib/pkarr.ts"), platform("pkarr.ts")],
  [desktop("lib/crypto.ts"), platform("crypto.ts")],
  [desktop("lib/platform.ts"), platform("services.ts")],
  [desktop("hooks/useChat.ts"), platform("useChat.ts")],
  [desktop("hooks/useBackgroundPoller.ts"), platform("useBackgroundPoller.ts")],
]);

export function ghostlyPlatformModules(): Plugin {
  return {
    name: "ghostly-platform-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(platform(""))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved && PLATFORM_MODULES.get(resolved.id)) ?? null;
    },
  };
}

/** There is no Tauri in a browser. */
export const tauriAliases: NonNullable<UserConfig["resolve"]>["alias"] = {
  "@tauri-apps/api/core": platform("tauri.ts"),
  "@tauri-apps/api/app": platform("tauri.ts"),
};

/** One `.env` for every client (VITE_GIPHY_API_KEY). */
export const repositoryRoot = resolve(here, "../..");
