import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A maintenance script refuses an argument it does not take (a typo, an option it never had) with its usage and exit
 * 2, before it does anything: `coverage -- cor` ran nothing and exited 0, `test:map -- --wirte` wrote nothing, and
 * `locales:sort -- --check` sorted (wrote) the files instead of checking them.
 */
const root = resolve(import.meta.dirname, "../../..");
const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [`tools/scripts/${script}`, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });

describe("maintenance scripts refuse an argument they do not take", () => {
  it.each([
    ["coverage.mjs", ["cor"]],
    ["coverage.mjs", ["--html"]],
    ["test-map.mjs", ["--wirte"]],
    ["test-map.mjs", ["--summary", "--sumary"]],
    ["locales-sort.mjs", ["--check"]],
    ["changes.mjs", ["--preveiw", "1.12.0"]],
    ["changes.mjs", ["1.12.0"]],
    ["changes.mjs", ["--preview", "1.12.0", "extra"]],
    ["changes.mjs", ["--preview", "next"]],
  ])("%s %s: usage, exit 2, nothing done", (script, args) => {
    const result = run(script, ...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^usage: /m);
  });

  it("coverage names the packages it knows when a name matches none", () => {
    const { stderr } = run("coverage.mjs", "cor");
    expect(stderr).toContain('no package "cor"');
    expect(stderr).toContain("core, browser, sdk, ui, extension");
  });
});
