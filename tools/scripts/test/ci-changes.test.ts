import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGES_READ_FROM_SITE, RUST_INPUTS, TESTED_PAGES, WEBSITE_INPUTS, covers, draftBehind, plan, supersededBy, testedAs } from "../ci-changes.mjs";
import { FILES as DECK } from "../../../apps/website/scripts/sync-app-deck.mjs";
import { FILES as STORE_CORE } from "../../../apps/website/scripts/sync-store-core.mjs";

const root = resolve(import.meta.dirname, "../../..");

describe("the website gate", () => {
  it("covers every app file the deck check compares", () => {
    for (const file of DECK) expect(covers(WEBSITE_INPUTS, `apps/ui/src/components/${file}`), `apps/ui/src/components/${file}`).toBe(true);
  });

  it("covers every core file the store readers' check compares", () => {
    for (const file of STORE_CORE) expect(covers(WEBSITE_INPUTS, `packages/core/src/${file}`), `packages/core/src/${file}`).toBe(true);
  });

  it("covers every repository file and folder the site's scripts name", () => {
    // The site's own scripts (not capture/, a manual tool) read the repository by root-relative literals:
    // sync-references.mjs's documents, folder and excerpts, check-dashes.mjs's list. Any that names an existing file
    // or folder outside apps/website/ is an input. The deck's folder, apps/ui/src/components, is read file by file (above).
    const dir = join(root, "apps/website/scripts");
    const named = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/["'`]([\w.-]+(?:\/[\w.-]+)*)["'`]/g)].map((m) => m[1]))
      .filter((p) => p.includes("/") || p.endsWith(".md"))
      .filter((p) => !/^\.\.?\//.test(p) && !p.startsWith("apps/website/") && p !== "apps/ui/src/components");
    const kind = (p: string) => {
      try {
        return statSync(join(root, p)).isDirectory() ? "folder" : "file";
      } catch {
        return null;
      }
    };
    const files = named.filter((p) => kind(p) === "file");
    const folders = named.filter((p) => kind(p) === "folder");
    expect(files).toEqual(expect.arrayContaining(["packages/core/src/invite.ts", "packages/core/src/pairedTransports.ts", "docs/PROTOCOL.md", ".github/CONTRIBUTING.md"]));
    expect(folders).toContain("docs/wisps");
    for (const file of files) expect(covers(WEBSITE_INPUTS, file), file).toBe(true);
    for (const folder of folders) expect(covers(WEBSITE_INPUTS, `${folder}/any.md`), `${folder}/`).toBe(true);
  });

  it("covers every repository file and folder the site's code opens from a folder: its tests, browser checks and build", () => {
    // `resolve(__dirname, "../../../docs/…")` in a browser check, `join(root, "package.json")` in a test: a path joined
    // to the file's own folder, or to a folder the file declares from it (`const root = fileURLToPath(new URL("../../../",
    // import.meta.url))`, `const root = join(website, "../..")`). Its leading literals name the file or folder.
    const site = "apps/website";
    const code: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (["node_modules", ".next", "public", "test-results"].includes(entry.name) || path === `${site}/scripts/capture`) continue;
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) code.push(path);
      }
    };
    walk(site);
    const named: { file: string; path: string }[] = [];
    const here = "dirname(fileURLToPath(import.meta.url))";
    for (const file of code) {
      const source = readFileSync(join(root, file), "utf8");
      const folders = new Map([["__dirname", posix.dirname(file)], ["import.meta.dirname", posix.dirname(file)], [here, posix.dirname(file)]]);
      /** The repository path an expression names, when it is a declared folder or one joined from it by literals. */
      const at = (expr: string): string | undefined => {
        const url = /^fileURLToPath\(new URL\("([^"]*)", import\.meta\.url\)\)$/.exec(expr);
        if (url) return posix.join(posix.dirname(file), url[1]);
        const joined = /^(?:join|resolve)\((.+?)((?:,\s*["'`][^"'`$]*["'`])+)\)$/.exec(expr);
        const from = joined ? folders.get(joined[1].trim()) : folders.get(expr);
        return joined && from !== undefined ? posix.join(from, ...[...joined[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1])) : from;
      };
      for (const m of source.matchAll(/^(?:export )?const (\w+) = (.+);$/gm)) {
        const path = at(m[2]);
        if (path !== undefined) folders.set(m[1], path);
      }
      for (const m of source.matchAll(/\b(?:join|resolve)\(\s*([\w.]+|dirname\(fileURLToPath\(import\.meta\.url\)\))((?:\s*,\s*["'`][^"'`$]*["'`])+)/g)) {
        const from = folders.get(m[1]);
        if (from !== undefined) named.push({ file, path: posix.join(from, ...[...m[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((l) => l[1])).replace(/\/$/, "") });
      }
    }
    // Not the site itself, nor the root or apps/ it starts from. The deck's and the store readers' folders are read file
    // by file (above).
    const byFile = ["apps/ui/src/components", "packages/core/src"];
    const outside = named.filter(({ path }) => path !== "." && !path.startsWith("../") && !`${site}/`.startsWith(`${path}/`) && !path.startsWith(`${site}/`) && !byFile.includes(path));
    expect(outside).toEqual(
      expect.arrayContaining([
        { file: `${site}/e2e/launch-checklist.spec.ts`, path: "docs/assets/social-preview.png" },
        { file: `${site}/e2e/agents-page.spec.ts`, path: "docs/AI-AGENTS.md" },
        { file: `${site}/e2e/single-source.spec.ts`, path: "docs/wisps" },
        { file: `${site}/scripts/shots-version.test.mjs`, path: "package.json" },
      ]),
    );
    const uncovered = outside.filter(({ path }) => {
      const kind = (() => { try { return statSync(join(root, path)).isDirectory() ? "folder" : "file"; } catch { return null; } })();
      return !covers(WEBSITE_INPUTS, kind === "file" ? path : `${path}/any`);
    });
    expect(uncovered).toEqual([]);
  });
});

describe("the packages gate", () => {
  it("covers every site file and document the packages' tests and sources name", () => {
    // What `npm run test:packages` runs: packages/* and apps/extension/, their sources, tests and configs. A path into
    // apps/website/ or docs/ is written relative ("../../../apps/website/lib/invite") or from the root ("apps/website/...").
    const code: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".turbo"].includes(entry.name) || entry.name.startsWith("dist")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) code.push(path);
      }
    };
    for (const dir of readdirSync(join(root, "packages"))) walk(join(root, "packages", dir));
    walk(join(root, "apps", "extension"));
    const named = code.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:\.\.\/)+((?:apps\/website|docs)\/[^"'`\s)]*)|["'`]((?:apps\/website|docs)\/[^"'`\s)]*)/g)].map((m) => ({ file, path: m[1] ?? m[2] })),
    );
    expect(named.map((n) => n.path)).toEqual(expect.arrayContaining(["apps/website/lib/invite", "apps/website/public/oauth/client-metadata.json"]));
    for (const { file, path } of named) {
      // An import names a module without its extension.
      const real = [path, ...[".ts", ".tsx", ".mjs", ".js"].map((ext) => path + ext)].find((p) => { try { statSync(join(root, p)); return true; } catch { return false; } });
      const covered = real !== undefined && (statSync(join(root, real)).isDirectory() ? covers(PACKAGES_READ_FROM_SITE, `${real}/any`) : covers(PACKAGES_READ_FROM_SITE, real));
      expect(covered, `${file.slice(root.length + 1)} names ${path}`).toBe(true);
    }
  });
});

describe("the Rust gate", () => {
  it("covers every repository file and folder the crates' code names by include_str!, include_bytes! or CARGO_MANIFEST_DIR", () => {
    // include_str!/include_bytes! name a path from the file's own folder; env!("CARGO_MANIFEST_DIR") one from the
    // crate's, joined (`.join("…")`), concatenated (`concat!(env!(…), "/…")`) or formatted (`format!("{}/…", env!(…))`).
    const named: { file: string; path: string }[] = [];
    for (const crate of ["apps/desktop", "native/transports"]) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
          if (["target", "node_modules", "native-runtime", "gen"].includes(entry.name)) continue;
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith(".rs")) {
            const source = readFileSync(join(root, path), "utf8");
            for (const m of source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) named.push({ file: path, path: posix.join(posix.dirname(path), m[1]) });
            for (const m of source.matchAll(/env!\("CARGO_MANIFEST_DIR"\)(?:\s*\)\s*\.join\(\s*"([^"]*)"|\s*,\s*"([^"]*)")?/g)) named.push({ file: path, path: posix.join(crate, m[1] ?? m[2] ?? "") });
            for (const m of source.matchAll(/"\{\}([^"]*)",\s*env!\("CARGO_MANIFEST_DIR"\)/g)) named.push({ file: path, path: posix.join(crate, m[1].replace(/\{.*$/, "")) });
          }
        }
      };
      walk(crate);
    }
    expect(named.map((n) => n.path)).toEqual(
      expect.arrayContaining(["apps/web/public/app-frame.html", "packages/core/src/miniApp.ts", "native/translation/package.json", "native/translation/dist", "native/transports/hyperdht", "Cargo.lock", "packages/core/test/vectors/turn-record.json"]),
    );
    for (const { file, path } of named) {
      const isFile = (() => { try { return statSync(join(root, path)).isFile(); } catch { return false; } })();
      expect(covers(RUST_INPUTS, isFile ? path : `${path}/any`), `${file} names ${path}`).toBe(true);
    }
  });

  it("a ready pull request runs Tauri Backend only when it changes something the job reads", () => {
    const ready = { draft: false };
    for (const file of ["apps/ui/src/App.tsx", "packages/core/src/invite.ts", "docs/TESTING.md", "native/README.md", "tools/scripts/merge-train.mjs"]) expect(plan([file], ready).rust, file).toBe(false);
    for (const file of ["apps/desktop/src/clipboard.rs", "native/transports/src/lib.rs", "Cargo.lock", "Cargo.toml", "apps/web/public/app-frame.html", "packages/core/src/miniApp.ts", "native/translation/protocol.mjs", "packages/core/test/vectors/turn-record.json", ".github/workflows/ci.yml", "tools/scripts/ci-changes.mjs"]) {
      expect(plan(["apps/ui/src/App.tsx", file], ready).rust, file).toBe(true);
    }
    expect(plan(["apps/ui/src/App.tsx"], ready).why).toContain("Nothing the Rust job reads changed: Tauri Backend skipped");
  });

  it("a draft runs it for what the crates read, but not for a change to the workflow alone", () => {
    expect(plan(["packages/core/src/miniApp.ts"], { draft: true }).rust).toBe(true);
    expect(plan([".github/workflows/ci.yml", "tools/scripts/ci-changes.mjs"], { draft: true }).rust).toBe(false);
  });
});

describe("plan", () => {
  const ready = { draft: false };
  const draft = { draft: true };

  it("an app change skips the website and Tauri Backend, and runs the Desktop jobs", () => {
    expect(plan(["apps/ui/src/components/ChatRow.tsx", "packages/browser/src/engine.ts"], ready)).toMatchObject({ rust: false, website: false, app: true });
  });

  it("a site change runs the website and skips the Desktop jobs", () => {
    expect(plan(["apps/website/app/page.tsx", "apps/website/e2e/bubbles.spec.ts"], ready)).toMatchObject({ website: true, app: false });
    expect(plan(["docs/wisps/101-webrtc.md"], ready)).toMatchObject({ website: true, app: false });
  });

  it("a file outside the site that its checks read runs them: the social preview, the root version", () => {
    // launch-checklist.spec.ts checks the preview's size; shots-version.test.mjs the root package.json's version.
    expect(plan(["docs/assets/social-preview.png"], ready)).toMatchObject({ website: true, website_e2e: true });
    expect(plan(["package.json"], ready)).toMatchObject({ website: true, website_e2e: true, app: true, packages: true });
  });

  it("a document the site does not publish runs neither", () => {
    expect(plan(["docs/TESTING.md"], ready)).toMatchObject({ website: false, app: false });
  });

  it("an app file the site copies or quotes runs both", () => {
    expect(plan(["apps/ui/src/components/deck/Deck.tsx"], ready)).toMatchObject({ website: true, app: true });
    expect(plan(["packages/core/src/invite.ts"], ready)).toMatchObject({ website: true, app: true });
  });

  it("a ready pull request runs the full tier, whatever it changes", () => {
    expect(plan(["apps/ui/src/App.tsx"], ready)).toMatchObject({ rust: false, full: true, affected: false, packages: true, app: true });
    expect(plan([".github/workflows/ci.yml"], ready)).toMatchObject({ rust: true, website: true, website_e2e: true, app: true, packages: true, full: true, affected: false });
  });

  it("a draft runs the fast tier only, even when it changes the workflow", () => {
    const fast = { full: false, affected: true, packages: false, app: false, website_e2e: false };
    expect(plan(["packages/core/src/invite.ts"], draft)).toMatchObject({ ...fast, rust: false, website: true });
    expect(plan([".github/workflows/ci.yml"], draft)).toMatchObject({ ...fast, rust: false, website: true });
    expect(plan(["apps/ui/src/App.tsx"], draft)).toMatchObject({ ...fast, rust: false, website: false });
  });

  it("draft or ready, the Rust jobs run only when Rust changed", () => {
    expect(plan(["apps/ui/src/App.tsx"], draft).rust).toBe(false);
    expect(plan(["apps/ui/src/App.tsx"], ready).rust).toBe(false);
    expect(plan(["apps/desktop/src/lib.rs"], ready).rust).toBe(true);
    expect(plan(["apps/desktop/src/lib.rs"], draft).rust).toBe(true);
    expect(plan(["Cargo.lock"], draft).rust).toBe(true);
  });

  it("a Rust toolchain bump alone runs the Rust jobs, so the new clippy and rustfmt are met before it merges", () => {
    expect(plan(["rust-toolchain.toml"], ready).rust).toBe(true);
    expect(plan(["rust-toolchain.toml"], draft).rust).toBe(true);
  });

  it("no file list (a push, too many files) turns every path gate on, and the tier still applies", () => {
    expect(plan(null, ready)).toMatchObject({ rust: true, website: true, website_e2e: true, app: true, packages: true, full: true, affected: false });
    expect(plan(null, draft)).toMatchObject({ rust: false, website: true, website_e2e: false, app: false, packages: false, full: false, affected: true });
  });

  it("only docs/ and the site's own files skip the packages' tests", () => {
    expect(plan(["docs/TESTING.md", "docs/wisps/101-webrtc.md"], ready).packages).toBe(false);
    expect(plan(["apps/website/app/page.tsx"], ready).packages).toBe(false);
    expect(plan(["apps/website/lib/invite.ts"], ready).packages).toBe(true);
    expect(plan(["apps/website/public/oauth/client-metadata.json"], ready).packages).toBe(true);
    expect(plan(["docs/TESTING.md", "e2e/support/avatar-fixtures/avatar-extended.webp"], ready).packages).toBe(true);
    expect(plan(["README.md"], ready).packages).toBe(true);
  });

  it("the Desktop workflow is not the site", () => {
    expect(plan([".github/workflows/desktop-macos.yml"], ready)).toMatchObject({ website: false, app: true });
  });
});

describe("a push to dev whose tree a pull request already tested", () => {
  it("runs only Tauri Backend, which saves the Cargo cache, and CI Success accepts that plan", () => {
    expect(plan(null, { draft: false, tested: true })).toMatchObject({ lint: false, rust: true, website: false, website_e2e: false, app: false, packages: false, full: false, affected: false, tested: true });
    expect(plan(null, { draft: false }).tested).toBe(false);
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('if [[ "$DRAFT" != "true" && "$TESTED" != "true" && ( "$FULL" != "true"');
    expect(ci).toContain('if [[ "$TESTED" == "true" && "$PUSH_TO_DEV" != "true" ]]; then');
  });

  // agents#1830: lint and types ran again on a tree they had passed (2 to 3.5 min), and Tauri Backend built and tested
  // it (3 to 4 min) to save a Cargo cache that was already there on 29 of 33 pushes.
  it("skips lint and types, and Tauri Backend stops at the cache lookup when dev's Cargo cache for its key is saved", () => {
    expect(plan(null, { draft: false }).lint).toBe(true);
    expect(plan(null, { draft: true }).lint).toBe(true);
    expect(plan(["docs/A.md"], { draft: false }).lint).toBe(true);
    expect(plan(null, { draft: false, superseded: true }).lint).toBe(false);
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const job = (id: string) => ci.match(new RegExp(`^  ${id}:\n[\\s\\S]*?(?=^  [\\w-]+:\n|(?![\\s\\S]))`, "m"))?.[0] ?? "";
    expect(job("changes")).toContain("lint: ${{ steps.plan.outputs.lint }}");
    expect(job("frontend-checks")).toMatch(/^ {4}needs: changes\n {4}if: needs\.changes\.outputs\.lint == 'true'$/m);
    expect(job("ci-success")).toContain("LINT: ${{ needs.changes.outputs.lint }}");
    expect(job("ci-success")).toContain('! ok "$FRONTEND_CHECKS" "$LINT"');

    const steps = job("tauri").split(/^(?= {6}- name: )/m).slice(1);
    const named = (name: string) => steps.findIndex((s) => s.startsWith(`      - name: ${name}\n`));
    const lookup = steps[named("Is the Cargo cache saved already")] ?? "";
    // Only on a tested push, the exact key Restore Cargo and Save Cargo use, and no download.
    expect(lookup).toContain("if: needs.changes.outputs.tested == 'true'");
    expect(lookup).toContain("lookup-only: true");
    expect(lookup).toContain("key: ${{ steps.cargo-key.outputs.key }}");
    expect(lookup).not.toContain("restore-keys");
    expect(steps[named("Restore Cargo")]).toContain("key: ${{ steps.cargo-key.outputs.key }}");
    expect(steps[named("Save Cargo")]).toContain("key: ${{ steps.cargo-cache.outputs.cache-primary-key }}");
    // Every step from Restore Cargo to the last test is off on a hit; pruning and saving already need the tests to pass.
    const from = named("Restore Cargo");
    const to = named("Test (native/transports)");
    expect(from).toBeGreaterThan(named("Is the Cargo cache saved already"));
    expect(to).toBeGreaterThan(from);
    for (const step of steps.slice(from, to + 1)) expect(step).toMatch(/^ {8}if: steps\.cargo-saved\.outputs\.cache-hit != 'true'( &&.*)?$/m);
    expect(steps[named("Keep only what this build used in the saved Cargo cache")]).toContain("steps.test.outcome == 'success'");
  });

  // dev's new commit, its tree, and the batch's head that holds that tree (tested at 20:54, landed at 21:01).
  const sha = "c".repeat(40);
  const tree = "t".repeat(40);
  const head = "h".repeat(40);
  const repo = "o/r";
  const run = (over: object = {}) => ({
    id: 7,
    html_url: "https://github.com/o/r/actions/runs/7",
    path: ".github/workflows/ci.yml",
    head_sha: head,
    head_branch: "batch/dev-20261012205400",
    head_repository: { full_name: repo },
    head_commit: { tree_id: tree },
    created_at: "2026-10-12T20:54:22Z",
    ...over,
  });
  const landed = (date: string) => ({ commit: { committer: { date } } });
  // The batch, closed by the time dev's last push runs.
  const into = (ref: string, state = "closed", number = 41) => ({ number, state, base: { ref, repo: { full_name: repo } } });
  const fake = ({ runs = [[run()]], pulls = [into("dev")], events = {}, jobs = [{ name: "CI Success", conclusion: "success" }], compare = { ahead_by: 2, commits: [landed("2026-10-12T21:00:50Z"), landed("2026-10-12T21:01:05Z")] } }: { runs?: object[][]; pulls?: object[]; events?: Record<number, object[]>; jobs?: object[]; compare?: object } = {}) => {
    const asked: string[] = [];
    const api = async (path: string) => {
      asked.push(path);
      const page = /[?&]page=(\d+)/.exec(path);
      if (page) return { workflow_runs: runs[Number(page[1]) - 1] ?? [] };
      if (path.startsWith("pulls?")) return pulls;
      const issue = /^issues\/(\d+)\/events\?per_page=100$/.exec(path);
      if (issue) return events[Number(issue[1])] ?? [{ event: "closed" }];
      if (path.startsWith("actions/runs/")) return { jobs };
      if (path.startsWith("compare/")) return compare;
      throw new Error(path);
    };
    return { api, asked };
  };

  it("finds the green run whose head holds the same tree", async () => {
    const { api, asked } = fake();
    expect(await testedAs({ sha, tree, repo, api })).toBe("https://github.com/o/r/actions/runs/7");
    expect(asked).toContain(`compare/${head}...${sha}`);
    expect(asked[0]).toContain("event=pull_request&status=success");
    expect(asked).toContain(`pulls?state=all&per_page=100&head=${encodeURIComponent("o:batch/dev-20261012205400")}`);
  });

  it("does not take a run into an epic: it ran the epic's ci.yml, which may be a stub", async () => {
    const { api, asked } = fake({ pulls: [into("epic/x", "open")] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
    expect(asked.some((p) => p.startsWith("actions/runs/"))).toBe(false);
  });

  it("does not take a run whose branch also has a pull request into another base, even a closed one", async () => {
    const { api } = fake({ pulls: [into("dev"), into("epic/x")] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a run of a pull request moved to dev: its run may have run the old base's ci.yml", async () => {
    const moved = [{ event: "base_ref_changed" }, { event: "closed" }];
    const { api, asked } = fake({ pulls: [into("dev", "open", 77)], events: { 77: moved } });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
    expect(asked).toContain("issues/77/events?per_page=100");
    expect(asked.some((p) => p.startsWith("actions/runs/"))).toBe(false);
    // Any one of the branch's pull requests, and a page too full to read whole, count the same.
    expect(await testedAs({ sha, tree, repo, api: fake({ pulls: [into("dev"), into("dev", "closed", 77)], events: { 77: moved } }).api })).toBe(null);
    const full = Array.from({ length: 100 }, () => ({ event: "labeled" }));
    expect(await testedAs({ sha, tree, repo, api: fake({ events: { 41: full } }).api })).toBe(null);
  });

  it("does not take a run of a pull request GitHub moved to dev when its old base was deleted", async () => {
    for (const event of ["automatic_base_change_succeeded", "automatic_base_change_failed"]) {
      const moved = [{ event: "head_ref_deleted" }, { event }, { event: "head_ref_restored" }];
      const { api, asked } = fake({ pulls: [into("dev", "open", 77)], events: { 77: moved } });
      expect(await testedAs({ sha, tree, repo, api })).toBe(null);
      expect(asked.some((p) => p.startsWith("actions/runs/"))).toBe(false);
    }
  });

  it("does not take a run whose branch has no pull request it can name", async () => {
    const { api } = fake({ pulls: [] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a fork's run, whatever its branch is named", async () => {
    const { api, asked } = fake({ runs: [[run({ head_repository: { full_name: "someone/r" } })]] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
    expect(asked).toHaveLength(1);
  });

  it("does not take a run of another workflow file", async () => {
    const { api } = fake({ runs: [[run({ path: ".github/workflows/other.yml" })]] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a run of another tree", async () => {
    const { api } = fake({ runs: [[run({ head_commit: { tree_id: "x".repeat(40) } })]] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a draft's green run: only CI Success counts", async () => {
    const { api } = fake({ jobs: [{ name: "CI Success (draft)", conclusion: "success" }] });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a run that started when dev already held a commit its head lacks (it tested their merge)", async () => {
    const { api } = fake({ compare: { ahead_by: 2, commits: [landed("2026-10-12T20:50:00Z"), landed("2026-10-12T21:01:05Z")] } });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("does not take a run when the commits its head lacks are too many to list", async () => {
    const { api } = fake({ compare: { ahead_by: 300, commits: [landed("2026-10-12T21:01:05Z")] } });
    expect(await testedAs({ sha, tree, repo, api })).toBe(null);
  });

  it("takes the next match when the newest one does not count", async () => {
    const other = run({ id: 8, html_url: "https://github.com/o/r/actions/runs/8", head_sha: "g".repeat(40) });
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.startsWith("actions/workflows/")) return { workflow_runs: [run(), other] };
      if (path.startsWith("pulls?")) return [into("dev")];
      if (path.startsWith("issues/")) return [];
      if (path === "actions/runs/7/jobs?per_page=100") return { jobs: [{ name: "CI Success", conclusion: "failure" }] };
      if (path.startsWith("actions/runs/")) return { jobs: [{ name: "CI Success", conclusion: "success" }] };
      return { ahead_by: 1, commits: [landed("2026-10-12T21:01:05Z")] };
    };
    expect(await testedAs({ sha, tree, repo, api })).toBe("https://github.com/o/r/actions/runs/8");
  });

  // A batch of two lands as two pushes: the first holds the tree of the batch's first commit, which no run has as its
  // head. The landing may stop right there (the second changed or left the line), and then that push is dev's tip.
  it("does not count a push that holds a commit of a green batch below its head: the landing may stop there", async () => {
    const first = "f".repeat(40);
    const built = [
      { sha: "1".repeat(40), commit: { tree: { sha: first } } },
      { sha: head, commit: { tree: { sha: tree } } },
    ];
    const asked: string[] = [];
    const api = async (path: string) => {
      asked.push(path);
      if (path.startsWith("actions/workflows/")) return { workflow_runs: [run()] };
      if (path.startsWith("pulls?")) return [into("dev")];
      if (path.startsWith("issues/")) return [];
      if (path.startsWith("actions/runs/")) return { jobs: [{ name: "CI Success", conclusion: "success" }] };
      if (path === `compare/${sha}...${head}`) return { ahead_by: built.length, behind_by: 1, commits: built };
      if (path === `compare/${head}...${sha}`) return { ahead_by: 1, commits: [landed("2026-10-12T21:00:50Z")] };
      throw new Error(path);
    };
    expect(await testedAs({ sha, tree: first, repo, api })).toBe(null);
    expect(asked).toHaveLength(1);
    // CI then plans the push as any other: all of it runs.
    expect(plan(null, { draft: false })).toMatchObject({ full: true, app: true, packages: true, website: true, rust: true, tested: false });
  });

  it("reads at most TESTED_PAGES pages, and stops at a short one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => run({ id: i, head_branch: "issue-1-x", head_commit: { tree_id: "x".repeat(40) } }));
    const many = fake({ runs: Array.from({ length: TESTED_PAGES + 2 }, () => full) });
    expect(await testedAs({ sha, tree, repo, api: many.api })).toBe(null);
    expect(many.asked).toHaveLength(TESTED_PAGES);
    const short = fake({ runs: [[run({ head_branch: "issue-1-x", head_commit: { tree_id: "x".repeat(40) } })], full] });
    expect(await testedAs({ sha, tree, repo, api: short.api })).toBe(null);
    expect(short.asked).toHaveLength(1);
  });
});

// A batch of two lands as two pushes 3 to 6 s apart. The first one's run is already going when the second arrives, so
// the push-dev group cannot cancel it; the second one's run waits in that group and tests a tree that holds the first.
describe("a push to dev that dev already moved past", () => {
  const sha = "1".repeat(40);
  const tip = "2".repeat(40);
  const ciRun = (over: object = {}) => ({ head_sha: tip, path: ".github/workflows/ci.yml", html_url: "https://github.com/o/r/actions/runs/9", ...over });
  const fake = ({ heads = [tip], status = "ahead", runs = [ciRun()] }: { heads?: string[]; status?: string; runs?: object[] } = {}) => {
    const asked: string[] = [];
    let reads = 0;
    let settled = 0;
    const api = async (path: string) => {
      asked.push(path);
      if (path === "branches/dev") return { commit: { sha: heads[Math.min(reads++, heads.length - 1)] } };
      if (path.startsWith("compare/")) return { status };
      if (path.startsWith("actions/workflows/ci.yml/runs?")) return { workflow_runs: runs };
      throw new Error(path);
    };
    const settle = async () => {
      settled++;
    };
    return { api, asked, settle, settled: () => settled };
  };

  it("is covered by the newer head's push run, and is planned as tested (only Tauri Backend)", async () => {
    const { api, asked, settle, settled } = fake();
    expect(await supersededBy({ sha, api, settle })).toBe("https://github.com/o/r/actions/runs/9");
    expect(asked).toEqual(["branches/dev", `compare/${sha}...${tip}`, `actions/workflows/ci.yml/runs?event=push&branch=dev&head_sha=${tip}&per_page=10`]);
    expect(settled()).toBe(0);
    expect(plan(null, { draft: false, superseded: true })).toMatchObject({ rust: true, website: false, website_e2e: false, app: false, packages: false, full: false, affected: false, tested: true });
  });

  it("asks once more after settling when its plan starts before the next push lands", async () => {
    const { api, settle, settled } = fake({ heads: [sha, tip] });
    expect(await supersededBy({ sha, api, settle })).toBe("https://github.com/o/r/actions/runs/9");
    expect(settled()).toBe(1);
  });

  it("runs everything while it is still dev's head: the landing may have stopped there", async () => {
    const { api, asked, settle, settled } = fake({ heads: [sha] });
    expect(await supersededBy({ sha, api, settle })).toBe(null);
    expect(settled()).toBe(1);
    expect(asked).toEqual(["branches/dev", "branches/dev"]);
  });

  it("runs everything when dev's head does not hold it (a force push)", async () => {
    for (const status of ["diverged", "behind", "identical"]) {
      const { api, settle } = fake({ status });
      expect(await supersededBy({ sha, api, settle })).toBe(null);
    }
  });

  it("runs everything when CI has no push run for the newer head, or only another workflow's", async () => {
    for (const runs of [[], [ciRun({ head_sha: "3".repeat(40) })], [ciRun({ path: ".github/workflows/other.yml" })]]) {
      const { api, settle } = fake({ runs });
      expect(await supersededBy({ sha, api, settle })).toBe(null);
    }
  });

  it("says in its plan why it skips, apart from a tested tree", () => {
    expect(plan(null, { draft: false, superseded: true }).why[0]).toContain("dev already moved past this commit");
    expect(plan(null, { draft: false, tested: true }).why[0]).toContain("This tree already passed CI Success");
  });
});

// "Open as draft, `gh pr ready` seconds later": the draft event's run plans after the pull request left draft. Leaving
// draft's run cancels nothing (ci.yml's concurrency) and waits behind it, so this run stays the fast tier.
describe("a draft run whose pull request left draft after its event", () => {
  const sha = "4".repeat(40);
  const repo = "o/r";
  const own = 500;
  const ciRun = (over: object = {}) => ({
    id: 501,
    head_sha: sha,
    status: "queued",
    path: ".github/workflows/ci.yml",
    head_repository: { full_name: repo },
    pull_requests: [{ number: 7 }],
    html_url: "https://github.com/o/r/actions/runs/501",
    ...over,
  });
  const fake = (...reads: object[][]) => {
    const asked: string[] = [];
    let settled = 0;
    const api = async (path: string) => {
      asked.push(path);
      if (path.startsWith("actions/workflows/ci.yml/runs?")) return { workflow_runs: reads[Math.min(asked.length - 1, reads.length - 1)] };
      throw new Error(path);
    };
    const settle = async () => {
      settled++;
    };
    return { api, asked, settle, settled: () => settled };
  };
  const self = ciRun({ id: own, status: "in_progress", html_url: "https://github.com/o/r/actions/runs/500" });

  it("plans the fast tier when leaving draft's run waits behind it on the same head", async () => {
    const { api, asked, settle, settled } = fake([self, ciRun()]);
    expect(await draftBehind({ sha, run: own, pull: 7, repo, api, settle })).toBe("https://github.com/o/r/actions/runs/501");
    expect(asked).toEqual([`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=100`]);
    expect(settled()).toBe(0);
  });

  it("asks once more after settling when leaving draft's run does not exist yet", async () => {
    const { api, settle, settled } = fake([self], [self, ciRun()]);
    expect(await draftBehind({ sha, run: own, pull: 7, repo, api, settle })).toBe("https://github.com/o/r/actions/runs/501");
    expect(settled()).toBe(1);
  });

  it("runs everything when a run on this head is older: GitHub created leaving draft's first, and this one cancelled it", async () => {
    const { api, settle, settled } = fake([self, ciRun({ id: 499, status: "completed" })]);
    expect(await draftBehind({ sha, run: own, pull: 7, repo, api, settle })).toBe(null);
    expect(settled()).toBe(0);
  });

  it("runs everything when no run waits behind it (a rerun of an old draft run, a ready left by a token that starts no workflow)", async () => {
    for (const runs of [[self], [self, ciRun({ status: "completed" })]]) {
      const { api, settle, settled } = fake(runs);
      expect(await draftBehind({ sha, run: own, pull: 7, repo, api, settle })).toBe(null);
      expect(settled()).toBe(1);
    }
  });

  it("counts only this repository's ci.yml runs of this pull request on this head", async () => {
    for (const other of [
      ciRun({ head_sha: "5".repeat(40) }),
      ciRun({ path: ".github/workflows/other.yml" }),
      ciRun({ head_repository: { full_name: "fork/r" } }),
      ciRun({ pull_requests: [{ number: 8 }] }),
      ciRun({ pull_requests: [] }),
    ]) {
      const { api, settle } = fake([self, other]);
      expect(await draftBehind({ sha, run: own, pull: 7, repo, api, settle })).toBe(null);
    }
  });
});

// A green "CI Success (draft)" lets a ready pull request board the merge train, which then cancels its full run: the
// notice must not send a ready one to `gh pr ready`, nor name that full run as where the required check comes from.
describe("the notice of a green fast tier", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const job = (id: string) => ci.match(new RegExp(`^  ${id}:\n[\\s\\S]*?(?=^  [\\w-]+:\n|(?![\\s\\S]))`, "m"))?.[0] ?? "";
  /** A step's `run: |` script, unindented. */
  const script = (jobId: string, step: string) => {
    const body = job(jobId).split(`      - name: ${step}\n`)[1]?.split(/^ {8}run: \|\n/m)[1] ?? "";
    return body.split(/\n(?! {10}| *\n)/)[0].replace(/^ {10}/gm, "");
  };
  const bash = (text: string, env: Record<string, string>, path?: string) =>
    spawnSync("bash", ["-c", text], { encoding: "utf8", env: { PATH: path ?? process.env.PATH ?? "", ...env } });

  /** `changes`' outputs when the API says the pull request is ready, with leaving draft's run behind or not. */
  const planned = (payloadDraft: string, apiDraft: string, behind: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "ci-notice-"));
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho ${apiDraft}\n`, { mode: 0o755 });
    writeFileSync(join(dir, "node"), `#!/bin/sh\ncase "$*" in *--draft-behind*) exit ${behind ? 0 : 1};; esac\n`, { mode: 0o755 });
    const output = join(dir, "output");
    writeFileSync(output, "");
    const run = bash(script("changes", "Which jobs this change needs"), { EVENT: "pull_request", PAYLOAD_DRAFT: payloadDraft, CHANGED: "0", GITHUB_OUTPUT: output }, `${dir}:${process.env.PATH}`);
    expect(run.status, run.stderr).toBe(0);
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((l) => l.split("=")));
  };

  const gate = (draft: string, leftDraft: string) => {
    // The fast tier: lint and the affected tests passed, every other job skipped as its gate said.
    const skipped = ["FRONTEND_TESTS", "FRONTEND_BUILD", "PACKAGES_TESTS", "CLI_ARM64", "TAURI", "WEBSITE", "WEBSITE_E2E", "DESKTOP_MEDIA", "DESKTOP_MACOS"].map((j) => [j, "skipped"]);
    const off = ["RUST", "WEBSITE_GATE", "WEBSITE_E2E_GATE", "APP", "PACKAGES"].map((g) => [g, "false"]);
    const ok = { ...Object.fromEntries([...skipped, ...off]), CHANGES: "success", FRONTEND_CHECKS: "success", AFFECTED: "success", LINT: "true", AFFECTED_GATE: "true" };
    const run = bash(script("ci-success", "Check all jobs passed"), { ...ok, DRAFT: draft, LEFT_DRAFT: leftDraft, FULL: "false", TESTED: "false" });
    expect(run.status, run.stdout).toBe(0);
    return run.stdout.split("\n").filter((l) => l.startsWith("::notice::"));
  };

  it("tells a draft that the train may board it on this run once it is ready, and cancel the full run", () => {
    expect(planned("true", "true", false)).toEqual({ draft: "true" });
    expect(gate("true", "")).toEqual([
      "::notice::Draft: the fast tier passed. Once you mark it ready (gh pr ready), the merge train may board it on this run and cancel the full run; the batch's run is the check that counts.",
    ]);
  });

  it("tells one that left draft after this run started that the full run waits behind it, and does not ask for gh pr ready", () => {
    expect(planned("true", "false", true)).toEqual({ draft: "true", left_draft: "true" });
    expect(planned("true", "false", false)).toEqual({ draft: "false" });
    expect(job("changes")).toContain("left_draft: ${{ steps.plan.outputs.left_draft }}");
    expect(job("ci-success")).toContain("LEFT_DRAFT: ${{ needs.changes.outputs.left_draft }}");
    const notices = gate("true", "true");
    expect(notices).toEqual([
      "::notice::Left draft after this run started: the fast tier passed, and the full run waits behind this one. The merge train may board it on this run and cancel that full run; the batch's run is the check that counts.",
    ]);
    expect(notices.join()).not.toContain("gh pr ready");
  });
});
