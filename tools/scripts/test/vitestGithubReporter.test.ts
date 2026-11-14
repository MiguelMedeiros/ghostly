import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Vitest } from "vitest/node";
import { RUNNER_MESSAGE_LIMIT, WholeCharsGithubReporter } from "../../vitest.shared.ts";

const ROOT = join(import.meta.dirname, "../../..");

/** The ::error lines a reporter writes for one failure whose message is `output`. */
function errorLines(output: string): string[] {
  const lines: string[] = [];
  const ctx = {
    getRootProject: () => ({ name: "" }),
    logger: { log: (line: string) => lines.push(line), formatError: () => ({ nearest: { file: "/repo/a.test.ts", line: 3, column: 5 }, output }) },
  } as unknown as Vitest;
  const reporter = new WholeCharsGithubReporter({ jobSummary: { enabled: false } });
  reporter.onInit(ctx);
  reporter.onTestRunEnd([], [{ message: "boom" } as never]);
  return lines.filter((line) => line.startsWith("\n::error "));
}

/** What the runner keeps of a command's message: unescaped, then its first RUNNER_MESSAGE_LIMIT UTF-16 units. */
function runnerKeeps(line: string): string {
  const data = line.slice(line.indexOf("::", 3) + 2);
  const message = data.replace(/%(25|0D|0A)/g, (_, code: string) => ({ "25": "%", "0D": "\r", "0A": "\n" })[code]!);
  return message.length > RUNNER_MESSAGE_LIMIT ? message.slice(0, RUNNER_MESSAGE_LIMIT) : message;
}

it("cuts a failure's message on a character, so the runner's own cut cannot split an emoji", () => {
  // 👻 from RUNNER_MESSAGE_LIMIT - 3 on: the runner's cut falls between the two halves of the second.
  const output = `expected 'a' to be '${"x".repeat(RUNNER_MESSAGE_LIMIT - 23)}${"👻".repeat(50)}'\n100% off`;
  expect(output.slice(0, RUNNER_MESSAGE_LIMIT).isWellFormed()).toBe(false);
  const [line] = errorLines(output);
  expect(line).toBeDefined();
  const kept = runnerKeeps(line!);
  expect(kept.isWellFormed()).toBe(true);
  expect(kept.length).toBeLessThanOrEqual(RUNNER_MESSAGE_LIMIT);
  expect(kept.endsWith("👻…")).toBe(true);
  expect(kept.startsWith("expected 'a' to be 'xxx")).toBe(true);
});

it("counts an escaped newline or percent as the one character the runner reads", () => {
  // Newlines take 3 characters in the command, 1 in the message: a message under the limit stays whole.
  const output = `${"line\n".repeat(Math.floor(RUNNER_MESSAGE_LIMIT / 5) - 1)}50% 👻`;
  const [line] = errorLines(output);
  expect(runnerKeeps(line!)).toBe(output);
});

it("makes a lone surrogate from elsewhere well formed", () => {
  const [line] = errorLines("expected 'a' to be 'a\uD83D'");
  expect(line!.isWellFormed()).toBe(true);
  expect(runnerKeeps(line!)).toBe("expected 'a' to be 'a�'");
});

it("takes the place of Vitest's own on GitHub Actions, and only there", () => {
  // Vitest picks its default reporters when it loads, by GITHUB_ACTIONS: in a process of its own.
  const read = (actions: string) => {
    const script = `const { reporters } = await import("./tools/vitest.shared.ts"); console.log(JSON.stringify(reporters.map((r) => typeof r === "string" ? r : r.constructor.name)));`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: actions, CI: actions } });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as string[];
  };
  expect(read("true")).toEqual([expect.any(String), "WholeCharsGithubReporter"]);
  expect(read("")).not.toContain("WholeCharsGithubReporter");
  expect(read("")).toHaveLength(1);
});

it("is the GitHub reporter of every Vitest config that CI runs", () => {
  const configs = [
    "apps/ui/vitest.ui.config.ts", "e2e/matrix/vitest.config.ts", "tools/scripts/vitest.config.ts", "packages/core/vitest.config.ts",
    "packages/browser/vitest.config.ts", "packages/sdk/vitest.config.ts", "packages/cli/vitest.config.ts", "apps/extension/vitest.config.ts",
    "apps/mini/chess/vitest.config.ts",
  ];
  for (const config of configs) expect(readFileSync(join(ROOT, config), "utf8"), config).toMatch(/\breporters\b/);
});
