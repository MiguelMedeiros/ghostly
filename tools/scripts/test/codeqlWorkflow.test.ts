import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * codeql.yml, in place of CodeQL's default setup: the same three languages and query suite, analysed only where a
 * change can move their results. The default setup scanned all of the repository on every push the merge train lands
 * on dev (a push per pull request) and ran Rust's 12-minute analysis on every pull request, though few touch Rust.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/codeql.yml"), "utf8");
const ALL = ["actions", "javascript-typescript", "rust"];

/** One job's text, up to the next job. */
function job(name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job "${name}"`);
  const next = text.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next + 1);
}

describe("when it runs", () => {
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:\n"));

  it("pull requests into dev, main and the release branches, pushes to main, a daily run of dev, and by hand", () => {
    expect(on).toContain("  push:\n    branches: [main]\n");
    expect(on).toContain('  pull_request:\n    branches: [main, dev, "release/**"]\n');
    expect(on).toMatch(/\n {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \*"\n/);
    expect(on).toContain("\n  workflow_dispatch:\n");
  });

  it("never on a push to dev: the merge train lands a batch as a push per pull request, each of which was scanned as a pull request", () => {
    expect(on).not.toMatch(/push:\n {4}branches: \[[^\]]*\bdev\b/);
  });

  it("does nothing until the repository variable says the default setup is off: GitHub rejects advanced results while it is on", () => {
    expect(job("plan")).toContain("    if: vars.CODEQL_WORKFLOW == 'on'\n");
    expect(job("analyze")).toContain("    needs: plan\n");
  });

  type Ctx = { workflow: string; event_name: string; run_id: number; event: { pull_request?: { number: number } } };
  const block = text.match(/^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m);
  const evaluate = (expr: string, github: Ctx) =>
    expr.replace(/\$\{\{(.*?)\}\}/g, (_, e: string) => {
      const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_m, i) => String(a[Number(i)]));
      return String(new Function("github", "format", `return (${e.replaceAll("==", "===")});`)(github, format));
    });
  let run = 1;
  const ctx = (event_name: string, event: Ctx["event"] = {}): Ctx => ({ workflow: "CodeQL", event_name, run_id: run++, event });
  const group = (c: Ctx) => evaluate(block?.[1] ?? "", c);
  const cancels = (c: Ctx) => evaluate(block?.[2] ?? "", c) === "true";

  it("a new push to a pull request cancels the analysis it supersedes; nothing else shares a group or cancels", () => {
    const pr = (number: number) => ctx("pull_request", { pull_request: { number } });
    expect(group(pr(7))).toBe(group(pr(7)));
    expect(group(pr(7))).not.toBe(group(pr(8)));
    expect(cancels(pr(7))).toBe(true);
    for (const c of [ctx("push"), ctx("schedule"), ctx("workflow_dispatch")]) {
      expect(group(c)).not.toBe(group({ ...c, run_id: run++ }));
      expect(cancels(c)).toBe(false);
    }
  });
});

describe("which languages a pull request analyses", () => {
  const step = job("plan").slice(job("plan").indexOf("      - name: Which languages this change needs\n"));
  const script = step
    .slice(step.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const dir = mkdtempSync(join(tmpdir(), "codeql-plan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A git that answers `diff` with the pull request's files, or fails. It prints them as git does: one per line, a name
  // with a `"`, a `\` or a control character in C quotes, and with a byte above 0x7f too unless core.quotePath is
  // false; with -z, NUL after each name and nothing quoted.
  const fake = `#!/usr/bin/env node
const args = process.argv.slice(2);
const quotePath = !(args[0] === "-c" && /^core\\.quotePath=false$/i.test(args[1]));
const rest = quotePath ? args : args.slice(2);
if (rest[0] !== "diff" || process.env.FAIL) process.exit(1);
const files = process.env.FILES ? JSON.parse(process.env.FILES) : [];
const named = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: '"', 92: "\\\\" };
const quote = (name) => {
  const bytes = Buffer.from(name);
  if (!bytes.some((b) => b < 32 || b === 34 || b === 92 || b === 127 || (quotePath && b > 127))) return bytes;
  const out = [];
  for (const b of bytes) {
    if (named[b]) out.push("\\\\" + named[b]);
    else if (b < 32 || b === 127 || (quotePath && b > 127)) out.push("\\\\" + b.toString(8).padStart(3, "0"));
    else out.push(String.fromCharCode(b));
  }
  return Buffer.concat([Buffer.from('"'), Buffer.from(out.join(""), "latin1"), Buffer.from('"')]);
};
const z = rest.includes("-z");
process.stdout.write(Buffer.concat(files.flatMap((f) => [z ? Buffer.from(f) : quote(f), Buffer.from(z ? "\\0" : "\\n")])));
`;
  writeFileSync(join(dir, "git"), fake);
  chmodSync(join(dir, "git"), 0o755);

  /** head: the pull request's branch, and the repository it comes from (this one unless a fork's). */
  const plan = (files: string[] | null, event = "pull_request", head = { ref: "issue-1-a-fix", repo: "o/ghostly" }): string[] => {
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const pull = event === "pull_request" ? { HEAD_REF: head.ref, HEAD_REPO: head.repo } : {};
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, EVENT: event, REPO: "o/ghostly", ...pull, FILES: files ? JSON.stringify(files) : "", FAIL: files ? "" : "1", GITHUB_OUTPUT: output },
      stdio: "ignore",
    });
    const line = readFileSync(output, "utf8");
    expect(line).toMatch(/^languages=\[.*\]\n$/);
    return JSON.parse(line.slice("languages=".length));
  };

  it("anything but a pull request analyses every language", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) expect(plan(null, event), event).toEqual(ALL);
  });

  it("Rust only when a Rust source, Cargo manifest or lock, or the toolchain file changes", () => {
    expect(plan(["apps/ui/src/App.tsx"])).toEqual(["javascript-typescript"]);
    expect(plan(["packages/core/src/miniApp.ts", "apps/web/public/app-frame.html"])).toEqual(["javascript-typescript"]);
    expect(plan(["apps/desktop/src/viewer.rs"])).toEqual(["rust"]);
    expect(plan(["Cargo.lock"])).toEqual(["rust"]);
    expect(plan(["native/transports/iroh-web/Cargo.toml"])).toEqual(["rust"]);
    expect(plan(["rust-toolchain.toml"])).toEqual(["rust"]);
    expect(plan(["apps/desktop/build.rs", "apps/ui/src/lib/x.ts"])).toEqual(["javascript-typescript", "rust"]);
  });

  it("JavaScript/TypeScript unless every change is Rust, Markdown or an image, which its analysis never reads", () => {
    expect(plan(["docs/CLI.md", "docs/assets/readme/logo.png"])).toEqual([]);
    expect(plan(["docs/CLI.md", "apps/website/content/cli.ts"])).toEqual(["javascript-typescript"]);
    for (const file of ["apps/ui/index.html", "apps/ui/src/locales/en/chat.json", "e2e/features.json", "apps/ui/src/index.css", "package-lock.json", "apps/desktop/tauri.conf.json"])
      expect(plan([file]), file).toEqual(["javascript-typescript"]);
  });

  it("Actions only when a workflow or an action changes", () => {
    expect(plan([".github/workflows/ci.yml"])).toEqual(["actions", "javascript-typescript"]);
    expect(plan([".github/actions/playwright-chromium/action.yml"])).toEqual(["actions", "javascript-typescript"]);
    expect(plan(["tools/actions/thing/action.yaml"])).toEqual(["actions", "javascript-typescript"]);
  });

  it("reads a name with a non-ASCII character, a quote, a backslash or a line break as it is, not as git quotes it", () => {
    expect(plan([".github/workflows/ação.yml"])).toEqual(["actions", "javascript-typescript"]);
    expect(plan(['.github/workflows/a"b.yml'])).toEqual(["actions", "javascript-typescript"]);
    expect(plan(["tools/actions/é/action.yml"])).toEqual(["actions", "javascript-typescript"]);
    expect(plan(["apps/desktop/src/café.rs"])).toEqual(["rust"]);
    expect(plan(['apps/desktop/src/a"b.rs', "apps/desktop/src/a\\b.rs", "apps/desktop/src/a\tb.rs"])).toEqual(["rust"]);
    // A line break splits a name in two lines: the first keeps the name's start, the last its end; at worst a language
    // more is analysed.
    expect(plan([".github/a\nb.md"])).toEqual(["actions", "javascript-typescript"]);
    expect(plan(["apps/desktop/src/a\nb.rs"])).toEqual(["javascript-typescript", "rust"]);
    expect(plan(["apps/ui/src/ç.tsx"])).toEqual(["javascript-typescript"]);
  });

  it("lists the files under `shell: bash`, which sets pipefail: a git that fails is not read as a short list", () => {
    expect(step).toContain("        shell: bash\n");
  });

  it("a change to this workflow, or a list of files that cannot be read, analyses every language", () => {
    expect(plan([".github/workflows/codeql.yml"])).toEqual(ALL);
    expect(plan(null)).toEqual(ALL);
    expect(plan([])).toEqual(ALL);
  });

  it("a merge train batch analyses nothing: each pull request in it was analysed on its own, and the batch is never merged", () => {
    const batch = { ref: "batch/dev-20261113-0912", repo: "o/ghostly" };
    expect(plan(["apps/ui/src/App.tsx", "apps/desktop/src/viewer.rs", ".github/workflows/ci.yml"], "pull_request", batch)).toEqual([]);
    expect(plan(null, "pull_request", batch)).toEqual([]);
  });

  it("a fork's pull request is analysed whatever its branch is called, and so is a branch that only looks like a batch's", () => {
    expect(plan(["apps/ui/src/App.tsx"], "pull_request", { ref: "batch/dev-20261113-0912", repo: "someone/ghostly" })).toEqual(["javascript-typescript"]);
    expect(plan(["apps/ui/src/App.tsx"], "pull_request", { ref: "batch/dev-20261113-0912", repo: "" })).toEqual(["javascript-typescript"]);
    expect(plan(["apps/ui/src/App.tsx"], "pull_request", { ref: "fix/batch/dev-1", repo: "o/ghostly" })).toEqual(["javascript-typescript"]);
  });

  it("reads the branch and both repositories from the event into env, never into the script", () => {
    expect(step).toContain("          HEAD_REF: ${{ github.head_ref }}\n");
    expect(step).toContain("          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}\n");
    expect(step).toContain("          REPO: ${{ github.repository }}\n");
    expect(script).not.toContain("${{");
  });
});

describe("what it may do", () => {
  it("reads the repository and writes code scanning results, nothing else", () => {
    expect(text).toContain("\npermissions:\n  contents: read\n\n");
    expect(job("analyze")).toContain("    permissions:\n      contents: read\n      security-events: write\n    strategy:");
    expect(text.match(/^\s+[\w-]+: write$/gm)).toEqual(["      security-events: write"]);
    expect(text.match(/persist-credentials: false/g)).toHaveLength(2);
  });

  it("analyses the three languages the default setup did, under its categories", () => {
    expect(job("analyze")).toContain("        language: ${{ fromJSON(needs.plan.outputs.languages) }}\n");
    expect(job("analyze")).toContain("    if: needs.plan.outputs.languages != '[]'\n");
    expect(job("analyze")).toContain("          build-mode: none\n");
    expect(job("analyze")).not.toMatch(/^\s+(queries|config-file|packs):/m);
    expect(job("analyze")).toContain("          category: /language:${{ matrix.language }}\n");
  });

  it("pins every action by its full commit, its version in a comment", () => {
    const uses = [...text.matchAll(/^\s+uses: (\S+)(.*)$/gm)];
    expect(uses.map((m) => m[1].split("@")[0])).toEqual(["actions/checkout", "actions/checkout", "github/codeql-action/init", "github/codeql-action/analyze"]);
    for (const [, ref, comment] of uses) expect(`${ref}${comment}`).toMatch(/^[\w/-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    const codeql = uses.filter((m) => m[1].startsWith("github/codeql-action/")).map((m) => `${m[1].split("@")[1]}${m[2]}`);
    expect(new Set(codeql).size).toBe(1);
  });
});
