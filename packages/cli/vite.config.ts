import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, posix } from "node:path";
import { defineConfig, type Plugin } from "vite";

// OpenPGP.js publishes its lightweight build under a "browser" condition only; it runs on Node too
// (as in packages/browser's tests), so the CLI ships the very code the apps do.
const require = createRequire(import.meta.url);
const openpgp = join(require.resolve("openpgp"), "../../lightweight/openpgp.mjs");

/**
 * The wallet SDKs' web builds find IndexedDB through the browser's `window`, which Node lacks (and defining one would
 * turn other libraries onto their browser paths). Each rewrite below makes one such check accept the `indexedDB` the
 * runtime provides. A release that changes the text fails the build here rather than a wallet at run time.
 */
const ON_NODE: { file: RegExp; find: string; replace: string }[] = [
  // Breez (Spark): its storage refuses to start without `window.indexedDB`.
  { file: /@breeztech\/breez-sdk-spark\/web\/storage\/index\.js$/, find: 'if (typeof window === "undefined" || !window.indexedDB) {', replace: 'if (typeof indexedDB === "undefined") {' },
];

/**
 * WebAssembly a bundled SDK loads with `new URL("<file>", import.meta.url)`, which SSR builds leave as written: the
 * file is copied beside the chunks (every chunk is in `assets/`).
 */
const BESIDE_CHUNKS = [
  { entry: "@breeztech/breez-sdk-spark/web", file: "breez_sdk_spark_wasm_bg.wasm" },
  // Iroh's wasm build, which the runtime loads itself (src/runtime/engine.ts).
  { entry: "@ghostly/iroh-web", file: "ghostly_iroh_web_bg.wasm" },
];

/** The folder Node finds package `name` in when it looks from `dir` (each `node_modules` up the tree), or null. */
function packageDir(dir: string, name: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, "node_modules", name);
    if (basename(at) !== "node_modules" && existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(at) === at) return null;
  }
}

const HERE = import.meta.dirname;
const HYPERDHT = packageDir(HERE, "hyperdht")!;
const NESTED = (dir: string): string[] =>
  existsSync(join(dir, "node_modules"))
    ? readdirSync(join(dir, "node_modules")).flatMap((name) => (name.startsWith("@") ? readdirSync(join(dir, "node_modules", name)).map((sub) => `${name}/${sub}`) : name.startsWith(".") ? [] : [name]))
    : [];

/**
 * hyperdht is bundled, with tools/patches/hyperdht+<version>.patch applied (PATCHED below), so the CLI runs the
 * patched lib/nat.js: the root's postinstall patches only the repository's node_modules, never a user's install. The
 * packages hyperdht keeps a copy of in its own node_modules are bundled with it, from that copy; everything else it
 * requires stays an import resolved at run time, and must then be the very package it resolves to here, or the
 * bundled hyperdht would run with another version than the one it was tested with.
 */
const HYPERDHT_BUNDLED = ["hyperdht", ...NESTED(HYPERDHT)];
for (const dir of [HYPERDHT, ...NESTED(HYPERDHT).map((name) => join(HYPERDHT, "node_modules", name))]) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const found = packageDir(dir, name);
    if (found?.startsWith(join(HYPERDHT, "node_modules") + "/")) continue;
    if (found !== packageDir(HERE, name)) throw new Error(`${dir} requires ${name} from ${found}, the CLI would find ${packageDir(HERE, name)}: review HYPERDHT_BUNDLED in packages/cli/vite.config.ts`);
  }
}

/** Each hunk of a patch-package file, by the file it changes in the package: the text before and after. */
function hunks(patch: string): Map<string, { before: string; after: string }[]> {
  const out = new Map<string, { before: string; after: string }[]>();
  let file = "";
  let hunk: { before: string[]; after: string[] } | null = null;
  const flush = () => {
    if (hunk) out.set(file, [...(out.get(file) ?? []), { before: hunk.before.join("\n"), after: hunk.after.join("\n") }]);
    hunk = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      flush();
      file = line.replace(/^\+\+\+ b\/node_modules\/[^/]+\//, "");
    } else if (line.startsWith("@@")) {
      flush();
      hunk = { before: [], after: [] };
    } else if (/^(diff |index |--- )/.test(line)) {
      flush();
    } else if (hunk && !line.startsWith("\\")) {
      if (line.startsWith("-")) hunk.before.push(line.slice(1));
      else if (line.startsWith("+")) hunk.after.push(line.slice(1));
      else {
        hunk.before.push(line.slice(1));
        hunk.after.push(line.slice(1));
      }
    }
  }
  flush();
  for (const list of out.values()) for (const h of list) for (const key of ["before", "after"] as const) h[key] = h[key].replace(/\n+$/, "");
  return out;
}

const HYPERDHT_VERSION = (JSON.parse(readFileSync(join(HYPERDHT, "package.json"), "utf8")) as { version: string }).version;
const HYPERDHT_PATCH = new URL(`../../tools/patches/hyperdht+${HYPERDHT_VERSION}.patch`, import.meta.url);
const PATCHED = existsSync(HYPERDHT_PATCH) ? hunks(readFileSync(HYPERDHT_PATCH, "utf8")) : new Map<string, { before: string; after: string }[]>();

/** tools/patches/hyperdht applied to the bundled copy, whether or not the install ran the root's postinstall. */
function hyperdhtPatched(): Plugin {
  return {
    name: "ghostly-hyperdht-patched",
    enforce: "pre",
    transform(code, id) {
      const real = id.split("?")[0]!;
      if (!real.startsWith(HYPERDHT + "/") || real.startsWith(join(HYPERDHT, "node_modules") + "/")) return;
      const file = real.slice(HYPERDHT.length + 1);
      let out = code;
      for (const { before, after } of PATCHED.get(file) ?? []) {
        if (out.includes(after)) continue;
        if (!out.includes(before)) this.error(`${id} changed: tools/patches/hyperdht+${HYPERDHT_VERSION}.patch no longer applies`);
        out = out.replace(before, after);
      }
      return out === code ? undefined : { code: out, map: null };
    },
    // In generateBundle, which only runs for a build that got that far: a check in buildEnd hid the build's own error.
    generateBundle() {
      const ids = new Set(this.getModuleIds());
      for (const file of PATCHED.keys()) if (!ids.has(join(HYPERDHT, file))) this.error(`hyperdht/${file} is not in the bundle: its patch would not ship`);
    },
  };
}

function walletSdksOnNode(): Plugin {
  return {
    name: "ghostly-wallet-sdks-on-node",
    enforce: "pre",
    generateBundle() {
      for (const { entry, file } of BESIDE_CHUNKS) {
        this.emitFile({ type: "asset", fileName: `assets/${file}`, source: readFileSync(new URL(file, import.meta.resolve(entry))) });
      }
      // The Fedimint client's worker thread, plain JavaScript that runs as written (src/runtime/fedimint.ts finds it).
      this.emitFile({ type: "asset", fileName: "assets/fedimintWorker.mjs", source: readFileSync(new URL("./src/runtime/fedimintWorker.mjs", import.meta.url)) });
    },
    transform(code, id) {
      const rule = ON_NODE.find((r) => r.file.test(id));
      if (!rule) return;
      if (!code.includes(rule.find)) this.error(`${id} changed: review ON_NODE in packages/cli/vite.config.ts`);
      return { code: code.replace(rule.find, rule.replace), map: null };
    },
  };
}

/**
 * One file for Node: the CLI, the daemon and the engine they run (the app's own `@ghostly/browser` and
 * `@ghostly/core`, compiled from their TypeScript). Packages from npm stay imports, resolved from
 * node_modules at run time (at the versions of the npm-shrinkwrap.json the package ships,
 * tools/scripts/cli-shrinkwrap.mjs); the workspace packages, Breez's web build and hyperdht are bundled in.
 */
export default defineConfig({
  // `hyperdht` is always the repository's copy (HYPERDHT, the lockfile's and npm-shrinkwrap.json's): the Desktop's
  // sidecar folder (native/transports/hyperdht, imported by the runtime) gets an install of its own once
  // tools/scripts/prepare-native-runtime.mjs has run, and the CLI would otherwise bundle that one instead.
  resolve: {
    alias: [
      { find: /^openpgp\/lightweight$/, replacement: openpgp },
      { find: /^hyperdht$/, replacement: join(HYPERDHT, "index.js") },
      { find: /^hyperdht\/(.*)$/, replacement: `${HYPERDHT}/$1` },
    ],
  },
  plugins: [walletSdksOnNode(), hyperdhtPatched()],
  build: {
    ssr: "src/bin.ts",
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // The wallet SDKs' WebAssembly files go beside the bundle.
    ssrEmitAssets: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: "ghostly.mjs", format: "es" } },
  },
  // Breez's web build is bundled so its IndexedDB check can be rewritten (ON_NODE), and hyperdht so its patch ships
  // (HYPERDHT_BUNDLED).
  ssr: { target: "node", noExternal: [/^@ghostly\//, /^@breeztech\/breez-sdk-spark/, ...HYPERDHT_BUNDLED.map((name) => new RegExp(`^${name}(/|$)`))] },
  // A `?url` asset (the wallet SDKs' WebAssembly) is a file beside the chunk that imports it, as a `file:` URL: Node
  // has no web root to resolve "/assets/…" against. The runtime's fetch reads such files (src/runtime/fileFetch.ts).
  experimental: {
    renderBuiltUrl(filename, { hostId }) {
      const relative = posix.relative(posix.dirname(hostId), filename);
      return { runtime: `new URL(${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)}, import.meta.url).href` };
    },
  },
});
