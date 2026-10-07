import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ITEM_STATES, RUN_RESULTS } from "@ghostly/core";
import type { OptionSpec, Parsed } from "../args";
import { CliError } from "../errors";

/**
 * The commands that are one API method each: how the command line becomes the method's parameters. Commands with
 * their own flow (profiles, the daemon, listen, send's stdin, the engine passthrough) live in main.ts.
 */
export interface Command {
  method: string;
  usage: string;
  summary: string;
  options?: Record<string, OptionSpec>;
  /** Positionals, in order; a trailing `...` one takes the rest joined by spaces. */
  args?: string[];
  params?: (parsed: Parsed, args: Record<string, string | undefined>) => Record<string, unknown>;
  /**
   * A command that runs here, on files, with no profile or daemon (the publisher tools of WISP 1200): its answer is
   * printed as a method's is, and `method` only names it.
   */
  run?: (parsed: Parsed, args: Record<string, string | undefined>) => Promise<Record<string, unknown>>;
}

export const wait: Record<string, OptionSpec> = {
  wait: { type: "string", description: "none, sent or delivered (default: none with a daemon, sent without)" },
  timeout: { type: "number", description: "Seconds to wait (default 30)" },
};
/** A group has no receipts: `sent` waits until an edge took the frame (a member's, or one of my hubs'). */
export const groupWait: Record<string, OptionSpec> = {
  wait: { type: "string", description: "none or sent: until an edge took it (default none)" },
  timeout: { type: "number", description: "Seconds to wait (default 30)" },
};
export const net: OptionSpec = { type: "string", description: "mainnet or testnet (default testnet)" };
export const card: OptionSpec = { type: "string", description: "A Lightning card (its id; default: the network's default)" };
export const memo: OptionSpec = { type: "string", description: "What it is for (up to 140 characters)" };
export const confirmReal: OptionSpec = { type: "boolean", description: "Confirm a Mainnet (real money) spend" };

/** A path as this command's working directory means it: the daemon runs elsewhere. */
export function here(path: unknown): string | undefined {
  return typeof path === "string" ? resolve(path) : undefined;
}

/** A whole number of sats from the command line. */
export function sats(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isSafeInteger(n) || n <= 0) throw new CliError("usage", `Not an amount in sats: ${JSON.stringify(value)}`);
  return n;
}

/** `name=value` options as an object. */
export function pairs(values: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values) || !values.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of values as string[]) {
    const eq = item.indexOf("=");
    if (eq < 1) throw new CliError("usage", `--value takes name=value, not ${JSON.stringify(item)}`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

export const rate: OptionSpec = { type: "number", description: "The audio's sample rate: 48000 (default), 24000, 16000, 12000 or 8000" };
export const force: OptionSpec = { type: "boolean", description: "Send even if the text looks like a seed, a key or ecash" };
export const reply: OptionSpec = { type: "string", description: "Reply to this message (its id, from history or an event)" };
/** Buttons under a message (WISP 406 · Message Buttons): the text is the question. */
export const buttonOptions: Record<string, OptionSpec> = {
  button: { type: "list", description: "A button under the message, id:Label (again for each, 1 to 6; the label may hold colons). A press comes back as button.pressed" },
  style: { type: "list", description: "A button's look, id=primary, neutral or danger" },
  once: { type: "boolean", description: "Each person answers once: after a press their app offers the buttons no more" },
  id: { type: "string", description: "The question's id (default: made up, ask-…)" },
};
/** The group's entry link lets anyone join: printed only when asked for. */
export const showSecret: Record<string, OptionSpec> = { "show-secret": { type: "boolean", description: "Print the group's entry link (anyone who has it can join)" } };
export const secret = (options: Parsed["options"]) => (options["show-secret"] === true ? { showSecret: true } : {});

/** A history cursor: a timestamp when it is all digits, else a message id. */
export function cursor(value: unknown): string | number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  return /^\d{10,}$/.test(text) ? Number(text) : text;
}

/**
 * A status card's fields given as JSON (WISP 405 · Status Cards): inline (`{...}`), `-` for stdin, or a file's path. The
 * flags given beside it win over it.
 */
export function cardJson(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const text = String(value).trim();
  let raw: string;
  try { raw = text.startsWith("{") ? text : readFileSync(text === "-" ? 0 : resolve(text), "utf8"); }
  catch (error) { throw new CliError("usage", `--json takes a card as JSON, - for stdin, or a file: ${error instanceof Error ? error.message : String(error)}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError("usage", "--json is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError("usage", "--json is a JSON object of the card's fields");
  return parsed as Record<string, unknown>;
}

/** Options every status card command takes. */
export const cardOptions: Record<string, OptionSpec> = {
  json: { type: "string", description: "The card's fields as JSON: inline, - for stdin, or a file (flags win over it)" },
  link: { type: "list", description: "A link on the card: https://… or label=https://… (up to 4)" },
  text: { type: "string", description: "The text older apps show instead (default: written from the card)" },
};

/** `--link label=https://…` or a bare link, as a card's links. */
export function cardLinks(values: unknown): { url: string; label?: string }[] | undefined {
  if (!Array.isArray(values) || !values.length) return undefined;
  return (values as string[]).map((value) => {
    const eq = value.indexOf("=");
    return eq > 0 && !value.slice(0, eq).includes(":") ? { label: value.slice(0, eq), url: value.slice(eq + 1) } : { url: value };
  });
}

const listed = (words: readonly string[]) => `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

/**
 * `--item state:text` as a task's item. The word before the first colon is the state when it is one lowercase word (and
 * the colon does not start `://`): one of `ITEM_STATES`, or a usage error that lists them, so `queued:Publishing` is
 * refused rather than shown as that text. Anything else (`Step 2: build`, `Note: x`, a link, no colon) is the whole
 * text, pending; `pending:fix: tests` keeps a colon after a lowercase word.
 */
export function itemOf(value: string): { state: string; text: string } {
  const colon = value.indexOf(":");
  const word = colon > 0 ? value.slice(0, colon) : "";
  if (!/^[a-z]+$/.test(word) || value.startsWith("//", colon + 1)) return { state: "pending", text: value };
  if (!(ITEM_STATES as readonly string[]).includes(word))
    throw new CliError("usage", `--item takes state:text, and ${JSON.stringify(word)} is not a state: use ${listed(ITEM_STATES)} (pending:<text> keeps a colon in the text), not ${JSON.stringify(value)}`);
  return { state: word, text: value.slice(colon + 1).trim() };
}

/** A task's fields from its flags; what was not given is left out, so an update changes only what it names. */
export function taskFields(options: Parsed["options"]): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...cardJson(options.json) };
  const set = (key: string, value: unknown) => { if (value !== undefined) fields[key] = value; };
  set("id", options.id);
  set("title", options.title);
  set("status", options.status);
  set("progress", options.progress);
  set("step", options.step);
  set("branch", options.branch);
  if (options.steps !== undefined) {
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(options.steps));
    if (!match) throw new CliError("usage", `--steps takes done/total, like 2/5, not ${JSON.stringify(options.steps)}`);
    fields.done = Number(match[1]); fields.total = Number(match[2]);
  }
  const pr: Record<string, unknown> = {};
  for (const [flag, key] of [["pr-url", "url"], ["pr-number", "number"], ["additions", "additions"], ["deletions", "deletions"], ["files", "files"], ["pr-state", "state"], ["pr-checks", "checks"]] as const)
    if (options[flag] !== undefined) pr[key] = options[flag];
  if (Object.keys(pr).length) fields.pr = { ...(fields.pr && typeof fields.pr === "object" ? fields.pr as object : {}), ...pr };
  if (Array.isArray(options.item) && options.item.length) fields.items = (options.item as string[]).map(itemOf);
  if (Array.isArray(options.tag) && options.tag.length) fields.tags = options.tag as string[];
  set("parent", options.parent);
  const links = cardLinks(options.link);
  if (links) fields.links = links;
  return fields;
}

/**
 * The fields a new card cannot go without, given as a flag or in `--json`: a usage error (exit 2) that names the
 * flags. Before, a missing `--title` reached the card's own check and failed as `bad_request` (exit 1) with
 * "Status card: title is text".
 */
export function needs(card: Record<string, unknown>, fields: readonly (readonly [key: string, flag: string])[], usage: string): Record<string, unknown> {
  const missing = fields.filter(([key]) => typeof card[key] !== "string" || !(card[key] as string).trim()).map(([, flag]) => `--${flag}`);
  if (missing.length) throw new CliError("usage", `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} needed: ghostly ${usage}`);
  return card;
}

/** A time a command names: milliseconds, or a date the JavaScript Date reads (`2026-09-30T01:00:00Z`). */
export function cardTime(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new CliError("usage", `--${flag} takes a time in milliseconds or a date like 2026-09-30T01:00:00Z, not ${JSON.stringify(value)}`);
  return ms;
}

/** `--run ok`, `--run failed:"CI flaked"`: a run of a routine, recorded as its last. */
export function runOf(value: unknown): { result: string; summary?: string } | undefined {
  if (value === undefined) return undefined;
  const text = String(value), colon = text.indexOf(":");
  const result = colon === -1 ? text : text.slice(0, colon), summary = colon === -1 ? "" : text.slice(colon + 1).trim();
  if (!(RUN_RESULTS as readonly string[]).includes(result)) throw new CliError("usage", `--run takes ok, failed or skipped, and :a summary after it if you like, not ${JSON.stringify(value)}`);
  return { result, ...(summary && { summary }) };
}

/** A routine's fields from its flags; what was not given is left out. */
export function routineFields(options: Parsed["options"]): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...cardJson(options.json) };
  for (const key of ["id", "name", "schedule", "cron", "state"] as const) if (options[key] !== undefined) fields[key] = options[key];
  const next = cardTime(options.next, "next");
  if (next !== undefined) fields.nextRunAt = next;
  const links = cardLinks(options.link);
  if (links) fields.links = links;
  return fields;
}

/** Options a routine command takes, beside `cardOptions`. */
export const routineOptions: Record<string, OptionSpec> = {
  name: { type: "string", description: "What the routine is (120 characters)" },
  schedule: { type: "string", description: "When it runs, as people say it: \"every day 01:00\" (80 characters)" },
  cron: { type: "string", description: "Its cron line, shown beside the schedule (never run)" },
  state: { type: "string", description: "active (default on send) or paused" },
  next: { type: "string", description: "Its next run: milliseconds or a date like 2026-09-30T01:00:00Z" },
  run: { type: "string", description: "Record a run now: ok, failed or skipped, with :a summary if you like (it becomes the last run)" },
  ...cardOptions,
};

/** Options a task command takes, beside `cardOptions`. */
export const taskOptions: Record<string, OptionSpec> = {
  title: { type: "string", description: "What the task is (120 characters)" },
  status: { type: "string", description: "queued, running (default on send), blocked, done, failed or cancelled" },
  progress: { type: "number", description: "Percent done, 0 to 100" },
  steps: { type: "string", description: "Steps done of total, like 2/5 (progress is worked out from them)" },
  step: { type: "string", description: "What it is doing now (200 characters)" },
  item: { type: "list", description: "A step or log line, state:text with state pending, running, done, failed or skipped (text alone: pending). A lowercase word before the first colon must be one of them; pending:fix: x keeps the colon. The list replaces the card's (up to 20)" },
  branch: { type: "string", description: "The branch it works on" },
  "pr-url": { type: "string", description: "The pull request's https link" },
  "pr-number": { type: "number", description: "The pull request's number" },
  additions: { type: "number", description: "Lines the pull request adds" },
  deletions: { type: "number", description: "Lines the pull request removes" },
  files: { type: "number", description: "Files the pull request changes" },
  "pr-state": { type: "string", description: "Where the pull request stands: draft, open (ready for review), merged or closed" },
  "pr-checks": { type: "string", description: "The pull request's checks: passing, failing or pending" },
  tag: { type: "list", description: "A short label, like an area or a repository (24 characters); up to 3. An update's tags replace the card's: give all of them" },
  parent: { type: "string", description: "The id of the task of yours in this chat that this one is a part of" },
  ...cardOptions,
};

/**
 * `--also week=80` or `--also week=80@2026-10-10T00:00:00Z`: another window of a usage card, its percent left and, after
 * `@`, when it resets.
 */
export function usageWindowOf(value: string): { window: string; left: number; resetsAt?: number } {
  const match = /^([^=]+)=(\d+(?:\.\d+)?)(?:@(.+))?$/.exec(value.trim());
  if (!match) throw new CliError("usage", `--also takes window=percent or window=percent@time, like week=80@2026-10-10T00:00:00Z, not ${JSON.stringify(value)}`);
  const resetsAt = cardTime(match[3], "also");
  return { window: match[1].trim(), left: Number(match[2]), ...(resetsAt !== undefined && { resetsAt }) };
}

/** A usage card's fields from its flags (WISP 405 § Usage); `--json` gives any of them, the flags win over it. */
export function usageFields(options: Parsed["options"]): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...cardJson(options.json) };
  for (const key of ["id", "left", "used", "limit", "label", "account", "window"] as const) if (options[key] !== undefined) fields[key] = options[key];
  const resets = cardTime(options.resets, "resets");
  if (resets !== undefined) fields.resetsAt = resets;
  if (Array.isArray(options.also) && options.also.length) fields.windows = (options.also as string[]).map(usageWindowOf);
  return fields;
}

/** Options `usage send` takes. */
export const usageOptions: Record<string, OptionSpec> = {
  left: { type: "number", description: "Percent of the quota left, 0 to 100" },
  used: { type: "number", description: "How much is used, with --limit (instead of --left; the percent is worked out)" },
  limit: { type: "number", description: "The quota, with --used" },
  label: { type: "string", description: "What the quota is of, like Claude (24 characters)" },
  account: { type: "string", description: "Which of your accounts it is, short (24 characters)" },
  window: { type: "string", description: "The quota's window, as people say it: \"5 h\", \"week\" (16 characters)" },
  resets: { type: "string", description: "When the window starts again: milliseconds or a date like 2026-10-07T18:00:00Z" },
  also: { type: "list", description: "Another window, window=percent[@time], like week=80@2026-10-10T00:00:00Z (up to 3; shown in the details)" },
  id: { type: "string", description: "The card's id (default usage: one card per chat)" },
  all: { type: "boolean", description: "Every 1:1 chat with a contact, instead of one chat" },
  json: cardOptions.json,
  text: cardOptions.text,
};
