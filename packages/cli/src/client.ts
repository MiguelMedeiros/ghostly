import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { CliError, type ErrorCode } from "./errors";
import type { GhostlyEvent } from "./events";
import { HELLO, newNonce, provesDaemon, readDaemonSecret } from "./daemonProof";
import { ownSocket } from "./privateFolder";

/** The id of the hello on every connection: a string, so it is never one of the calls' numbers. */
const HELLO_ID = "hello";

/** What a client needs of a profile to reach its daemon: the socket, and the folder the daemon's secret is in. */
export interface DaemonAddress { socket: string; dir: string }

/** The refusal of a listener that did not prove it is the profile's daemon (`isNotTheDaemon` tells it apart). */
function notTheDaemon(socket: string): CliError {
  return new CliError("refused", `What answers on ${socket} did not prove it is this profile's daemon, so nothing was sent to it. A daemon of an older release cannot: \`ghostly daemon restart\` starts this one's`, { reason: "not-the-daemon" });
}

export function isNotTheDaemon(error: unknown): boolean {
  return error instanceof CliError && error.code === "refused" && error.details?.reason === "not-the-daemon";
}

/**
 * A connection to a profile's daemon over its socket (WISP 1100 § Local control API). `null` from `connectDaemon`
 * means no daemon answers there: a one-shot command runs the profile itself.
 *
 * The first line on it is a `daemon.hello`, and no call is written until its answer proves the other end read the
 * profile's daemon secret (`daemonProof.ts`): until then every call waits, under its own deadline, and a listener
 * that does not prove it gets every call refused (`refused`, `isNotTheDaemon`) having read nothing but the hello.
 * Nothing it writes before that is read either.
 */
export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private eventListener: ((event: GhostlyEvent) => void) | null = null;
  private closedListener: (() => void) | null = null;
  private verified = false;
  private refusal: CliError | null = null;
  private readonly ready: Promise<void>;
  private settle!: { resolve: () => void; reject: (error: CliError) => void };

  constructor(private readonly socket: Socket, private readonly address: DaemonAddress) {
    this.ready = new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.ready.catch(() => {});
    const nonce = newNonce();
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      let message: { id?: number | string; result?: unknown; error?: { code: ErrorCode; message: string; details?: Record<string, unknown> }; event?: GhostlyEvent };
      try { message = JSON.parse(line); } catch { return; }
      if (!this.verified) {
        if (this.refusal || message?.id !== HELLO_ID) return;
        // The secret is read once a listener answered: the daemon wrote it before it listened.
        const secret = readDaemonSecret(this.address.dir);
        if (!message.error && secret && provesDaemon(secret, nonce, message.result)) { this.verified = true; this.settle.resolve(); return; }
        this.refuse();
        return;
      }
      if (message.event) { this.eventListener?.(message.event); return; }
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiting) return;
      this.pending.delete(message.id as number);
      if (message.error) waiting.reject(new CliError(message.error.code, message.error.message, message.error.details));
      else waiting.resolve(message.result);
    });
    socket.on("close", () => {
      const why = this.refusal ?? new CliError("unavailable", "The daemon went away");
      if (!this.verified) this.settle.reject(why);
      for (const waiting of this.pending.values()) waiting.reject(why);
      this.pending.clear();
      this.closedListener?.();
    });
    socket.on("error", () => {});
    socket.write(JSON.stringify({ id: HELLO_ID, method: HELLO, params: { nonce } }) + "\n");
  }

  private refuse(): void {
    this.refusal = notTheDaemon(this.address.socket);
    this.settle.reject(this.refusal);
    this.socket.destroy();
  }

  /**
   * `timeoutMs`: give up (code `timeout`, exit 4) when the daemon has not answered by then; without it the call waits
   * for as long as the connection holds. A call that timed out closes the connection: its answer, if one ever comes,
   * is of no use, and the process leaves once nothing else keeps it (not every caller reaches `exit`).
   */
  call(method: string, params: unknown = {}, { timeoutMs }: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(this.refusal ?? new CliError("unavailable", "The daemon went away"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new CliError("timeout", `The daemon did not answer ${method} in ${timeoutMs / 1000} s: \`ghostly daemon restart\` starts a fresh one`, { method }));
          this.destroy();
        }, timeoutMs);
        timer.unref?.();
      }
      const settle = {
        resolve: (value: unknown) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { if (timer) clearTimeout(timer); reject(error); },
      };
      this.pending.set(id, settle);
      // Written once the daemon proved itself, in the order the calls were made; a refusal ends each instead.
      this.ready.then(
        () => { if (this.pending.has(id) && !this.socket.destroyed) this.socket.write(JSON.stringify({ id, method, params }) + "\n"); },
        (error: CliError) => { if (this.pending.delete(id)) settle.reject(error); },
      );
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

  /** Closes at once: what the daemon still sends is not read. */
  destroy(): void {
    this.socket.destroy();
  }
}

/**
 * `timeoutMs` bounds the connect only. The client it gives has sent its hello; whether the listener is the daemon is
 * known at the first call (above).
 */
export function connectDaemon(address: DaemonAddress, timeoutMs = 2_000): Promise<DaemonClient | null> {
  const path = address.socket;
  // Someone else's socket (or a link) where the daemon's should be is no daemon of this profile's.
  if (!ownSocket(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(new DaemonClient(socket, address)); });
    socket.once("error", () => { clearTimeout(timer); resolve(null); });
  });
}
