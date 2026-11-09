// What a change needs tested: the pure half of `npm run test:affected` (tools/scripts/test-affected.mjs runs it).
//
// Input: the changed files (paths relative to the repository root, with whether each still exists), the feature
// inventory (e2e/features.json, whose `paths` map source globs to features) and the e2e test files with their
// sources. Output: a plan of unit, lint, typecheck, Rust and e2e steps, each with the reason it runs, runs whole,
// or is skipped. Nothing here touches the disk or the process, so tools/scripts/test/affected.test.ts can drive it.

// ---------- globs ----------

/** `*` any characters but `/`, `**` + `/` zero or more directories, `?` one character, `{a,b}` alternatives. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) throw new Error(`glob ${glob}: { without }`);
      re += `(?:${glob.slice(i + 1, end).split(",").map((alt) => globToRegExp(alt).source.slice(1, -1)).join("|")})`;
      i = end;
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

/** A feature pattern: an id, `area.*` (the id `area` and everything under it), or `*` (everything). */
export function featureMatcher(pattern) {
  if (pattern === "*") return () => true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return (id) => id === prefix.slice(0, -1) || id.startsWith(prefix);
  }
  return (id) => id === pattern;
}

// ---------- the repository's shape ----------

/** Files that change what every workspace installs, resolves or builds: nothing below can be narrowed. */
export const EVERYTHING = ["package.json", "package-lock.json", "tools/patches/**"];

/**
 * The unit test projects. `sources`: a change there can change what these tests import, so `vitest related` looks
 * at it. `whole`: a change there (config, setup, install) is not in any import graph, so the project runs whole.
 * `tests`: the project's test files (its vitest `include`). A test there may import a file outside `sources` by
 * relative path (packages/browser/test/chatConnection.test.ts imports apps/ui/src/components/ChatConnection.tsx), so a
 * change outside `sources` still runs the tests whose relative imports reach it (testsReaching).
 * A test that reads a file from disk by its name (a config, a doc, a crate's Rust) is in no import graph: a change to
 * that file runs it (testsReading). `reads` (scripts only, whose tests name repository paths as data): the files its
 * tests read, listed instead.
 */
export const UNIT_PROJECTS = [
  {
    name: "core", cwd: "packages/core", args: [],
    sources: ["packages/core/**"],
    whole: ["packages/core/package.json", "packages/core/vitest.config.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["packages/core/test/**"],
  },
  {
    name: "browser", cwd: "packages/browser", args: [],
    sources: ["packages/core/src/**", "packages/browser/**"],
    whole: ["packages/browser/package.json", "packages/browser/vitest.config.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["packages/browser/test/**"],
  },
  {
    name: "sdk", cwd: "packages/sdk", args: [],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/sdk/**"],
    whole: ["packages/sdk/package.json", "packages/sdk/vite.config.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["packages/sdk/test/**"],
  },
  {
    name: "extension", cwd: "apps/extension", args: [],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "apps/ui/src/**", "apps/extension/**"],
    whole: ["apps/extension/package.json", "apps/extension/vitest.config.ts", "packages/browser/vite-plugin.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["apps/extension/test/**"],
  },
  {
    name: "ui", cwd: ".", args: ["-c", "apps/ui/vitest.ui.config.ts"],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/**", "apps/ui/src/**"],
    whole: ["apps/ui/vitest.ui.config.ts", "apps/ui/src/test/setup.ts", "packages/browser/vite-plugin.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["apps/ui/src/**", "packages/react/test/**"],
  },
  {
    name: "matrix", cwd: ".", args: ["-c", "e2e/matrix/vitest.config.ts"],
    sources: ["e2e/matrix/**"],
    whole: ["e2e/matrix/vitest.config.ts", "tools/vitest.shared.ts"],
    tests: ["e2e/matrix/*"],
  },
  {
    name: "scripts", cwd: ".", args: ["-c", "tools/scripts/vitest.config.ts"],
    sources: ["tools/scripts/**"],
    // Also the files its tests read from disk: `vitest related` finds no test for those (the whole suite is ~20 s).
    whole: [
      "tools/scripts/vitest.config.ts", "tools/vitest.shared.ts",
      ".github/workflows/**", ".github/dependabot.yml", "e2e/features.json", "apps/web/nginx*.conf", "apps/web/Dockerfile",
      "apps/desktop/tauri.conf.json", "apps/desktop/gen/android/gradle/wrapper/**",
    ],
    // Docs, crates and configs a few of its tests read from disk: a change there runs those tests, not the suite.
    // affected.test.ts fails on a test that reads a repository file by name and is in neither list.
    reads: {
      "README.md": ["readme", "androidReleased"],
      "docs/INSTALLATION.md": ["readme", "androidReleased", "bumpVersion"],
      "{docs/README.md,docs/FEATURES.md,docs/WEB.md,docs/APPS.md,docs/ANDROID.md,docs/wisps/ADAPTER-ROADMAP.md,apps/website/content/*.ts}": ["androidReleased"],
      "docs/RELEASING.md": ["chromeWebStore", "npmPublish", "webLatest"],
      "{CHANGELOG.md,apps/desktop/Cargo.toml,apps/website/lib/release.ts,apps/extension/public/manifest.json,packages/browser/src/shared/features.ts}": ["bumpVersion"],
      "packages/cli/package.json": ["npmPublish"],
      "apps/desktop/src/{translate,translate_models}.rs": ["translationRuntimes"],
      "e2e/playwright.config.ts": ["e2eWorkflow"],
      "{native/transports/Cargo.toml,native/transports/iroh-web/**,packages/iroh-web/pkg/**}": ["irohWebBuild"],
      "{packages/cli/vite.config.ts,packages/cli/vitest.config.ts,packages/cli/test/support/cli.ts}": ["affected"],
      "{packages/cli/vite.config.ts,e2e/fixtures/chess/**}": ["storeKeys"],
    },
    tests: ["tools/scripts/test/**"],
  },
  {
    name: "cli", cwd: "packages/cli", args: [],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/cli/**"],
    whole: ["packages/cli/package.json", "packages/cli/vitest.config.ts", "packages/cli/vite.config.ts", "packages/cli/test/support/build.ts", "packages/core/src/index.ts", "tools/vitest.shared.ts"],
    tests: ["packages/cli/test/**"],
    // Most CLI tests run dist/ghostly.mjs (built by the globalSetup) through `runner`, which imports none of what
    // the binary is built from. A change the build takes in (bundleReaches from `entry`; without the sources, one
    // under `sources`) hands vitest the runner too, and vitest runs the tests that import it.
    bundle: { entry: "packages/cli/src/bin.ts", runner: "packages/cli/test/support/cli.ts", sources: ["packages/core/src/**", "packages/browser/src/**", "packages/cli/src/**"] },
  },
  {
    // The Chess mini-app: its tests import only its own code and the mini-app API types (packages/core/src/miniApp.ts).
    name: "chess", cwd: "apps/mini/chess", args: [],
    sources: ["packages/core/src/miniApp.ts", "apps/mini/chess/**"],
    whole: ["apps/mini/chess/package.json", "apps/mini/chess/vitest.config.ts", "apps/mini/chess/vite.config.ts", "tools/vitest.shared.ts"],
    tests: ["apps/mini/chess/test/**"],
  },
  {
    // The pinned Chess the e2e runs (e2e/fixtures/chess, from Chess's signed bundle): its test reads the fixture from
    // disk, which no import graph shows, so a change to it runs it (whole: that one file).
    name: "chess fixture", cwd: ".", args: ["-c", "tools/scripts/vitest.config.ts", "test/chessFixture.test.ts"],
    sources: [],
    whole: ["e2e/fixtures/chess/**"],
    tests: [],
  },
  {
    // CI's path gates (tools/scripts/ci-changes.mjs) must cover every file the website's scripts, the packages' and the
    // extension's code and the crates' Rust name. Its test reads those from disk for the paths they name, which no import
    // graph shows, so a change to one runs it (whole: that one file, about 150 ms). A draft's tier is all the merge train
    // waits for: without this, a website script naming an uncovered file went red only in batches (2026-11-03).
    name: "ci gates", cwd: ".", args: ["-c", "tools/scripts/vitest.config.ts", "test/ci-changes.test.ts"],
    sources: [],
    whole: ["apps/website/scripts/**", "packages/**/*.{ts,tsx,mts,js,mjs}", "apps/extension/**/*.{ts,tsx,mts,js,mjs}", "apps/desktop/**/*.rs", "native/transports/**/*.rs"],
    tests: [],
  },
  {
    // The Android app's Kotlin: only the APK builds compile it, and they are not part of CI Success. Its test reads
    // the sources from disk for a comment Kotlin would never close (whole: that one file).
    name: "android kotlin", cwd: ".", args: ["-c", "tools/scripts/vitest.config.ts", "test/androidKotlinComments.test.ts"],
    sources: [],
    whole: ["apps/desktop/gen/android/**/*.{kt,kts}"],
    tests: [],
  },
];

/** `npm run lint`'s scope: what eslint is given, and what makes the whole lint run. */
export const LINT = {
  scope: ["apps/ui/src/**", "packages/**", "apps/extension/src/**", "apps/extension/test/*.ts", "apps/web/src/**", "apps/mini/**", "e2e/**"],
  ext: /\.(?:[cm]?[jt]sx?)$/,
  whole: ["eslint.config.mjs"],
};

/**
 * Type checks, one per tsconfig `npm run typecheck` checks. `sources`: this package and the ones it imports, so a
 * change to @ghostly/core rechecks its importers too (an API change breaks them, not core).
 */
export const TYPECHECKS = [
  { name: "core", cmd: ["npx", "tsc", "--noEmit", "-p", "packages/core/tsconfig.json"], sources: ["packages/core/**"] },
  { name: "browser", cmd: ["npx", "tsc", "--noEmit", "-p", "packages/browser/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/**"] },
  { name: "sdk", cmd: ["npx", "tsc", "--noEmit", "-p", "packages/sdk/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/sdk/**"] },
  { name: "ui (root tsconfig)", cmd: ["npx", "tsc", "--noEmit"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/**", "apps/ui/src/**", "tsconfig.json", "apps/ui/vite-env.d.ts"] },
  { name: "extension", cmd: ["npx", "tsc", "--noEmit", "-p", "apps/extension/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "apps/ui/src/**", "apps/extension/src/**", "apps/extension/tsconfig.json"] },
  { name: "extension tests", cmd: ["npx", "tsc", "--noEmit", "-p", "apps/extension/tsconfig.test.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "apps/ui/src/**", "apps/extension/**"] },
  { name: "web", cmd: ["npx", "tsc", "--noEmit", "-p", "apps/web/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "apps/ui/src/**", "apps/web/**"] },
  { name: "e2e", cmd: ["npx", "tsc", "--noEmit", "-p", "e2e"], sources: ["e2e/**", "packages/core/src/**"] },
  { name: "chess", cmd: ["npx", "tsc", "--noEmit", "-p", "apps/mini/chess/tsconfig.json"], sources: ["packages/core/src/**", "apps/mini/chess/**"] },
];
export const TYPECHECK_WHOLE = ["tsconfig.json", "packages/*/tsconfig*.json"];

/** The Rust crates, as CI's Tauri job checks them. */
export const RUST = [
  { name: "desktop", sources: ["apps/desktop/**", "native/transports/**", "Cargo.toml", "Cargo.lock"] },
];

/** The Playwright config of the web and extension projects: a change there can change every spec. */
export const E2E_WHOLE = ["e2e/playwright.config.ts", "e2e/tsconfig.json"];
/** Desktop specs run through tauri-driver on Linux and Windows only (e2e/playwright.desktop.config.ts). */
export const DESKTOP = ["e2e/desktop/**", "e2e/playwright.desktop.config.ts", "e2e/support/desktop.ts", "apps/desktop/**", "apps/ui/src/desktop/**", "native/transports/**"];

const isTest = (p) => /\.test\.[cm]?[jt]sx?$/.test(p);
/** Prose: no test imports it and no compiler reads it. */
const isDoc = (p) => /\.(?:md|mdx|txt)$/i.test(p) || p.startsWith("docs/");
const isSpec = (p) => p.startsWith("e2e/") && /\.spec\.[cm]?[jt]sx?$/.test(p);
/** The specs of e2e/playwright.config.ts (web and extension); Desktop and the matrix have configs of their own. */
const isSuiteSpec = (p) => isSpec(p) && /^e2e\/(?:web|extension)\//.test(p);

// ---------- e2e specs ----------

/** The feature ids a spec's `tag: [...]` literals name (the same reading as tools/scripts/test-map.mjs). */
export function specFeatures(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\btag\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/g)) {
    for (const t of m[1].matchAll(/["'`]@feature:([^"'`]+)["'`]/g)) ids.add(t[1]);
  }
  return ids;
}

/** The relative imports of a TypeScript file, resolved against it (no extension, as they are written). */
export function relativeImports(file, text) {
  const dir = file.split("/").slice(0, -1);
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const parts = [...dir];
    for (const seg of m[1].split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    out.push(parts.join("/").replace(/\.(?:[cm]?[jt]sx?)$/, ""));
  }
  return out;
}

/**
 * The workspace packages' entry points, from their package.json files (path → text): name → [subpath, file] pairs,
 * each file relative to the repository root. "exports" as Node reads it (a string, a map of subpaths, conditions:
 * `import`, then `default`), or "main" without it. A `*` in a subpath stands for the rest of the specifier.
 *
 * @param {Record<string, string>} manifests
 * @returns {Record<string, [string, string][]>}
 */
export function workspaceExports(manifests) {
  /** @type {Record<string, [string, string][]>} */
  const out = {};
  const target = (t) => (typeof t === "string" ? t : t && typeof t === "object" ? target(t.import ?? t.default) : null);
  for (const [path, text] of Object.entries(manifests)) {
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    const entry = pkg?.exports ?? pkg?.main;
    if (typeof pkg?.name !== "string" || entry === undefined) continue;
    const dir = path.split("/").slice(0, -1).join("/");
    const map = entry && typeof entry === "object" && Object.keys(entry).some((k) => k.startsWith(".")) ? entry : { ".": entry };
    out[pkg.name] = Object.entries(map)
      .map(([sub, t]) => [sub, target(t)])
      .filter(([, t]) => typeof t === "string")
      .map(([sub, t]) => [sub, [dir, t.replace(/^\.\//, "")].filter(Boolean).join("/")]);
  }
  return out;
}

/** What following package names meant before plan() was given the workspaces' exports: core's barrel, browser's src. */
/** @type {Record<string, [string, string][]>} */
const KNOWN_PACKAGES = { "@ghostly/core": [[".", "packages/core/src/index.ts"]], "@ghostly/browser": [["./*", "packages/browser/src/*.ts"]] };

/**
 * The workspace files a file imports by package name (`@ghostly/iroh-web`, `@ghostly/browser/engine/node`) or resolves
 * that way (`require.resolve("@ghostly/iroh-web/wasm")`), as `packages` (workspaceExports) maps them: paths without
 * extension, as relativeImports gives them. A name no workspace has (a dependency) is left out.
 *
 * @param {string} text
 * @param {Record<string, [string, string][]>} [packages]
 * @returns {string[]}
 */
export function packageImports(text, packages = KNOWN_PACKAGES) {
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\.resolve\(\s*)["']([^"'./][^"']*)["']/g)) {
    const spec = m[1];
    const name = Object.keys(packages).filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
    if (!name) continue;
    const sub = `.${spec.slice(name.length)}`;
    for (const [key, file] of packages[name]) {
      const star = key.indexOf("*");
      if (key === sub) { out.push(stripExt(file)); break; }
      if (star < 0 || sub.length < key.length - 1 || !sub.startsWith(key.slice(0, star)) || !sub.endsWith(key.slice(star + 1))) continue;
      out.push(stripExt(file.replace("*", stripExt(sub.slice(star, sub.length - (key.length - star - 1))))));
      break;
    }
  }
  return out;
}

/**
 * The e2e specs a changed e2e helper reaches, following relative imports inside e2e/.
 * `e2eFiles`: { path: text } of every TypeScript file under e2e/.
 */
export function specsImporting(changed, e2eFiles) {
  const strip = (p) => p.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  const importers = new Map();
  for (const [path, text] of Object.entries(e2eFiles)) {
    for (const dep of relativeImports(path, text)) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(path);
    }
  }
  const seen = new Set();
  const queue = [strip(changed)];
  const specs = new Set();
  while (queue.length) {
    const cur = queue.pop();
    for (const imp of importers.get(cur) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (isSpec(imp)) specs.add(imp);
      queue.push(strip(imp));
    }
  }
  return specs;
}

// ---------- tests that import across workspaces ----------

/**
 * The test files that reach one of `changed` through imports, directly or through other files: relative paths, and
 * workspace package names (`@ghostly/iroh-web`, packageImports). `@ghostly/core`'s barrel is not followed: through it
 * every test reaches every core module, and throughCoreBarrel reads it name by name instead.
 * `./x`, `./x.js` and `./x.ts` all name x.ts, and `./dir` names dir/index.ts; other extensions (`.json`) are kept.
 *
 * @param {string[]} changed  changed files (deleted ones too: their importers break)
 * @param {Record<string, string>} files  path → text of the files to follow
 * @param {string[]} tests  globs of the test files wanted
 * @param {Record<string, [string, string][]>} [packages]  the workspaces' exports (workspaceExports)
 * @returns {string[]} those test files, sorted
 */
export function testsReaching(changed, files, tests, packages) {
  const importers = new Map();
  for (const [path, text] of Object.entries(files)) {
    for (const dep of [...relativeImports(path, text), ...packageImports(text, packages).filter((d) => d !== CORE_INDEX)]) {
      for (const key of [dep, `${dep}/index`]) {
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key).add(path);
      }
    }
  }
  const wanted = tests.map(globToRegExp);
  const seen = new Set(changed);
  const queue = changed.map(stripExt);
  const out = new Set();
  while (queue.length) {
    for (const imp of importers.get(queue.pop()) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (isTest(imp) && wanted.some((re) => re.test(imp))) out.add(imp);
      queue.push(stripExt(imp));
    }
  }
  return [...out].sort();
}

// ---------- tests that read a file from disk ----------

/**
 * The repository paths a test file names as string literals, as it would read them from disk: `"apps/web/nginx.conf"`
 * (from the repository root or any folder above the test), `"index.css"` joined to a folder above it,
 * `"../../sdk/src/app.ts"` (from the test, or from its folder), `join(import.meta.dirname, "..", "public", "_locales")`
 * (adjacent literals joined) and the fixed head of a template (`` `apps/web/public${icon}` ``). Names that are
 * no file of the repository come out too; they never match a changed file. `dir`: a folder (two or more named parts,
 * no extension), so a change anywhere under it counts.
 *
 * @param {string} file  the test file
 * @param {string} text  its text
 * @returns {{path: string, dir: boolean}[]}
 */
export function namedPaths(file, text) {
  // Every quote may open a literal (a regex literal's quotes would throw a left-to-right reading off by one).
  const literals = new Map();
  for (const m of text.matchAll(/(?=(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1)/g)) literals.set(m.index, { value: m[2], end: m.index + m[2].length + 2, template: m[1] === "`" });
  const names = [];
  for (const [start, literal] of literals) {
    // A module it imports is vitest's to follow, not a read.
    if (/(?:\bfrom|\bimport\s*\(?|\b(?:mock|doMock|importActual|importOriginal|require)\s*\()\s*$/.test(text.slice(Math.max(0, start - 24), start))) continue;
    if (literal.template && literal.value.includes("${")) {
      names.push(literal.value.slice(0, literal.value.indexOf("${")));
      continue;
    }
    names.push(literal.value);
    // `join(root, "..", "web", "src", "main.tsx")`: the literals in a row, one path.
    let joined = literal.value;
    for (let cur = literal; ;) {
      const comma = /^\s*,\s*/.exec(text.slice(cur.end, cur.end + 40));
      const next = comma && literals.get(cur.end + comma[0].length);
      if (!next || (next.template && next.value.includes("${"))) break;
      joined += `/${next.value}`;
      names.push(joined);
      cur = next;
    }
  }
  const dir = file.split("/").slice(0, -1);
  const out = new Map();
  for (const name of names) {
    if (!name || name.length > 200 || !/[./]/.test(name) || /[\s*?{}[\]()|^$\\:@<>,;=!#%&+~]/.test(name)) continue;
    const segs = name.split("/").filter((s) => s && s !== ".");
    const named = segs.filter((s) => s !== "..");
    if (!named.length) continue;
    const folder = named.length >= 2 && !named[named.length - 1].includes(".");
    // A relative name is joined to the test (`fileURLToPath(import.meta.url)`) or its folder; a bare one to a folder above.
    const bases = segs[0] === ".." || name.startsWith("./") ? [[...dir, file.split("/").pop()], dir] : dir.map((_, k) => dir.slice(0, dir.length - k)).concat([[]]);
    for (const base of bases) {
      const parts = [...base];
      let outside = false;
      for (const s of segs) {
        if (s !== "..") parts.push(s);
        else if (parts.length) parts.pop();
        else { outside = true; break; }
      }
      if (!outside && parts.length) out.set(parts.join("/"), out.get(parts.join("/")) || folder);
    }
  }
  return [...out].map(([path, isDir]) => ({ path, dir: isDir }));
}

/**
 * The test files (`*.test.*` in `files`) that name one of `changed` by path (namedPaths): they read it from disk, and
 * no import graph shows that, so `vitest related` finds none of them.
 *
 * @param {string[]} changed  changed files (deleted ones too: the test that reads one fails)
 * @param {Record<string, string>} files  path → text of the files to look in
 * @returns {string[]} those test files, sorted
 */
export function testsReading(changed, files) {
  if (!changed.length) return [];
  const exact = new Set(changed);
  // A test is read only when it holds the name of a changed file or of a folder one is in.
  const words = [...new Set(changed.flatMap((p) => p.split("/")))];
  const out = [];
  for (const [path, text] of Object.entries(files)) {
    if (!isTest(path) || !words.some((w) => text.includes(w))) continue;
    if (namedPaths(path, text).some((n) => exact.has(n.path) || (n.dir && changed.some((c) => c.startsWith(`${n.path}/`))))) out.push(path);
  }
  return out.sort();
}

// ---------- what a bundle is built from ----------

/**
 * The modules a bundle is built from (paths without extension): `entry` and what it imports, by relative path or
 * through a workspace package (packageImports: `@ghostly/core` is core's barrel, `@ghostly/browser/x` is
 * packages/browser/src/x). A module not in `files` (a .json, a deleted file) is kept but not followed.
 *
 * @param {string} entry  the bundle's entry file
 * @param {Record<string, string>} files  path → text of the files to follow
 * @param {Record<string, [string, string][]>} [packages]  the workspaces' exports (workspaceExports)
 * @returns {Set<string>}
 */
export function bundleReaches(entry, files, packages) {
  const byModule = new Map(Object.keys(files).map((p) => [stripExt(p), p]));
  const out = new Set();
  const queue = [stripExt(entry)];
  while (queue.length) {
    const mod = queue.pop();
    const path = byModule.get(mod) ?? byModule.get(`${mod}/index`);
    const id = path ? stripExt(path) : mod;
    if (out.has(id)) continue;
    out.add(id);
    if (!path) continue;
    queue.push(...relativeImports(path, files[path]), ...packageImports(files[path], packages));
  }
  return out;
}

// ---------- seeing through @ghostly/core's barrel ----------

const CORE_SRC = "packages/core/src/";
const CORE_INDEX = "packages/core/src/index";
const stripExt = (p) => p.replace(/\.(?:d\.ts|[cm]?[jt]sx?)$/, "");
const nameOf = (spec) => spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop().trim();
const namesIn = (list) => list.split(",").map(nameOf).filter(Boolean);
const origNameOf = (spec) => spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();

/** Names a core module exports: its own declarations, `export { a, b }` lists, and what it re-exports. */
function exportedNames(module, coreFiles, seen = new Set()) {
  if (seen.has(module)) return new Set();
  seen.add(module);
  const text = coreFiles[module] ?? "";
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) for (const n of namesIn(m[1])) names.add(n);
  for (const m of text.matchAll(/^export\s*\*\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
    for (const n of exportedNames(relativeImports(module, `from "${m[1]}"`)[0], coreFiles, seen)) names.add(n);
  }
  return names;
}

/**
 * Everything imports @ghostly/core through its barrel (packages/core/src/index.ts), so to vitest's module graph
 * every test depends on every core module and `vitest related packages/core/src/sshsig.ts` runs them all. This reads
 * the imports instead: the core modules that change (the changed ones and the core modules importing them), the
 * names they export through the barrel, and the files outside core that import one of those names (or the whole
 * barrel: `import * as`, `export *`, `import("@ghostly/core")`) or import a changed module by path.
 *
 * @param {string[]} changedCore  changed files under packages/core/src (not index.ts: that is everything)
 * @param {Record<string, string>} files  path → text of every TypeScript file that may import core (core included)
 * @returns {string[]} the files outside packages/core/src that depend on the change
 */
export function throughCoreBarrel(changedCore, files) {
  const coreFiles = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(CORE_SRC)).map(([p, t]) => [stripExt(p), t]));
  // The core modules affected: the changed ones and, transitively, the core modules that import them.
  const affected = new Set(changedCore.map(stripExt));
  for (let grew = true; grew;) {
    grew = false;
    for (const [mod, text] of Object.entries(coreFiles)) {
      if (affected.has(mod) || mod === CORE_INDEX) continue;
      if (relativeImports(mod, text).some((d) => affected.has(d))) { affected.add(mod); grew = true; }
    }
  }
  // The barrel names those modules provide.
  const exposed = new Set();
  const index = coreFiles[CORE_INDEX] ?? "";
  for (const m of index.matchAll(/^export\s*\*\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
    const mod = relativeImports(CORE_INDEX, `from "${m[1]}"`)[0];
    if (affected.has(mod)) for (const n of exportedNames(mod, coreFiles)) exposed.add(n);
  }
  for (const m of index.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm)) {
    if (affected.has(relativeImports(CORE_INDEX, `from "${m[2]}"`)[0])) for (const n of namesIn(m[1])) exposed.add(n);
  }
  const isBarrel = (file, spec) => spec === "@ghostly/core" || (spec.startsWith(".") && [CORE_INDEX, CORE_SRC.slice(0, -1)].includes(relativeImports(file, `from "${spec}"`)[0]));
  const out = [];
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith(CORE_SRC)) continue;
    let hit = relativeImports(path, text).some((d) => affected.has(d));
    // Type-only imports are left out: they change no test's behaviour, and the typecheck step covers them.
    for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?(\*\s*(?:as\s+[A-Za-z0-9_$]+\s*)?|\{([^}]*)\}\s*)from\s*["']([^"']+)["']/g)) {
      if (hit) break;
      // A subpath of the package (`@ghostly/core/miniApp`, its package.json "exports") is that one module.
      if (!m[2] && m[5].startsWith("@ghostly/core/") && affected.has(`${CORE_SRC}${m[5].slice("@ghostly/core/".length)}`)) hit = true;
      if (m[2] || !isBarrel(path, m[5])) continue;
      if (m[3].trim().startsWith("*")) hit = true;
      else if (m[4] !== undefined && m[4].split(",").filter((n) => !/^\s*type\s/.test(n)).map(origNameOf).some((n) => exposed.has(n))) hit = true;
    }
    // `await import("@ghostly/core")` may use anything; `import("@ghostly/core").Name` and `typeof import(...)` are types.
    if (!hit) for (const m of text.matchAll(/(\btypeof\s+)?\bimport\s*\(\s*["']([^"']+)["']\s*\)(\s*\.)?/g)) if (isBarrel(path, m[2]) && !m[1] && !m[3]) hit = true;
    if (hit) out.push(path);
  }
  return out.sort();
}

// ---------- the plan ----------

/**
 * @param {object} input
 * @param {{path: string, exists: boolean, scriptsOnly?: boolean}[]} input.changed  scriptsOnly: a package.json whose
 *   "scripts" alone changed (it installs nothing new, so it is left out; run the script you changed yourself)
 * @param {{features: {id: string}[], paths?: Record<string, string[]>}} input.inventory
 * @param {Record<string, string>} input.e2eFiles  every .ts under e2e/ (path → text); specs are the *.spec.ts
 * @param {Record<string, string>} [input.codeFiles]  every TypeScript/JavaScript file of the workspaces (path →
 *   text), core's own included: with it, a change in packages/core/src reaches the tests of what imports it
 *   (throughCoreBarrel) instead of every test behind the barrel, and a change outside a project's `sources` reaches
 *   the project's tests that import it by relative path or package name (testsReaching)
 * @param {Record<string, [string, string][]>} [input.packages]  the workspaces' exports (workspaceExports), for the
 *   imports by package name; without it, @ghostly/core and @ghostly/browser's src
 */
export function plan({ changed: all, inventory, e2eFiles, codeFiles, packages }) {
  const scriptsOnly = all.filter((c) => c.scriptsOnly).map((c) => c.path);
  const changed = all.filter((c) => !c.scriptsOnly);
  const match = (globs, path) => globs.some((g) => globToRegExp(g).test(path));
  const matching = (globs) => changed.filter((c) => match(globs, c.path));
  const code = changed.filter((c) => !isDoc(c.path));
  const everything = matching(EVERYTHING);
  const why = (files) => files.map((c) => c.path).join(", ");
  const everythingWhy = everything.length ? `${why(everything)} changed (dependencies for every workspace)` : null;

  // unit
  const coreChanged = changed.filter((c) => c.exists && c.path.startsWith(CORE_SRC) && /\.[cm]?tsx?$/.test(c.path)).map((c) => c.path);
  const coreDependents = coreChanged.length && codeFiles ? throughCoreBarrel(coreChanged, codeFiles) : [];
  // The tests that read a changed file from disk by its name (docs included): no import graph shows those.
  const readers = codeFiles ? testsReading(changed.map((c) => c.path), codeFiles) : [];
  const unit = UNIT_PROJECTS.map((p) => {
    const whole = matching(p.whole);
    if (everythingWhy || whole.length) return { ...p, mode: "whole", reason: everythingWhy ?? `${why(whole)} changed` };
    // Without codeFiles a core module goes to vitest as it is (and reaches every test behind the barrel).
    const direct = code.filter((c) => c.exists && match(p.sources, c.path) && !(codeFiles && coreChanged.includes(c.path))).map((c) => c.path);
    const viaCore = coreDependents.filter((f) => match(p.sources, f) && !direct.includes(f));
    // Outside `sources` vitest is not asked (it would transform every test to find none), so the tests that reach
    // a change there by relative path are found here and handed over themselves.
    const outside = [...code.map((c) => c.path), ...coreDependents].filter((f) => !match(p.sources, f));
    const viaPath = outside.length && codeFiles ? testsReaching(outside, codeFiles, p.tests, packages).filter((f) => !direct.includes(f) && !viaCore.includes(f)) : [];
    // A deleted file counts too: the test that reads it fails.
    const read = Object.entries(p.reads ?? {})
      .filter(([glob]) => changed.some((c) => match([glob], c.path)))
      .flatMap(([, names]) => names.map((n) => `tools/scripts/test/${n}.test.ts`))
      .concat(p.reads ? [] : readers.filter((f) => match(p.tests, f)))
      .filter((f, i, all) => all.indexOf(f) === i && !direct.includes(f) && !viaCore.includes(f) && !viaPath.includes(f));
    const files = [...direct, ...viaCore, ...viaPath, ...read];
    const reach = p.bundle && codeFiles ? bundleReaches(p.bundle.entry, codeFiles, packages) : null;
    const bundled = p.bundle ? code.filter((c) => (reach ? reach.has(stripExt(c.path)) : match(p.bundle.sources, c.path))) : [];
    if (bundled.length && !files.includes(p.bundle.runner)) files.push(p.bundle.runner);
    if (!files.length) return { ...p, mode: "skip", reason: coreChanged.length && match(p.sources, coreChanged[0]) ? "nothing it tests imports the changed core code" : "nothing it imports changed" };
    const tests = files.filter(isTest).length;
    const parts = [];
    if (direct.length) parts.push(`${direct.length} changed file(s)`);
    if (viaCore.length) parts.push(`${viaCore.length} importer(s) of the changed core code`);
    if (viaPath.length) parts.push(`${viaPath.length} test file(s) importing the change by relative path`);
    if (read.length) parts.push(`${read.length} test file(s) reading a changed file from disk`);
    if (bundled.length) parts.push(`the tests of the built CLI (${bundled.length} changed file(s) it is built from)`);
    return { ...p, mode: "related", files, reason: `vitest related over ${parts.join(" + ")}${tests ? ` (${tests} test file(s) among them)` : ""}` };
  });

  // lint
  let lint;
  const lintWhole = matching(LINT.whole);
  if (everythingWhy || lintWhole.length) lint = { mode: "whole", reason: everythingWhy ?? `${why(lintWhole)} changed` };
  else {
    const files = changed.filter((c) => c.exists && LINT.ext.test(c.path) && match(LINT.scope, c.path)).map((c) => c.path);
    lint = files.length ? { mode: "files", files, reason: `eslint over ${files.length} changed file(s)` } : { mode: "skip", reason: "no linted file changed" };
  }

  // typecheck
  const tcWhole = matching(TYPECHECK_WHOLE);
  const typecheck = TYPECHECKS.map((t) => {
    if (everythingWhy || tcWhole.length) return { ...t, mode: "run", reason: everythingWhy ?? `${why(tcWhole)} changed` };
    const hits = code.filter((c) => match(t.sources, c.path));
    return hits.length ? { ...t, mode: "run", reason: `${hits.length} changed file(s) it checks` } : { ...t, mode: "skip", reason: "nothing it checks changed" };
  });

  // Rust
  const rust = RUST.map((r) => {
    const hits = matching(r.sources);
    return hits.length ? { ...r, mode: "run", reason: `${hits.length} changed file(s)` } : { ...r, mode: "skip", reason: "no Rust change" };
  });

  // e2e
  const specs = Object.keys(e2eFiles).filter(isSuiteSpec);
  const tagsOf = new Map(specs.map((s) => [s, specFeatures(e2eFiles[s])]));
  const ids = inventory.features.map((f) => f.id);
  const paths = inventory.paths ?? {};
  const globs = Object.entries(paths).map(([g, pats]) => ({ re: globToRegExp(g), pats }));
  const e2e = { mode: "select", whole: [], specs: new Set(), features: new Set(), because: [], unmapped: [], desktop: [], none: [] };
  const wholeBecause = [];
  if (everythingWhy) wholeBecause.push(everythingWhy);
  for (const c of changed) {
    const p = c.path;
    if (match(DESKTOP, p)) e2e.desktop.push(p);
    if (p.startsWith("e2e/desktop/") || p === "e2e/playwright.desktop.config.ts") continue;
    if (p.startsWith("e2e/matrix/") || p === "e2e/playwright.matrix.config.ts") { e2e.none.push(p); continue; }
    if (match(EVERYTHING, p)) continue;
    if (match(E2E_WHOLE, p)) { wholeBecause.push(`${p} changed (every spec uses it)`); continue; }
    if (isSuiteSpec(p)) {
      if (c.exists) { e2e.specs.add(p); e2e.because.push(`${p}: the spec itself`); } else e2e.none.push(p);
      continue;
    }
    if (p.startsWith("e2e/")) {
      const reach = /\.[cm]?[jt]sx?$/.test(p) ? [...specsImporting(p, e2eFiles)].filter(isSuiteSpec).sort() : [];
      for (const s of reach) e2e.specs.add(s);
      if (reach.length) { e2e.because.push(`${p}: imported by ${reach.join(", ")}`); continue; }
      // A file the specs read from disk (e2e/fixtures/chess) reaches them through the paths map, as source does.
      if (!globs.some((g) => g.re.test(p))) { e2e.none.push(p); continue; }
    }
    const hits = globs.filter((g) => g.re.test(p));
    if (!hits.length) { e2e.unmapped.push(p); continue; }
    const pats = [...new Set(hits.flatMap((g) => g.pats))];
    if (pats.includes("*")) { wholeBecause.push(`${p} is shared by most of the app (paths map says "*")`); continue; }
    if (!pats.length) { e2e.none.push(p); continue; }
    const got = ids.filter((id) => pats.some((pat) => featureMatcher(pat)(id)));
    for (const id of got) e2e.features.add(id);
    e2e.because.push(`${p} → ${pats.join(", ")}`);
  }
  for (const p of e2e.unmapped) wholeBecause.push(`${p} has no entry in e2e/features.json "paths"`);
  if (wholeBecause.length) {
    return { scriptsOnly, unit, lint, typecheck, rust, e2e: { mode: "whole", reasons: wholeBecause, desktop: e2e.desktop, specs: specs.sort() } };
  }
  const tagged = specs.filter((s) => [...tagsOf.get(s)].some((id) => e2e.features.has(id)) && !e2e.specs.has(s)).sort();
  const withTests = [...e2e.features].filter((id) => specs.some((s) => tagsOf.get(s).has(id))).sort();
  const out = {
    mode: e2e.specs.size || tagged.length ? "select" : "skip",
    wholeSpecs: [...e2e.specs].sort(),
    taggedSpecs: tagged,
    features: withTests,
    featuresWithoutE2e: [...e2e.features].filter((id) => !withTests.includes(id)).sort(),
    grep: withTests.length ? featureGrep(withTests) : null,
    reasons: e2e.because,
    none: e2e.none,
    desktop: e2e.desktop,
  };
  if (out.mode === "skip") out.reasons.push(changed.length ? "no changed file reaches an e2e spec" : "nothing changed");
  return { scriptsOnly, unit, lint, typecheck, rust, e2e: out };
}

/** A Playwright --grep for the tests tagged with any of these features (tags are part of what --grep reads). */
export function featureGrep(ids) {
  return `@feature:(?:${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})(?![\\w.-])`;
}

/** Problems in inventory.paths: a glob with no feature pattern list, or a pattern no feature matches. */
export function checkPaths(inventory) {
  const problems = [];
  const ids = inventory.features.map((f) => f.id);
  for (const [glob, pats] of Object.entries(inventory.paths ?? {})) {
    try { globToRegExp(glob); } catch (error) { problems.push(error.message); continue; }
    if (!Array.isArray(pats)) { problems.push(`paths["${glob}"]: a list of feature ids, area.* prefixes or "*"`); continue; }
    for (const pat of pats) {
      if (typeof pat !== "string" || !ids.some(featureMatcher(pat))) problems.push(`paths["${glob}"]: "${pat}" matches no feature`);
    }
  }
  return problems;
}
