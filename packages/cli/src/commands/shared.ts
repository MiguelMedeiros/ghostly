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
