import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";
import { GithubActionsReporter, type Vitest } from "vitest/node";

/**
 * Settings every Vitest config here shares.
 *
 * Locally, several sessions test on one machine at once, and Vitest's default (a worker per core) in each of them
 * starved the machine: at most JOBS workers (default 2) when CI is unset. CI keeps Vitest's default.
 * `vitest --maxWorkers=<n>` still wins over this.
 */
export const maxWorkers = process.env.CI ? undefined : Math.max(1, Number(process.env.JOBS) || 2);

/** A list of tools/scripts/ (`{ file }` entries, paths from the repository root) as paths from `root`, those under it. */
function listed(name: string, root: string): string[] {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const list: { file: string }[] = JSON.parse(readFileSync(new URL(`./scripts/${name}`, import.meta.url), "utf8"));
  return list.map(({ file }) => relative(root, join(repo, file)).replaceAll("\\", "/")).filter((file) => !file.startsWith(".."));
}

/**
 * `base` (Vitest's own excludes by default) and the unit test files tools/scripts/quarantine.json takes out of the gate
 * for at most 7 days (docs/TESTING.md, "Quarantine"), as paths from the project's root: the folder Vitest runs in, or
 * the config's `root`. The nightly sets GHOSTLY_QUARANTINE=1 and keeps them. With GHOSTLY_INTEGRATION=0 (CI's
 * package shards, `test:affected`) also the files tools/scripts/integration-tests.json names, which start real peers,
 * daemons or a DHT: CI's Integration tests job runs them (test-shards.mjs --integration). A plain `npm test` keeps them.
 */
export function quarantined(base: string[] = configDefaults.exclude, root = process.cwd()): string[] {
  return [
    ...base,
    ...(process.env.GHOSTLY_QUARANTINE === "1" ? [] : listed("quarantine.json", root)),
    ...(process.env.GHOSTLY_INTEGRATION === "0" ? listed("integration-tests.json", root) : []),
  ];
}

/**
 * What the Actions runner keeps of an annotation's message, in UTF-16 units: it cuts a longer one there, by units, and a
 * cut inside an emoji left half of it, which the runner could not encode: it crashed ("EncoderFallbackException:
 * Unable to translate Unicode character \uD83D"), and the job lost its whole log, the failing test's name with it.
 */
export const RUNNER_MESSAGE_LIMIT = 4096;

/** A workflow command's message escapes these (Vitest's escapeData); the runner reads each as one character. */
const TOKEN = /%(?:25|0D|0A)|[\s\S]/gu;

/**
 * A workflow command line (`::error file=…::message`) with its message cut, between two characters, to what the runner
 * keeps whole, and no lone surrogate anywhere. The whole message is still in the log, from the default reporter.
 */
export function wholeCharsCommand(line: string, limit = RUNNER_MESSAGE_LIMIT): string {
  // A lone surrogate (only those are \p{Cs} in a /u pattern) as U+FFFD, as String.prototype.toWellFormed does.
  line = line.replace(/\p{Cs}/gu, "�");
  // Properties escape ":", so the first "::" after the command's name starts the message.
  const start = /^\n?::\w+(?: [^:]*)?::/.exec(line)?.[0].length;
  if (start === undefined) return line;
  const tokens = line.slice(start).match(TOKEN) ?? [];
  const units = (token: string) => (token.startsWith("%") ? 1 : token.length);
  if (tokens.reduce((sum, token) => sum + units(token), 0) <= limit) return line;
  let kept = "";
  let used = 0;
  // Room for the "…" that says it was cut.
  for (const token of tokens) {
    if (used + units(token) > limit - 1) break;
    used += units(token);
    kept += token;
  }
  return `${line.slice(0, start)}${kept}…`;
}

/** Vitest's GitHub Actions reporter (its default on CI), but each annotation's message cut by wholeCharsCommand. */
export class WholeCharsGithubReporter extends GithubActionsReporter {
  override onInit(ctx: Vitest): void {
    const logger = new Proxy(ctx.logger, {
      get: (target, key) => (key === "log" ? (...lines: unknown[]) => target.log(...lines.map((l) => (typeof l === "string" ? wholeCharsCommand(l) : l))) : bound(target, key)),
    });
    super.onInit(new Proxy(ctx, { get: (target, key) => (key === "logger" ? logger : bound(target, key)) }));
  }
}

/** A property of the real object, its methods called on it (Vitest's classes keep #private fields). */
function bound(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
}

/** Vitest's default reporters, with WholeCharsGithubReporter for its github-actions. `vitest --reporter=…` still replaces these. */
export const reporters = configDefaults.reporters.map((name) => (name === "github-actions" ? new WholeCharsGithubReporter() : name));
