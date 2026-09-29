// The @gated e2e tests `npm run test:affected` picked, and the shared end-to-end stack they need: the pure half
// (scripts/test-affected.mjs runs the commands). The stack is e2e/infra on the maintainer's test server "one"
// (`--host one`, PR #183): every checkout joins it with `npm run e2e:infra:use -- --host one`, which forwards its
// ports here and writes `.env.e2e`. test:affected checks it answers and joins it; it never starts, stops or resets a
// stack, here or there, and never falls back to a local Docker stack.

/** The shared stack: the name `--host` takes, and the SSH target it stands for (e2e/infra/remote.mjs ALIASES). */
export const SHARED = { name: "one", host: "miguel@one" };

/** The commands, as a person types them. */
export const COMMANDS = {
  status: `npm run e2e:infra:status -- --host ${SHARED.name}`,
  use: `npm run e2e:infra:use -- --host ${SHARED.name}`,
};

const TAG_LITERAL = /\btag\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/g;

/**
 * The @gated tests among the picked e2e: every one in a spec that runs whole, the ones tagged with an affected
 * feature in a spec picked by tag. A test needs the stack when its spec reads one of the stack's variables
 * (e2e/infra/env.mjs VARIABLES: its gates and endpoints); the others wait on something else (Breez's hosted
 * regtest, a measurement's E2E_JOIN_RUNS) and skip unless their own variable is set.
 *
 * @param {{mode: string, specs?: string[], wholeSpecs?: string[], taggedSpecs?: string[], features?: string[]}} e2e
 *   the e2e part of select.mjs `plan`
 * @param {Record<string, string>} e2eFiles  path → text of the specs
 * @param {string[]} stackVariables  the variables `.env.e2e` holds
 * @returns {{stack: {spec: string, tests: number}[], other: {spec: string, tests: number}[], stackTests: number, otherTests: number}}
 */
export function gatedTests(e2e, e2eFiles, stackVariables) {
  const out = { stack: [], other: [], stackTests: 0, otherTests: 0 };
  if (e2e.mode === "skip") return out;
  const whole = new Set(e2e.mode === "whole" ? e2e.specs : e2e.wholeSpecs);
  const features = new Set(e2e.features ?? []);
  for (const spec of [...whole, ...(e2e.mode === "whole" ? [] : e2e.taggedSpecs)]) {
    const text = e2eFiles[spec] ?? "";
    let tests = 0;
    for (const m of text.matchAll(TAG_LITERAL)) {
      const tags = [...m[1].matchAll(/["'`](@[^"'`]+)["'`]/g)].map((t) => t[1]);
      if (!tags.includes("@gated")) continue;
      if (whole.has(spec) || tags.some((t) => t.startsWith("@feature:") && features.has(t.slice("@feature:".length)))) tests++;
    }
    if (!tests) continue;
    const needsStack = stackVariables.some((name) => new RegExp(`\\b${name}\\b`).test(text));
    out[needsStack ? "stack" : "other"].push({ spec, tests });
    out[needsStack ? "stackTests" : "otherTests"] += tests;
  }
  return out;
}

/** Where a `.env.e2e` points: "none" (no file), "local" (this machine's Docker), or the SSH target it names. */
export function envTarget(text) {
  if (text == null) return "none";
  return /^E2E_INFRA_HOST=(.+)$/m.exec(text)?.[1].trim() || "local";
}

/**
 * What to do about the stack before Playwright runs.
 *
 * @param {object} input
 * @param {number} input.tests  picked @gated tests that need the stack
 * @param {string} input.env  where this checkout's `.env.e2e` points (envTarget)
 * @param {"answers" | "silent" | "unjoined" | "unchecked"} input.check  what `status` (a run) or `check` (--list)
 *   said about the shared stack; "unjoined": it answers, but `use` failed; "unchecked": nobody asked
 * @param {string} [input.why]  why it is silent, unjoined or unchecked, for the plan
 * @param {boolean} [input.list]  --list: nothing runs, so say what a run would do
 * @returns {{use: boolean, blank: boolean, lines: string[]}}  use: run COMMANDS.use first; blank: `.env.e2e` points
 *   at a stack that does not answer, so its variables go to Playwright empty (the gated tests skip instead of
 *   timing out on dead ports, and the Cashu tests fall back to the public mint)
 */
export function stackDecision({ tests, env, check, why, list = false }) {
  if (!tests) return { use: false, blank: false, lines: [] };
  const n = `${tests} gated test(s)`;
  const on = `the shared stack on ${SHARED.name}`;
  const because = why ? ` (${why})` : "";
  const here = env === SHARED.host;
  if (check === "answers" && here) return { use: false, blank: false, lines: [`${on} answers and .env.e2e points there: ${n} run on it`] };
  if (check === "answers") {
    const replaces = env === "none" ? "" : env === "local" ? " (in place of .env.e2e's stack on this machine)" : ` (in place of .env.e2e's stack on ${env})`;
    return { use: true, blank: false, lines: [`${on} answers: ${list ? "a run joins it" : "joining it"} first${replaces}, then ${n} run on it`, `$ ${COMMANDS.use}   (port forwards + .env.e2e)`] };
  }
  if (check === "unchecked") {
    return { use: false, blank: false, lines: [`${on}: not checked${because}; ${n} need it`, `a run with the e2e checks it (${COMMANDS.status}) and joins it when it answers (${COMMANDS.use})`] };
  }
  const state = check === "unjoined" ? `${on} answers, but this checkout could not join it${because}` : `${on} does not answer${because}`;
  // A stack somewhere else was not asked about: it is used as .env.e2e names it.
  if (env !== "none" && !here) return { use: false, blank: false, lines: [`${state}: ${n} run against the stack .env.e2e names (${env === "local" ? "on this machine" : `on ${env}`}), if it answers`] };
  const blank = here;
  const lines = [`${state}: ${n} will skip${blank ? `; .env.e2e points there, so its variables are left out of this run` : ""}`];
  lines.push(`to run them: ${COMMANDS.status}, then ${COMMANDS.use} (test:affected never starts a stack)`);
  return { use: false, blank, lines };
}

/** Why `infra.mjs status` or `check` said no, in a few words, from what it printed. */
export function statusWhy(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const reasons = [];
  const failed = lines.find((l) => /^(?:Error:\s*)?Could not (?:connect|read)/.test(l));
  if (failed) return failed.replace(/^(?:Error:\s*)+/, "");
  for (const l of lines) {
    const forward = /cannot be forwarded to \S+: (.*?)(?:: whoever|\. Or set|$)/.exec(l);
    if (forward) reasons.push(`its ports cannot be forwarded here: ${forward[1]}`);
    const here = / NOT READY here: (.*)$/.exec(l);
    if (here) reasons.push(here[1]);
  }
  if (lines.some((l) => / is not running\.$/.test(l))) reasons.push("no containers there");
  const stuck = lines.map((l) => /^ghostly-e2e-(\S+)\s+(\w+)(?: \((\w+)\))?/.exec(l)).filter((m) => m && (m[2] !== "running" || (m[3] && m[3] !== "healthy")));
  if (stuck.length) reasons.push(stuck.map((m) => `${m[1]} ${m[3] && m[2] === "running" ? m[3] : m[2]}`).join(", "));
  const silent = lines.filter((l) => l.startsWith("SILENT")).map((l) => l.replace(/^SILENT\s+/, ""));
  if (silent.length) reasons.push(`silent: ${silent.join(", ")}`);
  return reasons.length ? reasons.join("; ") : (lines.at(-1) ?? "no answer");
}

/** The variables Playwright gets, blanked: a variable the shell sets wins over `.env.e2e` (e2e/playwright.config.ts). */
export const blanked = (names) => Object.fromEntries(names.map((name) => [name, ""]));
