// guards: #PRNUM
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TYPECHECKS } from "../affected/select.mjs";
import { runChecks } from "../typecheck.mjs";

const root = join(import.meta.dirname, "..", "..", "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as { scripts?: Record<string, string>; workspaces?: string[] };

/** The tsconfig a `tsc --noEmit [-p x]` checks, as a repository path. */
const tsconfigOf = (cmd: string[], cwd = "") => {
  const p = cmd.indexOf("-p");
  const target = join(cwd, p < 0 ? "tsconfig.json" : cmd[p + 1]);
  return target.endsWith(".json") ? target : join(target, "tsconfig.json");
};
const listed = new Set(TYPECHECKS.map((t: { cmd: string[] }) => tsconfigOf(t.cmd.slice(1))));

describe("npm run typecheck", () => {
  // test:affected types a change against TYPECHECKS; a workspace missing there (the CLI was) is never type-checked
  // before CI.
  it("runs the list test:affected reads", () => {
    expect(manifest("package.json").scripts?.typecheck).toBe("node tools/scripts/typecheck.mjs");
  });

  it("the list has the tsconfig of every workspace's own typecheck", () => {
    const workspaces = git("ls-files", ...(manifest("package.json").workspaces ?? []).map((w) => `:(glob)${w}/package.json`));
    expect(workspaces).toContain("packages/cli/package.json");
    const missing: string[] = [];
    for (const path of workspaces) {
      const script = manifest(path).scripts?.typecheck;
      if (!script) continue;
      for (const part of script.split("&&")) missing.push(tsconfigOf(part.trim().split(/\s+/), dirname(path)));
    }
    expect(missing.filter((t) => !listed.has(t))).toEqual([]);
  });

  // Each tsc is one thread; one after another they took 144 s of the lint job on a 4-core runner, eslint on one core
  // beside them.
  it("runs the tsc programs side by side, up to --jobs at a time", async () => {
    const sleep = (name: string) => ({ name, cmd: [process.execPath, "-e", "setTimeout(() => console.log('ok'), 300)"], seconds: 1 });
    let running = 0, most = 0;
    const log = (line: string) => {
      if (/^▶ \w+ started$/.test(line)) most = Math.max(most, ++running);
      else if (/^\w+: (passed|failed) in /.test(line)) running--;
    };
    const results = await runChecks([sleep("a"), sleep("b"), sleep("c"), sleep("d"), sleep("e")], { jobs: 2, cwd: root, log });
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(most).toBe(2);
    expect(running).toBe(0);
  });

  it("goes on past a failed one, prints each one's output whole, and says which failed", async () => {
    const lines: string[] = [];
    const results = await runChecks([
      { name: "bad", cmd: [process.execPath, "-e", "console.log('x.ts(1,1): error TS2322: no'); process.exit(2)"], seconds: 2 },
      { name: "good", cmd: [process.execPath, "-e", "console.log('fine')"], seconds: 1 },
    ], { jobs: 1, cwd: root, log: (l: string) => lines.push(l) });
    expect(results.map((r) => [r.name, r.ok])).toEqual([["bad", false], ["good", true]]);
    const text = lines.join("\n");
    expect(text).toMatch(/bad: failed[^\n]*\nx\.ts\(1,1\): error TS2322: no/);
    expect(text).toMatch(/good: passed[^\n]*\nfine/);
  });

  it("starts the longest first", async () => {
    const order: string[] = [];
    const quick = (name: string, seconds: number) => ({ name, cmd: [process.execPath, "-e", ""], seconds });
    await runChecks([quick("short", 3), quick("long", 70), quick("mid", 20)], { jobs: 1, cwd: root, log: (l: string) => { const m = /^▶ (\w+)/.exec(l); if (m) order.push(m[1]); } });
    expect(order).toEqual(["long", "mid", "short"]);
  });
});
