import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONTACT_KEY } from "./apiKit";
import { connectDaemon, type DaemonClient } from "./client";
import { CliError, localFileError } from "./errors";
import type { GhostlyEvent } from "./events";
import { turnRef } from "./turnRefs";

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
  /** `false` (as `stream.write` says it): the output wants a drain, and the next event waits for `drained`. */
  write: (line: string) => unknown;
  /** Resolves once the output takes more (its 'drain'), or is gone. */
  drained?: () => Promise<void>;
  /** `--from` and `--group`: events of anyone else stop here (they stay in the chat). */
  allow?: Allowlist;
  /** `--turns`: only agent turns, as `agent.turn` events. */
  turns?: boolean;
  /** The first wait before a webhook is tried again (500 ms), doubled each time up to a minute. */
  retryMs?: number;
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
 * this profile. What the sender controls (the text, their name, a quoted snippet, a file's name, the id their message
 * is stored under) is under `untrusted` and nowhere else: an agent reads it as data, never as its instructions. `seq` is
 * the source event's, so `--cursor` and `--since` work as for any event; `id` is stable for the message (dedupe on it).
 */
export interface AgentTurn extends GhostlyEvent {
  type: "agent.turn";
  source: "message.received" | "group.message" | "group.mentioned";
  chat?: string;
  group?: string;
  /** A group's author (their key). */
  member?: string;
  /** What `send --reply` (or `group send --reply`) takes to answer it: an id made here (`turnRef`), never the sender's. */
  messageId: string;
  timestamp: number;
  /**
   * The message pressed a button of a question this profile sent (WISP 406 · Message Buttons), as this side's engine
   * matched it: the question's id, the button's id and its label, all this profile's own words.
   */
  press?: { messageId: string; button: string; label: string; inferred?: true };
  untrusted: { text: string; name: string | null; messageId: string; replyTo?: { id: string; snippet: string }; file?: { id: string; name: string; size: number; mime: string; voice: boolean } };
}

interface TurnMessage { id: string; text: string; timestamp: number; nick: string | null; member?: string; mentioned?: boolean; replyTo?: { id: string; snippet: string }; press?: AgentTurn["press"]; file?: { id: string; name: string; size: number; mime: string; voice?: unknown } }

/** The turn an event starts, or null: only a contact's message, and a group message that mentions this profile. */
export function toTurn(event: GhostlyEvent): AgentTurn | null {
  const message = event.message as TurnMessage | undefined;
  if (!message || typeof message.text !== "string") return null;
  if (event.type === "message.received" && typeof event.chat === "string") return turn(event, "message.received", { chat: event.chat }, message);
  if (event.type === "group.message" && typeof event.group === "string" && message.mentioned) return turn(event, "group.message", { group: event.group, ...(message.member ? { member: message.member } : {}) }, message);
  // A mention learned after its message was reported (its `group.message` named nobody): the turn it did not start then.
  if (event.type === "group.mentioned" && typeof event.group === "string" && message.mentioned) return turn(event, "group.mentioned", { group: event.group, ...(message.member ? { member: message.member } : {}) }, message);
  return null;
}

function turn(event: GhostlyEvent, source: AgentTurn["source"], where: Pick<AgentTurn, "chat" | "group" | "member">, message: TurnMessage): AgentTurn {
  const file = message.file;
  // The source event's id ends in the stored id, the sender's: this one is made of the same parts with the id made here.
  const place = where.chat ?? where.group ?? "", messageId = turnRef(place, message.id);
  return {
    seq: event.seq, id: `agent.turn:${source}:${place}:${messageId}`, type: "agent.turn", at: event.at, source, ...where, messageId, timestamp: message.timestamp,
    ...(message.press ? { press: message.press } : {}),
    untrusted: {
      text: message.text, name: message.nick ?? null, messageId: message.id,
      ...(message.replyTo ? { replyTo: { id: message.replyTo.id, snippet: message.replyTo.snippet } } : {}),
      ...(file ? { file: { id: file.id, name: file.name, size: file.size, mime: file.mime, voice: !!file.voice } } : {}),
    },
  };
}

/** Only loopback: events carry message text, and a webhook is a local bridge (WISP 1100 § Security). */
export function checkWebhook(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError("usage", `Not a URL: ${url}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new CliError("usage", "The webhook must be http:// or https://");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new CliError("usage", "The webhook must be on this machine (127.0.0.1, localhost or [::1])");
  return parsed;
}

export function readCursor(path: string | undefined): number | undefined {
  if (!path || !existsSync(path)) return undefined;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw localFileError(error, path) ?? error; }
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Whether a cursor can be kept at `path`, asked before anything starts: its folder is there and takes a file. Before, a
 * folder that was not there was found at the first event: the listener ran, said "event N failed: ENOENT" for each one
 * and never wrote the cursor, so the next start began at the journal's end and skipped what came while it was down.
 * Throws what the file system says (`asCliError` names the path and the code: not_found, refused).
 */
export function checkCursor(path: string | undefined): void {
  if (!path) return;
  const folder = dirname(resolve(path));
  if (!statSync(folder).isDirectory()) throw new CliError("not_found", `No such file or folder: ${folder}`);
  accessSync(folder, constants.W_OK | constants.X_OK);
}

function writeCursor(path: string, seq: number): void {
  // A new file each time (`wx`): a link left where the temporary file goes is removed, never written through.
  rmSync(path + ".tmp", { force: true });
  writeFileSync(path + ".tmp", String(seq) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(path + ".tmp", path);
}

/**
 * `--type`: one type (`message.received`, exactly: `group.message` is not its `group.message.edited`), or a family, a
 * word with no "." (`message`, `chat`) or one ending in "." or "*" (`group.typing.`). Before, a family needed its "." and
 * `--type chat` let nothing through. A family is whole words: `message` is not `messages.x`.
 */
export function matches(event: GhostlyEvent, types: readonly string[]): boolean {
  if (!types.length) return true;
  return types.some((type) => {
    if (type === "*") return true;
    const family = /[.*]$/.test(type) ? type.replace(/\.?\*$/, "").replace(/\.$/, "") : type.includes(".") ? null : type;
    return event.type === type || (family !== null && event.type.startsWith(family + "."));
  });
}

/**
 * Every event type a daemon of this version emits (events.ts, appEvents.ts, holds.ts, identities.ts, calls/manager.ts,
 * main.ts) and `--turns`' own. A test reads them back from the source: a type added there and not here fails it.
 */
export const EVENT_TYPES: readonly string[] = [
  "agent.turn",
  "app.closed", "app.message", "app.opened",
  "button.pressed",
  "call.connected", "call.ended", "call.incoming", "call.outgoing", "call.resumed", "call.stalled",
  "chat.announced", "chat.connection", "chat.created", "chat.held", "chat.joined", "chat.pairing", "chat.pinned", "chat.released", "chat.removed", "chat.renamed",
  "daemon.started",
  "events.gap",
  "file.done", "file.failed", "file.offered", "file.stage",
  "group.created", "group.deleted", "group.event", "group.members", "group.mentioned", "group.message", "group.message.edited", "group.pinned", "group.reaction",
  "group.removed", "group.sent", "group.status", "group.typing.started", "group.typing.stopped",
  "identity.approval", "identity.progress", "identity.received", "identity.status",
  "message.deleted", "message.delivery", "message.edited", "message.reaction", "message.received", "message.sent",
  "payment.created", "payment.updated",
  "typing.started", "typing.stopped",
];

/** The families, the first word of each type: what a `--type` must start with. */
export const EVENT_FAMILIES: readonly string[] = [...new Set(EVENT_TYPES.map((type) => type.split(".")[0]))];

/**
 * Checks each `--type` before anything starts. Before, `--type bogus` (or a typo such as `message.recieved`) was taken
 * and the listener stayed silent for good. A first word that is no family is a usage error naming them; a type, or a
 * family below the first word, that no event has is said on stderr (`warn`) and kept: a newer daemon may emit it.
 */
export function checkTypes(types: readonly string[], warn: (line: string) => void): void {
  for (const type of types) {
    if (type === "*") continue;
    const family = type.split(/[.*]/)[0];
    if (!EVENT_FAMILIES.includes(family)) throw new CliError("usage", `No event is of type ${type}: --type takes a type, or a family (${EVENT_FAMILIES.join(", ")})`);
    if (!EVENT_TYPES.some((known) => matches({ seq: 0, id: "", type: known, at: 0 }, [type]))) warn(`ghostly: no event is of type ${type}; the ${family} family has ${EVENT_TYPES.filter((known) => known.startsWith(family + ".")).join(", ")}`);
  }
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

/** The longest wait between two tries of a webhook that is not answering. */
const RETRY_MAX_MS = 60_000;

/**
 * Posts one event; resolves true once the bridge took it, false when it refused it (a 4xx or a redirect, three times).
 * A bridge that is not there (refused connection, timeout, 5xx, 408, 429) has not handled the event: it is tried again,
 * waiting up to a minute between tries, for as long as it takes, so the cursor never moves past it. Before, three tries
 * in 3.5 s and the cursor moved on: a bridge restarting for longer lost every event of the time it was down, for good.
 */
async function post(url: URL, event: GhostlyEvent, retryMs: number): Promise<boolean> {
  let wait = retryMs, holding = false;
  for (let attempt = 0; ; attempt++) {
    let down = true;
    try {
      // A redirect is not followed: it would post the event to wherever it points, off this machine too.
      const response = await fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-ghostly-event": event.type, "x-ghostly-seq": String(event.seq) }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
      void response.body?.cancel().catch(() => {});
      if (response.ok) {
        if (holding) process.stderr.write(`ghostly: the webhook at ${url.href} answers again: event ${event.seq} taken\n`);
        return true;
      }
      down = response.status >= 500 || response.status === 408 || response.status === 429;
    } catch { /* not there: tried again */ }
    if (!down && attempt >= 2) return false;
    if (down && attempt >= 2 && !holding) {
      holding = true;
      process.stderr.write(`ghostly: the webhook at ${url.href} is not answering: holding event ${event.seq} (${event.type}) until it does\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  }
}

/** Events given to a handler and not handled yet: what `listen` holds in memory. */
export interface EventHandler {
  (event: GhostlyEvent): void;
  /** How many events are given and not handled yet. */
  behind(): number;
  /** Resolves when every event given is handled. */
  idle(): Promise<void>;
}

/**
 * A handler that takes events in order, one at a time. A step that throws (the output closed, the allowlist's lookup,
 * the cursor's disk) is said on stderr and passed: the cursor moves on and the next event is handled.
 */
export function eventHandler(options: ListenOptions): EventHandler {
  const webhook = options.webhook ? checkWebhook(options.webhook) : null;
  let chain = Promise.resolve();
  let behind = 0;
  const handle = (event: GhostlyEvent) => {
    const seq = event.seq, type = event.type;
    behind++;
    chain = chain.then(async () => {
      const skip = () => { if (options.cursor) writeCursor(options.cursor, event.seq); };
      if (!matches(event, options.types)) return skip();
      if (options.allow && !(await options.allow.allows(event))) return skip();
      if (options.turns) {
        const next = toTurn(event);
        if (!next) return skip();
        event = next;
      }
      const full = options.print && options.write(JSON.stringify(event)) === false;
      if (options.exec) {
        const code = await runExec(options.exec, event);
        if (code !== 0) process.stderr.write(`ghostly: --exec exited ${code} on event ${event.seq} (${event.type})\n`);
      }
      if (webhook && !(await post(webhook, event, options.retryMs ?? 500))) process.stderr.write(`ghostly: the webhook did not take event ${event.seq} (${event.type})\n`);
      // An output whose reader stopped holds the next event here, not one more line in its buffer per event.
      if (full) await options.drained?.();
      // A failed hook (an --exec exiting non-zero, an event the webhook refused) still moves the cursor: one poisonous
      // event must not stop the stream. The failure is on stderr. A webhook not answering never gets here (`post`).
      if (options.cursor) writeCursor(options.cursor, event.seq);
    }).catch((error: unknown) => {
      try {
        process.stderr.write(`ghostly: event ${seq} (${type}) failed: ${error instanceof Error ? error.message : String(error)}\n`);
        if (options.cursor) writeCursor(options.cursor, seq);
      } catch { /* the next event moves the cursor */ }
    }).finally(() => { behind--; });
  };
  return Object.assign(handle, { behind: () => behind, idle: () => chain });
}

/** Events a listener takes ahead of its output and hooks before it stops taking more (a few MB at most). */
export const MAX_BEHIND = 1_000;

/**
 * Bounds what a listener holds when its output or hooks fall behind (a stdout reader that hung, a slow --exec): past
 * `MAX_BEHIND` events not handled it stops taking events (`pause`: the subscription stops reading) and drops what still
 * arrives; once every event taken is handled, `resume` opens it again after the last one taken. The daemon's journal
 * keeps what came meanwhile (and says `events.gap` past what it keeps), so a consumer that hangs for a day does not
 * grow the listener by the day's traffic.
 */
export class Feed {
  private held = false;

  /** `since`: the last event taken, where a new subscription starts. */
  constructor(private readonly handle: EventHandler, public since: number | undefined, private readonly pause: () => void, private readonly resume: (since: number | undefined) => void) {}

  get paused(): boolean { return this.held; }

  readonly take = (event: GhostlyEvent): void => {
    if (this.held) return;
    this.since = event.seq;
    this.handle(event);
    if (this.handle.behind() < MAX_BEHIND) return;
    this.held = true;
    this.pause();
    void this.handle.idle().then(() => { this.held = false; this.resume(this.since); });
  };
}

/**
 * Follows a daemon's events into `handle` until `close`; a daemon that restarts is picked up again after the last event
 * seen. A feed that falls behind stops reading the connection, not closes it: what the daemon sent meanwhile (a replay
 * written whole) is read on resume, so a catch-up reads the journal once, not once per pause. A connection the daemon
 * ended meanwhile (past what it lets a client leave unread) is opened again after the last event taken.
 * `subscribed`: the first subscription's answer (a journal that cannot be replayed rejects it).
 */
export function followDaemon(socket: string, client: DaemonClient, handle: EventHandler, since: number | undefined): { subscribed: Promise<unknown>; close(): void } {
  let current: DaemonClient | null = client;
  const reconnect = (wait: number) => void (async () => {
    while (!current && !feed.paused) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = 1000;
      if (current || feed.paused) return;
      const next = await connectDaemon(socket, 1000);
      if (next) { current = next; await follow(next).catch(() => { if (current === next) current = null; }); }
    }
  })();
  const feed = new Feed(handle, since, () => current?.pause(), () => { if (current) current.resume(); else reconnect(0); });
  const follow = (c: DaemonClient) => c.subscribe(feed.since, feed.take, () => {
    if (current !== c) return;
    current = null;
    reconnect(1000);
  });
  return { subscribed: follow(client), close: () => current?.close() };
}
