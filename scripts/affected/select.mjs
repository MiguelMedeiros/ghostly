// What a change needs tested: the pure half of `npm run test:affected` (scripts/test-affected.mjs runs it).
//
// Input: the changed files (paths relative to the repository root, with whether each still exists), the feature
// inventory (e2e/features.json, whose `paths` map source globs to features) and the e2e test files with their
// sources. Output: a plan of unit, lint, typecheck, Rust and e2e steps, each with the reason it runs, runs whole,
// or is skipped. Nothing here touches the disk or the process, so scripts/test/affected.test.ts can drive it.

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
export const EVERYTHING = ["package.json", "package-lock.json", "patches/**"];

/**
 * The unit test projects. `sources`: a change there can change what these tests import, so `vitest related` looks
 * at it. `whole`: a change there (config, setup, install) is not in any import graph, so the project runs whole.
 */
export const UNIT_PROJECTS = [
  {
    name: "core", cwd: "packages/core", args: [],
    sources: ["packages/core/**"],
    whole: ["packages/core/package.json", "packages/core/vitest.config.ts", "packages/core/src/index.ts", "vitest.shared.ts"],
  },
  {
    name: "browser", cwd: "packages/browser", args: [],
    sources: ["packages/core/src/**", "packages/browser/**"],
    whole: ["packages/browser/package.json", "packages/browser/vitest.config.ts", "packages/core/src/index.ts", "vitest.shared.ts"],
  },
  {
    name: "sdk", cwd: "packages/sdk", args: [],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/sdk/**"],
    whole: ["packages/sdk/package.json", "packages/sdk/vite.config.ts", "packages/core/src/index.ts", "vitest.shared.ts"],
  },
  {
    name: "extension", cwd: "extension", args: [],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "src/**", "extension/**"],
    whole: ["extension/package.json", "extension/vitest.config.ts", "packages/browser/vite-plugin.ts", "packages/core/src/index.ts", "vitest.shared.ts"],
  },
  {
    name: "ui", cwd: ".", args: ["-c", "vitest.ui.config.ts"],
    sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/**", "src/**"],
    whole: ["vitest.ui.config.ts", "src/test/setup.ts", "packages/browser/vite-plugin.ts", "packages/core/src/index.ts", "vitest.shared.ts"],
  },
  {
    name: "matrix", cwd: ".", args: ["-c", "e2e/matrix/vitest.config.ts"],
    sources: ["e2e/matrix/**"],
    whole: ["e2e/matrix/vitest.config.ts", "vitest.shared.ts"],
  },
  {
    name: "scripts", cwd: ".", args: ["-c", "scripts/vitest.config.ts"],
    sources: ["scripts/**", "e2e/features.json"],
    whole: ["scripts/vitest.config.ts", "vitest.shared.ts"],
  },
];

/** `npm run lint`'s scope: what eslint is given, and what makes the whole lint run. */
export const LINT = {
  scope: ["src/**", "packages/**", "extension/src/**", "extension/test/*.ts", "web/src/**", "e2e/**", "examples/sdk-adapter/src/**", "examples/sdk-adapter/test/**"],
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
  { name: "ui (root tsconfig)", cmd: ["npx", "tsc", "--noEmit"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/**", "src/**", "tsconfig.json", "vite-env.d.ts"] },
  { name: "extension", cmd: ["npx", "tsc", "--noEmit", "-p", "extension/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "src/**", "extension/src/**", "extension/tsconfig.json"] },
  { name: "extension tests", cmd: ["npx", "tsc", "--noEmit", "-p", "extension/tsconfig.test.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "src/**", "extension/**"] },
  { name: "web", cmd: ["npx", "tsc", "--noEmit", "-p", "web/tsconfig.json"], sources: ["packages/core/src/**", "packages/browser/src/**", "packages/react/src/**", "src/**", "web/**"] },
  { name: "e2e", cmd: ["npx", "tsc", "--noEmit", "-p", "e2e"], sources: ["e2e/**", "packages/core/src/**"] },
];
export const TYPECHECK_WHOLE = ["tsconfig.json", "packages/*/tsconfig*.json"];

/** The Rust crates, as CI's Tauri and CLI jobs check them. */
export const RUST = [
  { name: "src-tauri", sources: ["src-tauri/**", "native-transports/**", "Cargo.toml", "Cargo.lock"] },
  { name: "cli", sources: ["cli/**", "Cargo.toml", "Cargo.lock"] },
];

/** The Playwright config of the web and extension projects: a change there can change every spec. */
export const E2E_WHOLE = ["e2e/playwright.config.ts", "e2e/tsconfig.json"];
/** Desktop specs run through tauri-driver on Linux and Windows only (e2e/playwright.desktop.config.ts). */
export const DESKTOP = ["e2e/desktop/**", "e2e/playwright.desktop.config.ts", "e2e/support/desktop.ts", "src-tauri/**", "src/desktop/**", "native-transports/**"];

const isTest = (p) => /\.test\.[cm]?[jt]sx?$/.test(p);
/** Prose: no test imports it and no compiler reads it. */
const isDoc = (p) => /\.(?:md|mdx|txt)$/i.test(p) || p.startsWith("docs/");
const isSpec = (p) => p.startsWith("e2e/") && /\.spec\.[cm]?[jt]sx?$/.test(p);

// ---------- e2e specs ----------

/** The feature ids a spec's `tag: [...]` literals name (the same reading as scripts/test-map.mjs). */
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
 * @param {Record<string, string>} [input.codeFiles]  every TypeScript file that may import @ghostly/core (path →
 *   text), core's own included: with it, a change in packages/core/src reaches the tests of what imports it
 *   (throughCoreBarrel) instead of every test behind the barrel
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
    const files = [...direct, ...viaCore];
    if (!files.length) return { ...p, mode: "skip", reason: coreChanged.length && match(p.sources, coreChanged[0]) ? "nothing it tests imports the changed core code" : "nothing it imports changed" };
    const tests = files.filter(isTest).length;
    const parts = [];
    if (direct.length) parts.push(`${direct.length} changed file(s)`);
    if (viaCore.length) parts.push(`${viaCore.length} importer(s) of the changed core code`);
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
  const specs = Object.keys(e2eFiles).filter((p) => isSpec(p) && !p.startsWith("e2e/desktop/"));
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
    if (match(EVERYTHING, p)) continue;
    if (match(E2E_WHOLE, p)) { wholeBecause.push(`${p} changed (every spec uses it)`); continue; }
    if (isSpec(p)) {
      if (c.exists) { e2e.specs.add(p); e2e.because.push(`${p}: the spec itself`); } else e2e.none.push(p);
      continue;
    }
    if (p.startsWith("e2e/")) {
      const reach = /\.[cm]?[jt]sx?$/.test(p) ? specsImporting(p, e2eFiles) : new Set();
      for (const s of reach) if (!s.startsWith("e2e/desktop/")) e2e.specs.add(s);
      if (reach.size) e2e.because.push(`${p}: imported by ${[...reach].join(", ")}`);
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
