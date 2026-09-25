import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = (path: string) => resolve(here, "../../src", path);
const platform = (path: string) => resolve(here, "src/platform", path);
const sdk = (path: string) => resolve(here, "../sdk/src", path);

/** One `.env` for every client. */
export const repositoryRoot = resolve(here, "../..");

/**
 * Inside the app, `@ghostly/sdk` is its source: a plugin bundled with the app shares one copy of the
 * contracts and the registry with the engine, whatever its `node_modules` holds.
 */
const SDK_MODULES = new Map([
  ["@ghostly/sdk", sdk("index.ts")],
  ["@ghostly/sdk/fakes", sdk("fakes.ts")],
  ["@ghostly/sdk/testing", sdk("testing.ts")],
  ["@ghostly/sdk/core", sdk("core.ts")],
]);

/**
 * The adapter plugins a build compiles in: `GHOSTLY_PLUGINS` lists their modules, comma-separated,
 * as paths from the repository root; each default-exports a `GhostlyAdapterPlugin`. Unset in release
 * builds. `packages/browser/src/plugins/bundled.ts` is swapped for a module importing them.
 */
export function bundledPluginModules(env = process.env.GHOSTLY_PLUGINS): string[] {
  return (env ?? "").split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean).map((entry) => resolve(repositoryRoot, entry));
}
const BUNDLED = resolve(here, "src/plugins/bundled.ts");
const VIRTUAL_BUNDLED = "\0ghostly-bundled-plugins";

/**
 * Browser clients build the Desktop UI (`/src`) unchanged. These are the only
 * Desktop modules that touch the platform, each swapped for a stand-in with
 * the same exports.
 */
const PLATFORM_MODULES = new Map([
  [desktop("lib/pkarr.ts"), platform("pkarr.ts")],
  [desktop("lib/crypto.ts"), platform("crypto.ts")],
  [desktop("lib/platform.ts"), platform("services.ts")],
  [desktop("lib/updates.ts"), platform("updates.ts")],
  [desktop("hooks/useChat.ts"), platform("useChat.ts")],
  [desktop("hooks/useBackgroundPoller.ts"), platform("useBackgroundPoller.ts")],
]);

/**
 * Packages a browser build replaces. `noise-curve-ed` (HyperDHT's Noise curve, which dht-relay's client
 * loads) needs a libsodium call sodium-javascript lacks; the stand-in computes the same on noble curves.
 */
const BROWSER_PACKAGES = new Map([
  ["noise-curve-ed", platform("noiseCurveEd.ts")],
]);

export function ghostlyPlatformModules(): Plugin {
  return {
    name: "ghostly-platform-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const sdkModule = SDK_MODULES.get(source) ?? BROWSER_PACKAGES.get(source);
      if (sdkModule) return sdkModule;
      if (!importer || importer.startsWith(platform(""))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      if (resolved.id === BUNDLED && bundledPluginModules().length) return VIRTUAL_BUNDLED;
      return PLATFORM_MODULES.get(resolved.id) ?? null;
    },
    load(id) {
      if (id !== VIRTUAL_BUNDLED) return null;
      const modules = bundledPluginModules();
      return [
        ...modules.map((module, i) => `import plugin${i} from ${JSON.stringify(module)};`),
        `export const BUNDLED_PLUGINS = [${modules.map((_, i) => `plugin${i}`).join(", ")}];`,
        "",
      ].join("\n");
    },
  };
}

/** There is no Tauri in a browser. */
export const tauriAliases: NonNullable<UserConfig["resolve"]>["alias"] = {
  "@tauri-apps/plugin-notification": platform("nativeNotifications.ts"),
  "@tauri-apps/api/core": platform("tauri.ts"),
  "@tauri-apps/api/app": platform("tauri.ts"),
};
