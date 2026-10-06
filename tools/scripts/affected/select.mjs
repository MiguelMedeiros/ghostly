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
    sources: ["tools/scripts/**", "e2e/features.json", "apps/web/nginx.conf", ".github/workflows/**"],
    whole: ["tools/scripts/vitest.config.ts", "tools/vitest.shared.ts"],
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
 * The test files that reach one of `changed` through relative imports, directly or through other files. It follows
 * relative paths only: a package name (`@ghostly/core`) is not followed, and core's barrel has throughCoreBarrel.
 * `./x`, `./x.js` and `./x.ts` all name x.ts, and `./dir` names dir/index.ts; other extensions (`.json`) are kept.
 *
 * @param {string[]} changed  changed files (deleted ones too: their importers break)
 * @param {Record<string, string>} files  path → text of the files to follow
 * @param {string[]} tests  globs of the test files wanted
 * @returns {string[]} those test files, sorted
 */
export function testsReaching(changed, files, tests) {
  const importers = new Map();
  for (const [path, text] of Object.entries(files)) {
    for (const dep of relativeImports(path, text)) {
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

// ---------- what a bundle is built from ----------

/**
 * The modules a bundle is built from (paths without extension): `entry` and what it imports, by relative path or
 * through a workspace package (`@ghostly/core` is core's barrel, `@ghostly/browser/x` is packages/browser/src/x).
 * A module not in `files` (a .json, a deleted file) is kept but not followed.
 *
 * @param {string} entry  the bundle's entry file
 * @param {Record<string, string>} files  path → text of the files to follow
 * @returns {Set<string>}
 */
export function bundleReaches(entry, files) {
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
    queue.push(...relativeImports(path, files[path]));
    for (const m of files[path].matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']@ghostly\/(core|browser\/([^"']+))["']/g)) {
      queue.push(m[1] === "core" ? CORE_INDEX : stripExt(`packages/browser/src/${m[2]}`));
    }
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
 *   the project's tests that import it by relative path (testsReaching)
 */
export function plan({ changed: all, inventory, e2eFiles, codeFiles }) {
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
  const unit = UNIT_PROJECTS.map((p) => {
    const whole = matching(p.whole);
    if (everythingWhy || whole.length) return { ...p, mode: "whole", reason: everythingWhy ?? `${why(whole)} changed` };
    // Without codeFiles a core module goes to vitest as it is (and reaches every test behind the barrel).
    const direct = code.filter((c) => c.exists && match(p.sources, c.path) && !(codeFiles && coreChanged.includes(c.path))).map((c) => c.path);
    const viaCore = coreDependents.filter((f) => match(p.sources, f) && !direct.includes(f));
    // Outside `sources` vitest is not asked (it would transform every test to find none), so the tests that reach
    // a change there by relative path are found here and handed over themselves.
    const outside = [...code.map((c) => c.path), ...coreDependents].filter((f) => !match(p.sources, f));
    const viaPath = outside.length && codeFiles ? testsReaching(outside, codeFiles, p.tests).filter((f) => !direct.includes(f) && !viaCore.includes(f)) : [];
    const files = [...direct, ...viaCore, ...viaPath];
    const reach = p.bundle && codeFiles ? bundleReaches(p.bundle.entry, codeFiles) : null;
    const bundled = p.bundle ? code.filter((c) => (reach ? reach.has(stripExt(c.path)) : match(p.bundle.sources, c.path))) : [];
    if (bundled.length && !files.includes(p.bundle.runner)) files.push(p.bundle.runner);
    if (!files.length) return { ...p, mode: "skip", reason: coreChanged.length && match(p.sources, coreChanged[0]) ? "nothing it tests imports the changed core code" : "nothing it imports changed" };
    const tests = files.filter(isTest).length;
    const parts = [];
    if (direct.length) parts.push(`${direct.length} changed file(s)`);
    if (viaCore.length) parts.push(`${viaCore.length} importer(s) of the changed core code`);
    if (viaPath.length) parts.push(`${viaPath.length} test file(s) importing the change by relative path`);
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
      if (reach.length) e2e.because.push(`${p}: imported by ${reach.join(", ")}`);
      else e2e.none.push(p);
      continue;
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
