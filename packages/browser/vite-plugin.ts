import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
/**
 * A module as Vite names it: with `/` on every system (its `normalizePath`), where `node:path` writes `\` on Windows.
 * The Windows app is built on Windows, and a list keyed by `node:path` paths matched nothing there (ghostly#1864).
 */
const viteId = (path: string) => path.replace(/\\/g, "/");
const desktop = (path: string) => viteId(resolve(here, "../../apps/ui/src", path));
const platform = (path: string) => viteId(resolve(here, "src/platform", path));
const sdk = (path: string) => viteId(resolve(here, "../sdk/src", path));

/** One `.env` for every client. */
export const repositoryRoot = resolve(here, "../..");

/**
 * Inside the app, `@ghostlytools/sdk` is its source: a plugin bundled with the app shares one copy of the
 * contracts and the registry with the engine, whatever its `node_modules` holds.
 */
const SDK_MODULES = new Map([
  ["@ghostlytools/sdk", sdk("index.ts")],
  ["@ghostlytools/sdk/fakes", sdk("fakes.ts")],
  ["@ghostlytools/sdk/testing", sdk("testing.ts")],
  ["@ghostlytools/sdk/core", sdk("core.ts")],
]);

/**
 * The adapter plugins a build compiles in: `GHOSTLY_PLUGINS` lists their modules, comma-separated,
 * as paths from the repository root; each default-exports a `GhostlyAdapterPlugin`. Unset in release
 * builds. `packages/browser/src/plugins/bundled.ts` is swapped for a module importing them.
 */
export function bundledPluginModules(env = process.env.GHOSTLY_PLUGINS): string[] {
  return (env ?? "").split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean).map((entry) => resolve(repositoryRoot, entry));
}
const BUNDLED = viteId(resolve(here, "src/plugins/bundled.ts"));
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

/**
 * nostr-tools pins exact, older versions of the noble and scure libraries; the app and its other libraries share
 * newer ones of the same major. nostr-tools gets those, or every browser build carries a second secp256k1, SHA-2 and
 * base encoders in its first load. Only nostr-tools: other libraries' copies are of an older major (ethers' noble 1.x).
 */
const PINNED_CRYPTO = /^@(noble\/(ciphers|curves|hashes)|scure\/(base|bip32|bip39))(\/|$)/;
const NOSTR_TOOLS = "/node_modules/nostr-tools/";

/**
 * The Bitcoin descriptor libraries are CommonJS and `require()` noble's secp256k1; a `require()` keeps every export
 * of the module it loads, so they get a module with only the two they use (src/platform/nobleSecp256k1.ts).
 */
const NOBLE_SECP256K1 = /^@noble\/curves\/secp256k1(\.js)?$/;
const DESCRIPTORS = "/node_modules/@bitcoinerlab/";
const FROM_ROOT = viteId(resolve(repositoryRoot, "package.json"));

export function ghostlyPlatformModules(): Plugin {
  return {
    name: "ghostly-platform-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const sdkModule = SDK_MODULES.get(source) ?? BROWSER_PACKAGES.get(source);
      if (sdkModule) return sdkModule;
      if (!importer || viteId(importer).startsWith(platform(""))) return null;
      if (NOBLE_SECP256K1.test(source) && viteId(importer).includes(DESCRIPTORS)) return platform("nobleSecp256k1.ts");
      if (PINNED_CRYPTO.test(source) && viteId(importer).includes(NOSTR_TOOLS)) return this.resolve(source, FROM_ROOT, { ...options, skipSelf: true });
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = viteId(resolved.id);
      if (id === BUNDLED && bundledPluginModules().length) return VIRTUAL_BUNDLED;
      return PLATFORM_MODULES.get(id) ?? null;
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
  "@tauri-apps/api/event": platform("tauri.ts"),
};
