#!/usr/bin/env node
/**
 * The web app's first load is one file of the app's own, not dozens, and it holds only what the app runs on load.
 *
 * Left to its default split, the build cut what the app runs on load into some 95 files: each gzipped on its own
 * (about 66 KB more on the wire than one file) and asked for by a modulepreload apiece, while a deploy changed nearly
 * all of them anyway. `apps/web/vite.config.ts` keeps them in one chunk, `main` (rolldown's `$initial` group). A new
 * entry, a group renamed or an option dropped would split it again with nothing at build time to say so. The same
 * group without its `$initial` tag does the opposite: it folds what loads later (the wallets, Pubky, a call,
 * OpenPGP) into `main`, some 17 MB on every first visit.
 *
 * Checked in `apps/web/dist/`, as the build left it:
 *
 *  1. index.html asks for at least one script and no more than a few: `main`, `vendor`, rolldown's runtime and the
 *     sign-in page's `popup`. Finding none means this script no longer reads the page (a relative or CDN base, another tag
 *     shape), not that the first load is fine.
 *  2. Its entry is `main-*.js`, the name the e2e specs hold back to test a slow or failed start (boot-unsupported,
 *     language-early).
 *  3. What loads later (`LATER`) stays files of its own, each with its code (not a stub passing on main's), none of
 *     them named by index.html.
 *     Those made of packages alone (`PACKAGES`) import nothing from `main`: `main` changes at every deploy, and a file
 *     importing it is renamed with it, so a deploy that changed only the app's own code downloaded them all again.
 *  4. index.html's scripts weigh no more than `MAX_FIRST_LOAD_BYTES` together: a backstop for what `LATER` doesn't name.
 *  5. oidc-callback.html, the page a provider returns to after an identity-proof sign-in, loads none of the app.
 *
 *   npm run build:web && npm run check:web-first-load
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Files index.html may ask for: `main`, `vendor`, the runtime and `popup` (shared with the sign-in page). */
const MAX_SCRIPTS = 4;

/**
 * Chunks the app imports only when they are used, by the name the build gives their file (`<name>-<hash>.js`): the
 * online-only ones the service worker leaves out of its install (`ONLINE_ONLY_MODULES` in apps/web/src/sw/policy.ts:
 * Pubky, Keet proofs, OPAQUE's handoff password proof, named `esm` after @serenity-kit/opaque's esm/index.js, the USDT
 * and Ark wallets) and heavy ones a person may never open (a group call, OpenPGP, the clients of the Lightning and
 * on-chain sources: LND, Core Lightning, WebLN, the BDK wallet, Breez; the wallets of each kind, which come with the
 * first one saved: Ark, Bark, Fedimint with its SDK loader and its chat payments, Spark, USDT).
 * A chunk folded into another loads with whatever took it in, often the first load, and leaves at most a stub of its
 * name behind (`ownCode`). A chunk may also have a facade of its name beside it, passing on its exports to a dynamic
 * import: it counts as folded only when every file of its name is a stub.
 */
const LATER = ["pubky", "keet-identity-key", "esm", "usdt", "arkade", "groupCallLivekit", "openpgp.min", "lnd", "coreLightning", "webln", "bdk", "breez",
  "arkWallet", "barkWallet", "fedimintWallet", "fedimintSdk", "fedimint", "sparkWallet", "usdtWallet"];

/**
 * Words only the regtest fakes hold (their labels, packages/browser/src/engine/paymentAdapters/providers/testing.ts; not
 * their ids, which a device handoff names too): a release build leaves them out, the registry's test of the build
 * folding to `false` there.
 */
const TEST_ONLY = ["Fake Lightning (test)", "Fake Bitcoin wallet (test)"];

/**
 * The later chunks made of packages alone, no code of the app's: what they share with the first load is in `vendor`
 * (the packages it runs, the runtime, Vite's preload helper), which a deploy of the app's own code leaves as it was.
 */
const PACKAGES = ["pubky", "keet-identity-key", "esm", "openpgp.min"];

/** What index.html's scripts may weigh together, raw: twice the 4.5 MB they weighed when this was written. */
const MAX_FIRST_LOAD_BYTES = 9_000_000;

/** The build to check: apps/web/dist, or another output folder given as the argument. */
const dist = process.argv[2] ?? fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const problems = [];

/** The JavaScript files a page names (its module scripts and modulepreloads); none when the page is missing. */
function scriptsOf(page) {
  const path = join(dist, page);
  if (!existsSync(path)) {
    problems.push(`No ${path}. Run \`npm run build:web\` first.`);
    return [];
  }
  const html = readFileSync(path, "utf8");
  const scripts = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="(\/assets\/[^"]+\.js)"/g)].map(([, src]) => src);
  if (scripts.length === 0) {
    problems.push(`${page} names no /assets/*.js script, so there is nothing to check: a relative or CDN base, or another tag shape? Teach scriptsOf in this script to read it.`);
  }
  return scripts;
}

const app = scriptsOf("index.html");
if (app.length > MAX_SCRIPTS) {
  problems.push(`index.html asks for ${app.length} scripts (at most ${MAX_SCRIPTS}): the first load is split again. See codeSplitting in apps/web/vite.config.ts.`);
}
const main = app.filter((src) => /^\/assets\/main-[\w-]+\.js$/.test(src));
if (app.length > 0 && main.length !== 1) problems.push(`index.html names ${main.length} main-*.js files, not one: ${app.join(", ")}`);

/**
 * What a chunk holds besides passing on the entry's exports. Folded into `main`, a dynamic import still leaves a file
 * of its name, a stub such as `export{Sn as Pubky}from"./main-<hash>.js";`: this is what is left of it once its
 * imports and re-exports from `main` are taken out (`export default e();` at most).
 */
function ownCode(file) {
  const text = readFileSync(join(dist, "assets", file), "utf8");
  return text.replace(/(?:import|export)\b[^;"']*?from\s*["']\.\/main-[\w-]+\.js["'];?/g, "").trim();
}

/** Below this, what a chunk holds of its own is a stub's glue, not code: today's smallest later chunk holds 8 KB. */
const MIN_OWN_CODE = 256;

if (app.length > 0) {
  const assets = existsSync(join(dist, "assets")) ? readdirSync(join(dist, "assets")) : [];
  const fold = `It must stay a file of its own, imported where it is used (see the main group's tags: ["$initial"] in apps/web/vite.config.ts)`;
  for (const name of LATER) {
    const own = assets.filter((file) => file.startsWith(`${name}-`) && /^[\w-]+\.js$/.test(file.slice(name.length + 1)));
    const first = app.filter((src) => own.includes(src.slice("/assets/".length)));
    const stubs = own.filter((file) => ownCode(file).length < MIN_OWN_CODE);
    if (own.length === 0) {
      problems.push(`No ${name}-*.js in assets/: it was folded into another chunk, likely main, and loads with it. ${fold}. Renamed or removed on purpose? Update LATER in this script.`);
    } else if (stubs.length === own.length) {
      problems.push(`${stubs.join(", ")} only passes on main's exports: ${name} was folded into main and loads with it. ${fold}.`);
    } else if (first.length > 0) {
      problems.push(`index.html loads ${first.join(", ")}, which the app should load only when it is used: something on the first load imports it statically.`);
    } else if (PACKAGES.includes(name)) {
      const renamed = own.filter((file) => /(?:import|export)\b[^;"']*?from\s*["']\.\/main-[\w-]+\.js["']/.test(readFileSync(join(dist, "assets", file), "utf8")));
      if (renamed.length > 0) problems.push(`${renamed.join(", ")} imports from main, so every deploy renames it and the browser downloads it again: what it takes from main belongs in the vendor group (apps/web/vite.config.ts).`);
    }
  }

  let bytes = 0;
  for (const src of app) {
    const path = join(dist, src);
    if (!existsSync(path)) { problems.push(`index.html names ${src}, which the build did not write.`); continue; }
    bytes += statSync(path).size;
    const fakes = TEST_ONLY.filter((word) => readFileSync(path, "utf8").includes(word));
    if (fakes.length > 0) problems.push(`${src} holds ${fakes.join(", ")}: the regtest fakes ship in the first load. A release build leaves them out only while their test of the build is written out where they are listed, not called (defaultRegistry in providers/registry.ts).`);
  }
  if (bytes > MAX_FIRST_LOAD_BYTES) {
    problems.push(`index.html's scripts weigh ${bytes.toLocaleString("en")} B, over the ${MAX_FIRST_LOAD_BYTES.toLocaleString("en")} B ceiling: something that loads later was pulled into the first load. Find what grew in main-*.js and import it where it is used; raise MAX_FIRST_LOAD_BYTES only for something the app needs at start.`);
  }
}

const signIn = scriptsOf("oidc-callback.html");
const loaded = signIn.filter((src) => app.includes(src) && !/\/(popup|rolldown-runtime)-/.test(src));
if (loaded.length > 0) problems.push(`oidc-callback.html loads the app's own ${loaded.join(", ")}: the sign-in page should share only popup with it.`);

if (problems.length > 0) {
  console.error("The web app's first load is not what it should be:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`Web first load: ${app.length} scripts (${app.join(", ")}), ${LATER.length} later chunks on their own; the sign-in page loads ${signIn.length}.`);
