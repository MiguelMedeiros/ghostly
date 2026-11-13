import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
 * `@synonymdev/pubky`'s browser entry carries its wasm (2.5 MB) as base64 and compiles it at once: its chunk was 1.1 MB
 * gzip, 0.34 MB more than the wasm file it ships beside it. A build swaps the inline copy for that file, fetched and
 * compiled as it arrives, the way the wallets load theirs (bdkSdk.ts), when `pubkyWasmReady()` is first called: the
 * package is only usable once it settles, so the app loads it through `loadPubky` (proofs/pubkySdk.ts). Not a
 * top-level await: one anywhere in the graph turns off Rolldown's merging of shared chunks (Desktop's first load went
 * from 49 files to 80). The same five lines, so the source map holds.
 */
const PUBKY_ENTRY = /[\\/]node_modules[\\/]@synonymdev[\\/]pubky[\\/]index\.js$/;
const PUBKY_INLINE_WASM =
  /const bytes = __toBinary\("([A-Za-z0-9+/=]+)"\);(\s*)const wasmModule = new WebAssembly\.Module\(bytes\);(\s*)let wasmInstance = new WebAssembly\.Instance\(wasmModule, __wbg_get_imports\(\)\);(\s*)let wasm = wasmInstance\.exports;(\s*)wasm\.__wbindgen_start\(\);/;

function pubkyWasmFile(code: string, file: string): string | null {
  const inline = PUBKY_INLINE_WASM.exec(code);
  // Only the very bytes of the file beside it: other ones would not be the wasm the glue around them was made for.
  if (!inline || !Buffer.from(inline[1], "base64").equals(readFileSync(resolve(dirname(file), "pubky_bg.wasm")))) return null;
  const [whole, , ...gaps] = inline;
  const lines = [
    `import pubkyWasmUrl from "./pubky_bg.wasm?url"; let wasm, pubkyWasmLoad; const pubkyWasmReady = () => pubkyWasmLoad ??= (async () => { const wasmResponse = await fetch(pubkyWasmUrl); if (!wasmResponse.ok) throw new Error(\`pubky_bg.wasm: HTTP \${wasmResponse.status}\`);`,
    "const wasmImports = __wbg_get_imports();",
    "let wasmInstance; try { ({ instance: wasmInstance } = await WebAssembly.instantiateStreaming(wasmResponse.clone(), wasmImports)); } catch { ({ instance: wasmInstance } = await WebAssembly.instantiate(await wasmResponse.arrayBuffer(), wasmImports)); }",
    "wasm = wasmInstance.exports;",
    // A failed load (offline) is forgotten: the next use fetches again.
    "wasm.__wbindgen_start(); })().catch((e) => { pubkyWasmLoad = undefined; throw e; }); export { pubkyWasmReady };",
  ];
  return code.replace(whole, () => lines.map((line, i) => line + (gaps[i] ?? "")).join(""));
}

export function ghostlyPlatformModules(): Plugin {
  return {
    name: "ghostly-platform-modules",
    enforce: "pre",
    transform: {
      filter: { id: PUBKY_ENTRY },
      handler(code, id) {
        // Dev serves the package prebundled as it is; only a build ships it.
        if (this.environment.mode !== "build") return null;
        const swapped = pubkyWasmFile(code, id);
        if (swapped === null) this.error(`@synonymdev/pubky: ${id} no longer inlines pubky_bg.wasm as this build expects; check the swap in packages/browser/vite-plugin.ts`);
        return { code: swapped, map: null };
      },
    },
    async resolveId(source, importer, options) {
      const sdkModule = SDK_MODULES.get(source) ?? BROWSER_PACKAGES.get(source);
      if (sdkModule) return sdkModule;
      if (!importer || viteId(importer).startsWith(platform(""))) return null;
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
