import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { CONTACT_KEY } from "./apiKit";
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
  /** `--from` and `--group`: events of anyone else stop here (they stay in the chat). */
  allow?: Allowlist;
  /** `--turns`: only agent turns, as `agent.turn` events. */
  turns?: boolean;
}

/**
 * Who `listen` passes on, checked before any hook or output: chats by id (a contact key is matched to its chat as
 * events come, so a chat made after the start counts too), groups by id. An event of a chat or group not on it is
 * dropped; one that names neither (`daemon.started`, `events.gap`, `identity.approval`) is this profile's own and
 * passes.
 */
export class Allowlist {
  private readonly peers = new Map<string, string>();

  /** `peerOf`: a chat's contact key (null when it has none yet, or the chat is gone). */
  constructor(private readonly chats: ReadonlySet<string>, private readonly keys: ReadonlySet<string>, private readonly groups: ReadonlySet<string>, private readonly peerOf: (chat: string) => Promise<string | null>) {}

  async allows(event: GhostlyEvent): Promise<boolean> {
    if ("group" in event) return typeof event.group === "string" && this.groups.has(event.group);
    if (!("chat" in event)) return true;
    const chat = event.chat;
    if (typeof chat !== "string") return false;
    if (this.chats.has(chat)) return true;
    if (!this.keys.size) return false;
    // Kept once known: a chat's contact key does not change. One not paired yet is asked again next time.
    let key = this.peers.get(chat);
    if (!key) { key = (await this.peerOf(chat).catch(() => null)) || undefined; if (key) this.peers.set(chat, key); }
    return !!key && this.keys.has(key);
  }
}

/**
 * `--from` and `--group` as ids, resolved once at start: a contact key as that key (whatever any chat is named), else a
 * chat by id, prefix or name (`findChat`); a group by id, prefix or name. A name that later changes (or a contact who
 * renames themselves) moves nothing.
 */
export async function allowlist(from: readonly string[], groups: readonly string[], call: (method: string, params: Record<string, unknown>) => Promise<unknown>, peerOf: (chat: string) => Promise<string | null>): Promise<Allowlist> {
  const chats = new Set<string>(), keys = new Set<string>(), groupIds = new Set<string>();
  for (const ref of from) {
    if (CONTACT_KEY.test(ref)) keys.add(ref);
    else chats.add(((await call("chat.get", { chat: ref })) as { id: string }).id);
  }
  for (const ref of groups) groupIds.add(((await call("group.get", { group: ref })) as { id: string }).id);
  return new Allowlist(chats, keys, groupIds, peerOf);
}

/**
 * One agent turn (docs/CLI.md § Agent turns): a message a contact sent in a chat, or a group message that mentions
 * this profile. What the sender controls (the text, their name, a quoted snippet, a file's name) is under `untrusted`
 * and nowhere else: an agent reads it as data, never as its instructions. `seq` is the source event's, so `--cursor`
 * and `--since` work as for any event; `id` is stable for the message (dedupe on it).
 */
export interface AgentTurn extends GhostlyEvent {
  type: "agent.turn";
  source: "message.received" | "group.message";
  chat?: string;
  group?: string;
  /** A group's author (their key). */
  member?: string;
  /** What `send --reply` (or `group send --reply`) takes to answer it. */
  messageId: string;
  timestamp: number;
  untrusted: { text: string; name: string | null; replyTo?: { id: string; snippet: string }; file?: { id: string; name: string; size: number; mime: string; voice: boolean } };
}

interface TurnMessage { id: string; text: string; timestamp: number; nick: string | null; member?: string; mentioned?: boolean; replyTo?: { id: string; snippet: string }; file?: { id: string; name: string; size: number; mime: string; voice?: unknown } }

/** The turn an event starts, or null: only a contact's message, and a group message that mentions this profile. */
export function toTurn(event: GhostlyEvent): AgentTurn | null {
  const message = event.message as TurnMessage | undefined;
  if (!message || typeof message.text !== "string") return null;
  if (event.type === "message.received" && typeof event.chat === "string") return turn(event, "message.received", { chat: event.chat }, message);
  if (event.type === "group.message" && typeof event.group === "string" && message.mentioned) return turn(event, "group.message", { group: event.group, ...(message.member ? { member: message.member } : {}) }, message);
  return null;
}

function turn(event: GhostlyEvent, source: AgentTurn["source"], where: Pick<AgentTurn, "chat" | "group" | "member">, message: TurnMessage): AgentTurn {
  const file = message.file;
  return {
    seq: event.seq, id: `agent.turn:${event.id}`, type: "agent.turn", at: event.at, source, ...where, messageId: message.id, timestamp: message.timestamp,
    untrusted: {
      text: message.text, name: message.nick ?? null,
      ...(message.replyTo ? { replyTo: { id: message.replyTo.id, snippet: message.replyTo.snippet } } : {}),
      ...(file ? { file: { id: file.id, name: file.name, size: file.size, mime: file.mime, voice: !!file.voice } } : {}),
    },
  };
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
  // A new file each time (`wx`): a link left where the temporary file goes is removed, never written through.
  rmSync(path + ".tmp", { force: true });
  writeFileSync(path + ".tmp", String(seq) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(path + ".tmp", path);
}

export function matches(event: GhostlyEvent, types: readonly string[]): boolean {
  if (!types.length) return true;
  return types.some((type) => type.endsWith(".") || type.endsWith("*") ? event.type.startsWith(type.replace(/\*$/, "")) : event.type === type);
}

/** The environment a hook runs in: this one's, less the backup passphrase (a hook, and what it runs, never needs it). */
export function hookEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.GHOSTLY_BACKUP_PASSPHRASE;
  return rest;
}

/** Runs `command` through the shell with the event on stdin (never in its arguments); resolves with its exit code. */
function runExec(command: string, event: GhostlyEvent): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...hookEnv(process.env), GHOSTLY_EVENT_TYPE: event.type, GHOSTLY_EVENT_ID: event.id, GHOSTLY_EVENT_SEQ: String(event.seq) },
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

/**
 * A handler that takes events in order, one at a time. A step that throws (the output closed, the allowlist's lookup,
 * the cursor's disk) is said on stderr and passed: the cursor moves on and the next event is handled.
 */
export function eventHandler(options: ListenOptions): (event: GhostlyEvent) => void {
  const webhook = options.webhook ? checkWebhook(options.webhook) : null;
  let chain = Promise.resolve();
  return (event) => {
    const seq = event.seq, type = event.type;
    chain = chain.then(async () => {
      const skip = () => { if (options.cursor) writeCursor(options.cursor, event.seq); };
      if (!matches(event, options.types)) return skip();
      if (options.allow && !(await options.allow.allows(event))) return skip();
      if (options.turns) {
        const next = toTurn(event);
        if (!next) return skip();
        event = next;
      }
      if (options.print) options.write(JSON.stringify(event));
      if (options.exec) {
        const code = await runExec(options.exec, event);
        if (code !== 0) process.stderr.write(`ghostly: --exec exited ${code} on event ${event.seq} (${event.type})\n`);
      }
      if (webhook && !(await post(webhook, event))) process.stderr.write(`ghostly: the webhook did not take event ${event.seq} (${event.type})\n`);
      // A failed handler still moves the cursor: one poisonous event must not stop the stream. The failure is on stderr.
      if (options.cursor) writeCursor(options.cursor, event.seq);
    }).catch((error: unknown) => {
      try {
        process.stderr.write(`ghostly: event ${seq} (${type}) failed: ${error instanceof Error ? error.message : String(error)}\n`);
        if (options.cursor) writeCursor(options.cursor, seq);
      } catch { /* the next event moves the cursor */ }
    });
  };
}
