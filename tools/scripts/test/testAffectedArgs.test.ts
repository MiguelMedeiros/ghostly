import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** test-affected.mjs over a change that reaches no step, with these arguments (and what npm put in the environment). */
function run(...args: string[]) {
  return runWith({}, ...args);
}
function runWith(npm: Record<string, string>, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_config_")));
  return spawnSync(process.execPath, ["tools/scripts/test-affected.mjs", "--files", "docs/TESTING.md", ...args], { cwd: ROOT, encoding: "utf8", env: { ...env, ...npm } });
}

describe("test-affected.mjs's arguments", () => {
  it.each(["--lsit", "--no-e2"])("refuses %s before anything runs, with the usage", (typo) => {
    const r = run(typo);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`does not take ${typo}`);
    expect(r.stderr).toContain("npm run test:affected -- --list");
  });

  it("refuses a path given after --files ended, not only a flag", () => {
    const r = run("--list", "apps/ui/src/App.tsx");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not take apps/ui/src/App.tsx");
  });

  // `npm run test:affected --list` (no `--`): npm keeps the flag (npm_config_list=true, `--no-e2e` → npm_config_e2e="")
  // and the script gets no argument at all, so the full run started.
  it.each([
    [{ npm_config_list: "true" }, "--list"],
    [{ npm_config_e2e: "", npm_config_rust: "" }, "--no-e2e --no-rust"],
  ])("refuses the flags npm kept for itself (%o) before anything runs", (npm, flags) => {
    const r = runWith(npm);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`npm run test:affected -- ${flags}`);
  });

  // A mistyped port was taken as it was: the unit tests, lint, typecheck and the web build ran first, and only the
  // e2e step found nothing answering there, a minute later. `--port --list` also took the flag as the port.
  it.each([["5o310"], ["70000"], ["--list"]])("refuses --port %s before anything runs", (value) => {
    const r = run("--port", value);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`--port ${value}: give a port number from 1 to 65535`);
  });

  it("refuses an E2E_WEB_PORT that is no port, naming it", () => {
    const r = runWith({ E2E_WEB_PORT: "50310x" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("E2E_WEB_PORT=50310x: give a port number from 1 to 65535");
  });

  it("names every flag and option it takes in --help", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    for (const arg of ["--list", "--no-e2e", "--no-rust", "--no-lint", "--no-typecheck", "--no-stack", "--base", "--port", "--files", "--unit-group"]) {
      expect(r.stdout).toContain(arg);
    }
    expect(r.stdout).toContain("tools/scripts/affected/stack.mjs");
  });

  it("takes every flag and option it documents, as CI's draft job passes them", () => {
    const r = run("--base", "HEAD", "--port", "4999", "--unit-group", "2/4", "--no-e2e", "--no-rust", "--no-lint", "--no-typecheck", "--no-stack", "--list");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("test:affected — 1 changed file(s) from --files (1)");
  });
}, 60_000);
