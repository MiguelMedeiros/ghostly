import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * A test file the code names (`its loading: emojiPanelLoad.test.tsx`, `dhtBudgetWords.test.ts sends both sizes`) is
 * one the repository has. Test files are merged and renamed to cut their setup time, and the comments that sent a
 * reader to them stayed: a stylesheet's "a new loop goes here too (test/idleMotion.test.ts checks the stylesheets)",
 * the CLI's DHT size bounds and the emoji panel's loading all pointed at files no longer there, so a reader could not
 * find the check, or took it for gone. The changelog keeps the names of its day, and the tooling's own tests make up
 * file names for the scripts they run.
 */
const root = resolve(import.meta.dirname, "../../..");

/** Files whose test-file names are made up or historical, not references. */
const SKIP = /^docs\/changelog\/|^tools\/scripts\/test\/|^tools\/scripts\/test-bloat-report\.mjs$|(?:^|\/)package-lock\.json$|^tools\/scripts\/test-durations\.json$/;

/** Test files that live in another repository, named for where a number came from. */
const ELSEWHERE = new Set([
  // The agents repository's Playwright lab (pw/), where the missed-call spam was measured.
  "calls10.spec.ts",
]);

const NAME = /[\w.-]+\.(?:test|spec|probe)\.[cm]?[jt]sx?\b/g;

it("every test file a tracked file names is in the repository", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter((file) => file && existsSync(join(root, file)));
  const names = new Set(files.map((file) => basename(file)));
  const missing: string[] = [];
  for (const file of files) {
    if (SKIP.test(file) || !/\.(?:[cm]?[jt]sx?|css|md|json|ya?ml|html|rs|kt|sh)$/.test(file)) continue;
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const match of line.matchAll(NAME)) {
          const name = match[0];
          // A glob or a template (`*.test.ts`, `${name}.test.ts`) is no name.
          if (name.startsWith(".") || /[*}]/.test(line[match.index - 1] ?? "")) continue;
          if (!names.has(name) && !ELSEWHERE.has(name)) missing.push(`${file}:${i + 1} names ${name}`);
        }
      });
  }
  expect(missing).toEqual([]);
}, 30_000);
