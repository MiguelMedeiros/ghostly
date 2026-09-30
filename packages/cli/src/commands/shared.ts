import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * A status card's fields given as JSON (WISP 4xx · Status Cards): inline (`{...}`), `-` for stdin, or a file's path. The
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

const ITEM_STATES = ["pending", "running", "done", "failed", "skipped"];

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
  for (const [flag, key] of [["pr-url", "url"], ["pr-number", "number"], ["additions", "additions"], ["deletions", "deletions"], ["files", "files"]] as const)
    if (options[flag] !== undefined) pr[key] = options[flag];
  if (Object.keys(pr).length) fields.pr = { ...(fields.pr && typeof fields.pr === "object" ? fields.pr as object : {}), ...pr };
  if (Array.isArray(options.item) && options.item.length) fields.items = options.item.map((item) => {
    const colon = item.indexOf(":");
    const state = colon > 0 ? item.slice(0, colon) : "";
    return ITEM_STATES.includes(state) ? { state, text: item.slice(colon + 1).trim() } : { state: "pending", text: item };
  });
  const links = cardLinks(options.link);
  if (links) fields.links = links;
  return fields;
}

/** Options a task command takes, beside `cardOptions`. */
export const taskOptions: Record<string, OptionSpec> = {
  title: { type: "string", description: "What the task is (120 characters)" },
  status: { type: "string", description: "queued, running (default on send), blocked, done, failed or cancelled" },
  progress: { type: "number", description: "Percent done, 0 to 100" },
  steps: { type: "string", description: "Steps done of total, like 2/5 (progress is worked out from them)" },
  step: { type: "string", description: "What it is doing now (200 characters)" },
  item: { type: "list", description: "A step or log line, state:text (pending, running, done, failed, skipped); the list replaces the card's (up to 20)" },
  branch: { type: "string", description: "The branch it works on" },
  "pr-url": { type: "string", description: "The pull request's https link" },
  "pr-number": { type: "number", description: "The pull request's number" },
  additions: { type: "number", description: "Lines the pull request adds" },
  deletions: { type: "number", description: "Lines the pull request removes" },
  files: { type: "number", description: "Files the pull request changes" },
  ...cardOptions,
};
