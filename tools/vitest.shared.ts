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
