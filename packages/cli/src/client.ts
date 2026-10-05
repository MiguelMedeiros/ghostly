import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { CliError, type ErrorCode } from "./errors";
import type { GhostlyEvent } from "./events";
import { ownSocket } from "./privateFolder";

/**
 * A connection to a profile's daemon over its socket (WISP 1100 § Local control API). `null` from `connectDaemon`
 * means no daemon answers there: a one-shot command runs the profile itself.
 */
export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private eventListener: ((event: GhostlyEvent) => void) | null = null;
  private closedListener: (() => void) | null = null;

  constructor(private readonly socket: Socket) {
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      let message: { id?: number; result?: unknown; error?: { code: ErrorCode; message: string; details?: Record<string, unknown> }; event?: GhostlyEvent };
      try { message = JSON.parse(line); } catch { return; }
      if (message.event) { this.eventListener?.(message.event); return; }
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiting) return;
      this.pending.delete(message.id!);
      if (message.error) waiting.reject(new CliError(message.error.code, message.error.message, message.error.details));
      else waiting.resolve(message.result);
    });
    socket.on("close", () => {
      for (const waiting of this.pending.values()) waiting.reject(new CliError("unavailable", "The daemon went away"));
      this.pending.clear();
      this.closedListener?.();
    });
    socket.on("error", () => {});
  }

  call(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Events after `since` (replayed from the journal), then every new one, until the connection closes. */
  async subscribe(since: number | undefined, listener: (event: GhostlyEvent) => void, onClosed?: () => void): Promise<{ lastSeq: number }> {
    this.eventListener = listener;
    this.closedListener = onClosed ?? null;
    return this.call("events.subscribe", since === undefined ? {} : { since }) as Promise<{ lastSeq: number }>;
  }

  close(): void {
    this.socket.end();
  }
}

export function connectDaemon(path: string, timeoutMs = 2_000): Promise<DaemonClient | null> {
  // Someone else's socket (or a link) where the daemon's should be is no daemon of this profile's.
  if (!ownSocket(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(new DaemonClient(socket)); });
    socket.once("error", () => { clearTimeout(timer); resolve(null); });
  });
}
