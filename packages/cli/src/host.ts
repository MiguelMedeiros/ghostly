import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { announceJoins } from "./announce";
import { reportAppFrames } from "./appEvents";
import { callApi, type ApiContext } from "./api";
import { CallManager } from "./calls/manager";
import { asCliError, CliError } from "./errors";
import { EventHub, type GhostlyEvent } from "./events";
import { resumeHolds } from "./holds";
import { ownFolder, privateFolder } from "./privateFolder";
import { acquireLock, type ProfilePaths } from "./profiles";
import { startRuntime, type RuntimeOptions } from "./runtime/engine";
import { flushCardUpdates } from "./statusCards";

/** The longest request line the daemon reads (WISP 1100 § Framing). */
export const MAX_LINE = 16 * 1024 * 1024;

/**
 * The most a connection may leave unread (answers and events the daemon wrote that its client has not taken): past
 * it, the connection ends. A `listen` stopped with Ctrl+Z, or a client that stops reading, kept every later event in
 * the daemon's memory until it read again (155 MB after 6,000 long texts); `listen` reconnects after the last seq it
 * took, and the journal still has the rest. A replay is the journal's size at most and does not count against it.
 */
export const MAX_UNREAD = 8 * 1024 * 1024;

/**
 * How many of a chat's newest messages the start reads to see whether the events are in step with its history: the
 * whole history of every chat and group, read at every start, took a daemon's start and its memory with every message
 * the profile ever stored (1 s and 70 MB at 100,000).
 */
export const BASELINE_NEWEST = 100;

export interface Host {
  ctx: ApiContext;
  close(): Promise<void>;
}

/**
 * Runs a profile in this process: takes its lock, starts the engine, and derives events from it. A daemon then
 * serves the socket (`serve`); a one-shot command calls the API directly and closes. A one-shot for one chat passes
 * `deferGroups`: the groups' sessions would spend the relays' budget its message needs.
 */
export async function openHost(paths: ProfilePaths, mode: ApiContext["mode"], version: string, options: RuntimeOptions = {}): Promise<Host> {
  const release = acquireLock(paths);
  let runtime;
  try {
    runtime = await startRuntime(paths, mode === "daemon" ? { ...options, logJoins: true } : options);
  } catch (error) {
    release();
    throw error;
  }
  const hub = new EventHub(paths.events);
  let calls!: CallManager;
  try {
    await hub.open();
    const node = runtime.server.node;
    const now = node.getState();
    // The histories read here are the attach's too: one that changes before the hub is attached is read again then.
    const mark = runtime.server.historyMark;
    const histories = new Map<string, readonly StoredMessage[]>(), newest = new Map<string, readonly StoredMessage[]>();
    const whole = (id: string) => (id.startsWith("group:") ? node.groupMessages({ groupId: id.slice(6) }) : node.getMessages(id));
    // A store that was closed holds every note the hub made, and a history the engine has not touched since is as it
    // was closed: its newest messages say whether the hub is in step with it. Otherwise the whole history is read.
    const closed = !runtime.store.recovered;
    for (const id of [...now.links.map((link) => link.id), ...now.groups.map((group) => `group:${group.id}`)]) {
      const page = closed && !runtime.server.historyChanged(id) ? await node.messagePage({ linkId: id, limit: BASELINE_NEWEST }) : null;
      if (page && !page.more) histories.set(id, page.messages);
      else if (page && hub.inStep(id, page.messages)) newest.set(id, page.messages);
      else histories.set(id, await whole(id));
    }
    hub.baseline(now, histories, { newest, whole });
    announceJoins(hub, node);
    // Calls (WISP 1100 § Calls): only a daemon answers and places them; a one-shot still reports one that rings.
    calls = new CallManager({ engine: node, emit: (type, id, fields) => hub.emit(type, id, fields), profileDir: paths.dir, answers: mode === "daemon" });
    const manager = calls;
    hub.onCallSignal((chat, signal) => manager.onSignal(chat, signal));
    reportAppFrames(hub, node, paths.dir);
    runtime.server.attach(hub.sink, { mark, ids: [...histories.keys(), ...newest.keys()] });
  } catch (error) {
    await runtime.close().catch(() => {});
    release();
    throw error;
  }
  const ctx: ApiContext = { runtime, hub, mode, version, calls };
  resumeHolds(ctx);
  let closing: Promise<void> | null = null;
  return {
    ctx,
    close: () => (closing ??= (async () => {
      // Every call is hung up, and every card update still waiting for its time sent, while the engine can still tell the contact.
      await Promise.all([calls.stopAll(), flushCardUpdates(ctx)]).catch(() => {});
      runtime.server.detach(hub.sink);
      await runtime.close().catch(() => {});
      release();
    })()),
  };
}

interface Request { id?: unknown; method?: unknown; params?: unknown }

/**
 * The local control API over the profile's Unix socket (0600 in the 0700 profile folder): one JSON object per line
 * each way. `events.subscribe` turns a connection into a stream of `{"event": …}` lines.
 */
export interface Served {
  server: Server;
  /** Stops listening and ends every connection (subscribers too: they reconnect to the next daemon). */
  close(): Promise<void>;
}

export async function serve(host: Host): Promise<Served> {
  const { ctx } = host;
  const path = ctx.runtime.paths.socket;
  // The folder is owner-only before the socket is in it: nobody else can reach the socket in the moment before its chmod.
  if (process.platform !== "win32") {
    if (dirname(path) !== ctx.runtime.paths.dir) privateFolder(dirname(path), "the daemon will not put its socket there");
    else ownFolder(ctx.runtime.paths.dir, "the daemon will not put its socket there");
  }
  // A socket file left by a daemon that died: the lock says nobody holds the profile, so it is stale.
  if (existsSync(path)) rmSync(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    connection(ctx, socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The socket file is made owner-only (the bind happens within listen), then chmod'ed below as well.
    const umask = ownerOnlyUmask();
    try { server.listen(path, () => { server.off("error", reject); resolve(); }); } finally { umask?.(); }
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  let closing: Promise<void> | null = null;
  return {
    server,
    close: () => (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.end();
      setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 500).unref();
    })),
  };
}

let guarded = false;

/**
 * A daemon says an error nobody caught (with its stack, on stderr: the daemon's log when detached) and keeps serving:
 * one request gone wrong must not take the profile offline. One-shot commands do not call this; they still fail loudly.
 *
 * `outputs`: what it writes to. A write there that fails (a pipe whose reader is gone: the process that started the
 * daemon died) is dropped, not an error nobody caught: saying it would be one more failed write, and the next, with
 * no turn left for anything else (a full core, and no stop on SIGTERM).
 */
export function keepServing(
  proc: Pick<NodeJS.Process, "on"> = process,
  write: (text: string) => void = (text) => { process.stderr.write(text); },
  outputs: Pick<NodeJS.WriteStream, "on">[] = proc === process ? [process.stdout, process.stderr] : [],
): void {
  if (proc === process) { if (guarded) return; guarded = true; }
  const log = (what: string) => (error: unknown) => {
    try { write(`ghostly: ${what}, the daemon keeps serving: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); } catch { /* stderr is gone */ }
  };
  for (const output of outputs) output.on("error", () => { /* nobody reads it any more */ });
  proc.on("unhandledRejection", log("unhandled rejection"));
  proc.on("uncaughtException", log("uncaught exception"));
}

/** Sets a 077 umask; the function it returns puts the old one back. Null where there is none (Windows, a worker). */
function ownerOnlyUmask(): (() => void) | null {
  if (process.platform === "win32") return null;
  try {
    const old = process.umask(0o077);
    return () => { process.umask(old); };
  } catch { return null; }
}

function connection(ctx: ApiContext, socket: Socket): void {
  const unsubscribes: (() => void)[] = [];
  // A replay raises the limit by what it wrote; once the client has read everything, it is MAX_UNREAD again.
  let limit = MAX_UNREAD;
  const unsubscribe = () => { for (const off of unsubscribes.splice(0)) off(); };
  // Ended, not destroyed: the client still reads whole lines up to the last one written, then the end.
  const write = (value: unknown, replayed = false) => {
    if (socket.destroyed || socket.writableEnded) return;
    if (!replayed && socket.writableLength > limit) { unsubscribe(); socket.end(); return; }
    socket.write(JSON.stringify(value) + "\n");
  };
  socket.on("drain", () => { limit = MAX_UNREAD; });
  socket.on("close", unsubscribe);
  socket.on("error", () => {});
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  // readline passes on its input's errors: a client that went away with lines still unread (ECONNRESET) is no error.
  lines.on("error", () => {});
  let buffered = 0;
  socket.on("data", (chunk) => { buffered += chunk.length; if (buffered > MAX_LINE) socket.destroy(); });
  lines.on("line", (line) => {
    buffered = 0;
    if (!line.trim()) return;
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { write({ id: null, error: new CliError("bad_request", "Not JSON").toJSON() }); return; }
    const id = typeof request.id === "number" || typeof request.id === "string" ? request.id : null;
    if (typeof request.method !== "string") { write({ id, error: new CliError("bad_request", "method is required").toJSON() }); return; }
    if (request.method === "events.subscribe") {
      // One stream per connection: a second would get every event again, and its replay would pass the bound once more.
      if (unsubscribes.length) { write({ id, error: new CliError("bad_request", "This connection is subscribed already: open another one for a new stream").toJSON() }); return; }
      const params = (request.params ?? {}) as { since?: unknown };
      const since = typeof params.since === "number" ? params.since : ctx.hub.lastSeq;
      // A journal that cannot be replayed is the answer, never a subscription that then says nothing.
      let replay: GhostlyEvent[];
      try { replay = ctx.hub.replay(since); } catch (error) { write({ id, error: asCliError(error).toJSON() }); return; }
      // Live events queue while the journal replays, so none falls between the two.
      const queued: GhostlyEvent[] = [];
      let replaying = true;
      unsubscribes.push(ctx.hub.onEvent((event) => { if (replaying) queued.push(event); else write({ event }); }));
      write({ id, result: { subscribed: true, lastSeq: ctx.hub.lastSeq } });
      let last = since;
      for (const event of replay) { write({ event }, true); last = event.seq; }
      limit = Math.max(limit, socket.writableLength + MAX_UNREAD);
      replaying = false;
      for (const event of queued) if (event.seq > last) write({ event });
      return;
    }
    void callApi(ctx, request.method, request.params ?? {}).then(
      (result) => write({ id, result: result ?? null }),
      (error) => write({ id, error: asCliError(error).toJSON() }),
    );
  });
}
