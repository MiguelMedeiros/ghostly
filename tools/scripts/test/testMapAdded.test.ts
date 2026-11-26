import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// guards: #8414

/**
 * test-map.mjs --base: what a branch adds is held to more than what is there already. A test file it adds must declare
 * what it covers (or the bug it guards), and a user feature it adds needs an ungated e2e test, or a reason on the
 * allow list. Run on a throwaway repository with the script and an inventory of its own.
 */
const root = resolve(import.meta.dirname, "../../..");
const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

type Feature = { id: string; kind: "feature" | "protocol"; clients: string[] };
const feature = (id: string, kind: Feature["kind"] = "feature", clients = ["web"]): Feature => ({ id, kind, clients });
const inventory = (features: Feature[]) =>
  JSON.stringify({ clients: ["web", "extension", "desktop", "cli"], infra: {}, features: features.map((f) => ({ ...f, title: f.id, wisp: null, infra: [] })), paths: {} });
const spec = (tags: string) => `import { test } from "@playwright/test";\ntest("it", { tag: [${tags}] }, async () => {});\n`;

const BASE = {
  "tools/scripts/test-map.mjs": null,
  "tools/scripts/affected/select.mjs": null,
  "docs/wisps/numbering.json": "[]",
  "e2e/features.json": inventory([feature("a.old"), feature("a.unit-only")]),
  "e2e/web/old.spec.ts": spec(`"@feature:a.old"`),
  "packages/x/test/unit.test.ts": "// covers: a.unit-only\n",
  "packages/x/test/old.test.ts": "it('declares nothing');\n",
};

function write(dir: string, files: Record<string, string | null>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    if (text === null) cpSync(join(root, file), join(dir, file));
    else writeFileSync(join(dir, file), text);
  }
}
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });

/** A repository at BASE, tagged `base`, then one commit with `change`; `before` runs between the two. */
function branch(change: Record<string, string>, before?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-test-map-"));
  made.push(dir);
  write(dir, BASE);
  git(dir, "init", "-q", "-b", "dev");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "tag", "base");
  before?.(dir);
  write(dir, change);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change", "--allow-empty");
  return dir;
}
const map = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ["tools/scripts/test-map.mjs", ...args], { cwd: dir, encoding: "utf8", timeout: 60_000 });

describe("test-map --base: a new test file declares what it covers", () => {
  it("fails on a new unit test that declares nothing, with its path; an old one only warns", () => {
    const dir = branch({ "packages/x/test/new.test.ts": "it('declares nothing');\n" });
    const result = map(dir, "--base=base");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/x/test/new.test.ts: a new test file declares nothing");
    expect(result.stderr).not.toContain("old.test.ts");
    // Without --base the same tree only warns, as before.
    expect(map(dir).status).toBe(0);
  });

  it("fails on a new e2e spec with no @feature tag", () => {
    const result = map(branch({ "e2e/web/new.spec.ts": spec(`"@slow"`) }), "--base=base");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("e2e/web/new.spec.ts: a new test file declares nothing (no @feature tag)");
  });

  // e2e/matrix's scenario tests are a Vitest project (select.mjs "matrix"), not Playwright specs.
  it("reads a unit test under e2e/ as a unit test", () => {
    const result = map(branch({ "e2e/matrix/new.test.ts": "it('declares nothing');\n", "e2e/matrix/a.test.ts": "// covers: a.nope\n" }), "--base=base");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("e2e/matrix/new.test.ts: a new test file declares nothing (no // covers: comment)");
    expect(result.stderr).toContain('e2e/matrix/a.test.ts:1: unknown feature "a.nope"');
  });

  it("takes covers:, covers-gated:, a @feature tag or guards: #<issue> as a declaration", () => {
    const dir = branch({
      "packages/x/test/a.test.ts": "// covers: a.old\n",
      "packages/x/test/b.test.ts": "// covers-gated: a.old\n",
      "packages/x/test/c.test.ts": "// guards: #1234, #1240\n",
      "e2e/web/d.spec.ts": `// guards: #77\n${spec(`"@slow"`)}`,
      "e2e/web/e.spec.ts": spec(`"@feature:a.old"`),
    });
    const result = map(dir, "--base=base");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 guards: lines");
  });

  it("refuses a guards: line that names no issue number", () => {
    const result = map(branch({ "packages/x/test/a.test.ts": "// guards: the reload race\n" }), "--base=base");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/x/test/a.test.ts:1: guards: names issues as #<number>");
  });

  it("does not count a moved old file as new", () => {
    const dir = branch({}, (d) => renameSync(join(d, "packages/x/test/old.test.ts"), join(d, "packages/x/test/moved.test.ts")));
    expect(map(dir, "--base=base").status).toBe(0);
  });

  it("does not count what the base added since, after the branch merged it", () => {
    const dir = branch({ "packages/x/test/a.test.ts": "// covers: a.old\n" });
    git(dir, "checkout", "-qb", "later", "base");
    write(dir, { "packages/x/test/dev.test.ts": "it('landed before the rule');\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "the base moved on");
    git(dir, "checkout", "-q", "dev");
    git(dir, "merge", "-q", "--no-edit", "later");
    expect(map(dir, "--base=later").status).toBe(0);
    // Against the older base, the merged file is the branch's own.
    expect(map(dir, "--base=base").stderr).toContain("packages/x/test/dev.test.ts: a new test file declares nothing");
  });

  it("fails when the base cannot be read", () => {
    const result = map(branch({}), "--base=no-such-ref");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--base=no-such-ref: cannot read what the branch adds");
  });
});

describe("test-map --base: a new user feature needs an ungated e2e test", () => {
  const withFeatures = (more: Feature[], files: Record<string, string> = {}) =>
    branch({ "e2e/features.json": inventory([feature("a.old"), feature("a.unit-only"), ...more]), ...files });

  it("fails on a new feature with unit tests only, or a gated e2e only", () => {
    const result = map(withFeatures([feature("a.new"), feature("a.gated", "feature", ["web", "cli"])], {
      "packages/x/test/a.test.ts": "// covers: a.new\n",
      "e2e/web/g.spec.ts": spec(`"@feature:a.gated", "@gated"`),
    }), "--base=base");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("a.new: a new feature needs an ungated e2e test in web");
    expect(result.stderr).toContain("a.gated: a new feature needs an ungated e2e test in web");
  });

  it("passes with an ungated e2e test in one of its clients", () => {
    const result = map(withFeatures([feature("a.new", "feature", ["web", "desktop"])], {
      "e2e/desktop/n.spec.ts": spec(`"@feature:a.new"`),
    }), "--base=base");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes with a reason on the allow list, which a unit test does not make stale", () => {
    const result = map(withFeatures([feature("a.new")], {
      "packages/x/test/a.test.ts": "// covers: a.new\n",
      "e2e/allow-untested.json": JSON.stringify({ "a.new": "Needs a camera the e2e runner does not have" }),
    }), "--base=base");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("asks a protocol capability, or a feature with no e2e client, for any test", () => {
    const result = map(withFeatures([feature("a.wire", "protocol"), feature("a.cli", "feature", ["cli"])], {
      "packages/x/test/a.test.ts": "// covers: a.wire, a.cli\n",
    }), "--base=base");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("leaves an old feature with unit tests only alone", () => {
    expect(map(withFeatures([]), "--base=base").status).toBe(0);
  });
});
