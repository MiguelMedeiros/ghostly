import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";

/**
 * What `ghostly listen` does with each event: print it as a JSON line, run a command with it on stdin, or POST it to
 * a local bridge. Events are handled one at a time, in order; a cursor file acknowledges each one handled, so a
 * restarted listener resumes after the last.
 */
export interface ListenOptions {
  types: string[];
  exec?: string;
  webhook?: string;
  cursor?: string;
  print: boolean;
  write: (line: string) => void;
}

/** Only loopback: events carry message text, and a webhook is a local bridge (WISP 11xx § Security). */
export function checkWebhook(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError("usage", `Not a URL: ${url}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new CliError("usage", "The webhook must be http:// or https://");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new CliError("usage", "The webhook must be on this machine (127.0.0.1, localhost or [::1])");
  return parsed;
}

export function readCursor(path: string | undefined): number | undefined {
  if (!path || !existsSync(path)) return undefined;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function writeCursor(path: string, seq: number): void {
  writeFileSync(path + ".tmp", String(seq) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export function matches(event: GhostlyEvent, types: readonly string[]): boolean {
  if (!types.length) return true;
  return types.some((type) => type.endsWith(".") || type.endsWith("*") ? event.type.startsWith(type.replace(/\*$/, "")) : event.type === type);
}

/** Runs `command` through the shell with the event on stdin (never in its arguments); resolves with its exit code. */
function runExec(command: string, event: GhostlyEvent): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, GHOSTLY_EVENT_TYPE: event.type, GHOSTLY_EVENT_ID: event.id, GHOSTLY_EVENT_SEQ: String(event.seq) },
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event) + "\n");
  });
}

async function post(url: URL, event: GhostlyEvent): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ghostly-event": event.type, "x-ghostly-seq": String(event.seq) }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
      if (response.ok) return true;
    } catch { /* retried */ }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return false;
}

/** A handler that takes events in order, one at a time. */
export function eventHandler(options: ListenOptions): (event: GhostlyEvent) => void {
  const webhook = options.webhook ? checkWebhook(options.webhook) : null;
  let chain = Promise.resolve();
  return (event) => {
    chain = chain.then(async () => {
      if (!matches(event, options.types)) { if (options.cursor) writeCursor(options.cursor, event.seq); return; }
      if (options.print) options.write(JSON.stringify(event));
      if (options.exec) {
        const code = await runExec(options.exec, event);
        if (code !== 0) process.stderr.write(`ghostly: --exec exited ${code} on event ${event.seq} (${event.type})\n`);
      }
      if (webhook && !(await post(webhook, event))) process.stderr.write(`ghostly: the webhook did not take event ${event.seq} (${event.type})\n`);
      // A failed handler still moves the cursor: one poisonous event must not stop the stream. The failure is on stderr.
      if (options.cursor) writeCursor(options.cursor, event.seq);
    });
  };
}
