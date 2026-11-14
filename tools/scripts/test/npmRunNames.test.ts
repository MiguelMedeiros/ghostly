import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The e2e and tools code tells a developer which command to run (usage headers, errors, skip reasons). A script
 * renamed in package.json leaves such a hint pointing at `Missing script`: each `npm run <name>` they name must
 * exist, in the root or in the workspace `-w` names.
 */
const root = join(import.meta.dirname, "..", "..", "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as { name?: string; scripts?: Record<string, string> };

const scripts = new Map<string, Set<string>>();
for (const path of git("ls-files", "package.json", "*/package.json")) {
  const m = manifest(path);
  scripts.set(path === "package.json" ? "" : (m.name ?? path), new Set(Object.keys(m.scripts ?? {})));
}

describe("the npm scripts e2e and tools code names", () => {
  it("each exists", () => {
    const files = git("ls-files", "e2e/*.ts", "e2e/*.mjs", "tools/scripts/*.ts", "tools/scripts/*.mjs", ":!tools/scripts/test/*");
    const missing: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(root, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/npm run ([\w:-]+)(?: -w ([@\w/.-]+))?/g)) {
          const [, name, workspace = ""] = m;
          if (!scripts.get(workspace)?.has(name)) missing.push(`${file}:${i + 1}: npm run ${name}${workspace ? ` -w ${workspace}` : ""}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });
});
