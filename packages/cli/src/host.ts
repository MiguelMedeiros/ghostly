import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "./api";
import { asCliError, CliError } from "./errors";
import { EventHub, type GhostlyEvent } from "./events";
import { acquireLock, type ProfilePaths } from "./profiles";
import { startRuntime } from "./runtime/engine";

/** The longest request line the daemon reads (WISP 11xx § Framing). */
export const MAX_LINE = 16 * 1024 * 1024;

export interface Host {
  ctx: ApiContext;
  close(): Promise<void>;
}

/**
 * Runs a profile in this process: takes its lock, starts the engine, and derives events from it. A daemon then
 * serves the socket (`serve`); a one-shot command calls the API directly and closes.
 */
export async function openHost(paths: ProfilePaths, mode: ApiContext["mode"], version: string): Promise<Host> {
  const release = acquireLock(paths);
  let runtime;
  try {
    runtime = await startRuntime(paths);
  } catch (error) {
    release();
    throw error;
  }
  const hub = new EventHub(paths.events);
  try {
    await hub.open();
    const node = runtime.server.node;
    const now = node.getState();
    const histories = new Map<string, readonly StoredMessage[]>();
    for (const link of now.links) histories.set(link.id, await node.getMessages(link.id));
    for (const group of now.groups) histories.set(`group:${group.id}`, await node.groupMessages({ groupId: group.id }));
    hub.baseline(now, histories);
    runtime.server.attach(hub.sink);
  } catch (error) {
    await runtime.close().catch(() => {});
    release();
    throw error;
  }
  const ctx: ApiContext = { runtime, hub, mode, version };
  let closing: Promise<void> | null = null;
  return {
    ctx,
    close: () => (closing ??= (async () => {
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
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
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

function connection(ctx: ApiContext, socket: Socket): void {
  const unsubscribes: (() => void)[] = [];
  const write = (value: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
  socket.on("close", () => { for (const off of unsubscribes) off(); });
  socket.on("error", () => {});
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
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
      const params = (request.params ?? {}) as { since?: unknown };
      const since = typeof params.since === "number" ? params.since : ctx.hub.lastSeq;
      // Live events queue while the journal replays, so none falls between the two.
      const queued: GhostlyEvent[] = [];
      let replaying = true;
      unsubscribes.push(ctx.hub.onEvent((event) => { if (replaying) queued.push(event); else write({ event }); }));
      write({ id, result: { subscribed: true, lastSeq: ctx.hub.lastSeq } });
      let last = since;
      for (const event of ctx.hub.replay(since)) { write({ event }); last = event.seq; }
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
