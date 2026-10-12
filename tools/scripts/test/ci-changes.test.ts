import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGES_READ_FROM_SITE, TESTED_PAGES, WEBSITE_INPUTS, covers, plan, testedAs } from "../ci-changes.mjs";
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

describe("plan", () => {
  const ready = { draft: false };
  const draft = { draft: true };

  it("an app change skips the website and runs the Desktop jobs", () => {
    expect(plan(["apps/ui/src/components/ChatRow.tsx", "packages/browser/src/engine.ts"], ready)).toMatchObject({ rust: true, website: false, app: true });
  });

  it("a site change runs the website and skips the Desktop jobs", () => {
    expect(plan(["apps/website/app/page.tsx", "apps/website/e2e/bubbles.spec.ts"], ready)).toMatchObject({ website: true, app: false });
    expect(plan(["docs/wisps/101-webrtc.md"], ready)).toMatchObject({ website: true, app: false });
  });

  it("a document the site does not publish runs neither", () => {
    expect(plan(["docs/TESTING.md"], ready)).toMatchObject({ website: false, app: false });
  });

  it("an app file the site copies or quotes runs both", () => {
    expect(plan(["apps/ui/src/components/deck/Deck.tsx"], ready)).toMatchObject({ website: true, app: true });
    expect(plan(["packages/core/src/invite.ts"], ready)).toMatchObject({ website: true, app: true });
  });

  it("a ready pull request runs the full tier, whatever it changes", () => {
    expect(plan(["apps/ui/src/App.tsx"], ready)).toMatchObject({ rust: true, full: true, affected: false, packages: true, app: true });
    expect(plan([".github/workflows/ci.yml"], ready)).toMatchObject({ rust: true, website: true, website_e2e: true, app: true, packages: true, full: true, affected: false });
  });

  it("a draft runs the fast tier only, even when it changes the workflow", () => {
    const fast = { full: false, affected: true, packages: false, app: false, website_e2e: false };
    expect(plan(["packages/core/src/invite.ts"], draft)).toMatchObject({ ...fast, rust: false, website: true });
    expect(plan([".github/workflows/ci.yml"], draft)).toMatchObject({ ...fast, rust: false, website: true });
    expect(plan(["apps/ui/src/App.tsx"], draft)).toMatchObject({ ...fast, rust: false, website: false });
  });

  it("only a draft skips the Rust jobs, unless it changed Rust", () => {
    expect(plan(["apps/ui/src/App.tsx"], draft).rust).toBe(false);
    expect(plan(["apps/ui/src/App.tsx"], ready).rust).toBe(true);
    expect(plan(["apps/desktop/src/lib.rs"], draft).rust).toBe(true);
    expect(plan(["Cargo.lock"], draft).rust).toBe(true);
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
    expect(plan(null, { draft: false, tested: true })).toMatchObject({ rust: true, website: false, website_e2e: false, app: false, packages: false, full: false, affected: false, tested: true });
    expect(plan(null, { draft: false }).tested).toBe(false);
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('if [[ "$DRAFT" != "true" && "$TESTED" != "true" && ( "$FULL" != "true"');
    expect(ci).toContain('if [[ "$TESTED" == "true" && "$PUSH_TO_DEV" != "true" ]]; then');
  });

  // dev's new commit, its tree, and the batch's head that holds that tree (tested at 20:54, landed at 21:01).
  const sha = "c".repeat(40);
  const tree = "t".repeat(40);
  const head = "h".repeat(40);
  const run = (over: object = {}) => ({ id: 7, html_url: "https://github.com/o/r/actions/runs/7", head_sha: head, head_commit: { tree_id: tree }, created_at: "2026-10-12T20:54:22Z", ...over });
  const landed = (date: string) => ({ commit: { committer: { date } } });
  const fake = ({ runs = [[run()]], jobs = [{ name: "CI Success", conclusion: "success" }], compare = { ahead_by: 2, commits: [landed("2026-10-12T21:00:50Z"), landed("2026-10-12T21:01:05Z")] } }: { runs?: object[][]; jobs?: object[]; compare?: object } = {}) => {
    const asked: string[] = [];
    const api = async (path: string) => {
      asked.push(path);
      const page = /[?&]page=(\d+)/.exec(path);
      if (page) return { workflow_runs: runs[Number(page[1]) - 1] ?? [] };
      if (path.startsWith("actions/runs/")) return { jobs };
      if (path.startsWith("compare/")) return compare;
      throw new Error(path);
    };
    return { api, asked };
  };

  it("finds the green run whose head holds the same tree", async () => {
    const { api, asked } = fake();
    expect(await testedAs({ sha, tree, api })).toBe("https://github.com/o/r/actions/runs/7");
    expect(asked).toContain(`compare/${head}...${sha}`);
    expect(asked[0]).toContain("event=pull_request&status=success");
  });

  it("does not take a run of another tree", async () => {
    const { api } = fake({ runs: [[run({ head_commit: { tree_id: "x".repeat(40) } })]] });
    expect(await testedAs({ sha, tree, api })).toBe(null);
  });

  it("does not take a draft's green run: only CI Success counts", async () => {
    const { api } = fake({ jobs: [{ name: "CI Success (draft)", conclusion: "success" }] });
    expect(await testedAs({ sha, tree, api })).toBe(null);
  });

  it("does not take a run that started when dev already held a commit its head lacks (it tested their merge)", async () => {
    const { api } = fake({ compare: { ahead_by: 2, commits: [landed("2026-10-12T20:50:00Z"), landed("2026-10-12T21:01:05Z")] } });
    expect(await testedAs({ sha, tree, api })).toBe(null);
  });

  it("does not take a run when the commits its head lacks are too many to list", async () => {
    const { api } = fake({ compare: { ahead_by: 300, commits: [landed("2026-10-12T21:01:05Z")] } });
    expect(await testedAs({ sha, tree, api })).toBe(null);
  });

  it("takes the next match when the newest one does not count", async () => {
    const other = run({ id: 8, html_url: "https://github.com/o/r/actions/runs/8", head_sha: "g".repeat(40) });
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.startsWith("actions/workflows/")) return { workflow_runs: [run(), other] };
      if (path === "actions/runs/7/jobs?per_page=100") return { jobs: [{ name: "CI Success", conclusion: "failure" }] };
      if (path.startsWith("actions/runs/")) return { jobs: [{ name: "CI Success", conclusion: "success" }] };
      return { ahead_by: 1, commits: [landed("2026-10-12T21:01:05Z")] };
    };
    expect(await testedAs({ sha, tree, api })).toBe("https://github.com/o/r/actions/runs/8");
  });

  it("reads at most TESTED_PAGES pages, and stops at a short one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => run({ id: i, head_commit: { tree_id: "x".repeat(40) } }));
    const many = fake({ runs: Array.from({ length: TESTED_PAGES + 2 }, () => full) });
    expect(await testedAs({ sha, tree, api: many.api })).toBe(null);
    expect(many.asked).toHaveLength(TESTED_PAGES);
    const short = fake({ runs: [[run({ head_commit: { tree_id: "x".repeat(40) } })], full] });
    expect(await testedAs({ sha, tree, api: short.api })).toBe(null);
    expect(short.asked).toHaveLength(1);
  });
});
