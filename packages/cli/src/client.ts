import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { CliError, type ErrorCode } from "./errors";
import type { GhostlyEvent } from "./events";
import { daemonOfThisRelease, HELLO, newNonce, provesDaemon, provesGreeting, readDaemonSecret } from "./daemonProof";
import { ownSocket } from "./privateFolder";

/** The id of the hello on every connection: a string, so it is never one of the calls' numbers. */
const HELLO_ID = "hello";

/**
 * How long a client waits for the daemon's greeting before it asks who holds the profile: a daemon greets as it
 * accepts the connection, and one of an older release (before the greeting) never does. A daemon of this release
 * holding the profile (`daemonOfThisRelease`) is busy and is waited for, under each call's own deadline; anything
 * else is refused then. It used to refuse every late greeting, after 10 s: a daemon busy that long on one task (an
 * outbox backlog, 14 to 29 s) had every command and `listen` refused as an older release's, to be restarted.
 */
export const GREETING_MS = 2_000;

/** What a client needs of a profile to reach its daemon: the socket, and the folder the daemon's secret is in. */
export interface DaemonAddress { socket: string; dir: string }

/** The refusal of a listener that did not prove it is the profile's daemon (`isNotTheDaemon` tells it apart). */
function notTheDaemon(socket: string): CliError {
  return new CliError("refused", `What answers on ${socket} did not prove it is this profile's daemon, so nothing was sent to it. A daemon of an older release cannot: \`ghostly daemon restart\` starts this one's`, { reason: "not-the-daemon" });
}

/**
 * A call the daemon read and never answered, because it stopped (a restart, a crash): what was asked may be done, so
 * it is no plain failure a bot tries again (a send went twice). A daemon that stops answers its waits first (`serve`);
 * this is for the calls it could not.
 */
function stoppedUnanswered(method: string): CliError {
  return new CliError("timeout", `The daemon stopped before it answered ${method}, which may be done: check (\`ghostly chat history\` for a message) before you try again`, { method, reason: "daemon-stopped" });
}

export function isNotTheDaemon(error: unknown): boolean {
  return error instanceof CliError && error.code === "refused" && error.details?.reason === "not-the-daemon";
}

/**
 * A connection to a profile's daemon over its socket (WISP 1100 § Local control API). `null` from `connectDaemon`
 * means no daemon answers there: a one-shot command runs the profile itself.
 *
 * The client writes nothing on it until the daemon's greeting, its first line, proves the other end read the
 * profile's daemon secret and holds the profile's lock (`provesGreeting`): a listener that cannot prove it has read
 * nothing from this client, so it cannot impersonate it either (`daemonProof.ts`). Then the first line written is a
 * `daemon.hello`, and no call is written until its answer proves the same over the client's own nonce. Until then
 * every call waits, under its own deadline, and a listener that does not prove both gets every call refused
 * (`refused`, `isNotTheDaemon`). Nothing it writes before that is read either.
 */
export class DaemonClient {
  private nextId = 1;
  /** `written`: the call is on the socket, so the daemon may have acted on it. */
  private readonly pending = new Map<number, { method: string; written: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** This client closed the connection: what was still unanswered is its own doing, not a daemon that stopped. */
  private leaving = false;
  private eventListener: ((event: GhostlyEvent) => void) | null = null;
  private closedListener: (() => void) | null = null;
  /** While paused: the events of the chunk already read, given to the listener on resume. */
  private held: GhostlyEvent[] | null = null;
  private greeted = false;
  private verified = false;
  private refusal: CliError | null = null;
  private readonly ready: Promise<void>;
  private settle!: { resolve: () => void; reject: (error: CliError) => void };

  constructor(private readonly socket: Socket, private readonly address: DaemonAddress, greetingMs = GREETING_MS) {
    this.ready = new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.ready.catch(() => {});
    const nonce = newNonce();
    // Nothing is written until the greeting either way: a busy daemon only keeps the calls waiting.
    const waitedTooLong = setTimeout(() => { if (!this.greeted && !this.refusal && !daemonOfThisRelease(this.address.dir)) this.refuse(); }, greetingMs);
    waitedTooLong.unref?.();
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    // readline passes on its input's errors: a daemon that went away with this client's lines unread (ECONNRESET) ended
    // the command on an unhandled 'error' instead of the close below (unavailable).
    lines.on("error", () => {});
    lines.on("line", (line) => {
      let message: { id?: number | string; result?: unknown; error?: { code: ErrorCode; message: string; details?: Record<string, unknown> }; event?: GhostlyEvent };
      // A first line that is not even JSON is no greeting: refused as one that does not prove itself.
      try { message = JSON.parse(line); } catch { if (!this.greeted && !this.refusal) this.refuse(); return; }
      if (this.refusal) return;
      if (!this.greeted) {
        clearTimeout(waitedTooLong);
        // The secret is read once a listener spoke: the daemon wrote it before it listened.
        const secret = readDaemonSecret(this.address.dir);
        if (!secret || !provesGreeting(secret, this.address.dir, message)) { this.refuse(); return; }
        this.greeted = true;
        // A client closed before the greeting came (a start's readiness probe) has nothing to say.
        if (socket.writableEnded || socket.destroyed) return;
        socket.write(JSON.stringify({ id: HELLO_ID, method: HELLO, params: { nonce } }) + "\n");
        return;
      }
      if (!this.verified) {
        if (message?.id !== HELLO_ID) return;
        // The secret is read once a listener answered: the daemon wrote it before it listened.
        const secret = readDaemonSecret(this.address.dir);
        if (!message.error && secret && provesDaemon(secret, nonce, message.result)) { this.verified = true; this.settle.resolve(); return; }
        this.refuse();
        return;
      }
      if (message.event) { if (this.held) this.held.push(message.event); else this.eventListener?.(message.event); return; }
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiting) return;
      this.pending.delete(message.id as number);
      if (message.error) waiting.reject(new CliError(message.error.code, message.error.message, message.error.details));
      else waiting.resolve(message.result);
    });
    socket.on("close", () => {
      clearTimeout(waitedTooLong);
      const why = this.refusal ?? new CliError("unavailable", "The daemon went away");
      if (!this.verified) this.settle.reject(why);
      for (const waiting of this.pending.values()) waiting.reject(waiting.written && !this.refusal && !this.leaving ? stoppedUnanswered(waiting.method) : why);
      this.pending.clear();
      this.closedListener?.();
    });
    socket.on("error", () => {});
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
        method, written: false,
        resolve: (value: unknown) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { if (timer) clearTimeout(timer); reject(error); },
      };
      this.pending.set(id, settle);
      // Written once the daemon proved itself, in the order the calls were made; a refusal ends each instead.
      this.ready.then(
        () => {
          if (!this.pending.has(id) || this.socket.destroyed) return;
          this.socket.write(JSON.stringify({ id, method, params }) + "\n");
          settle.written = true;
        },
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

  /**
   * Stops reading: what the daemon sends waits in the connection (and past its bound the daemon ends it), and no
   * event reaches the listener until `resume`.
   */
  pause(): void {
    if (this.held) return;
    this.held = [];
    this.socket.pause();
  }

  /** Gives the listener the events held, then reads again; a listener that pauses again keeps the rest held. */
  resume(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (let i = 0; i < held.length; i++) {
      this.eventListener?.(held[i]);
      if (this.held) { (this.held as GhostlyEvent[]).unshift(...held.slice(i + 1)); return; }
    }
    this.socket.resume();
  }

  close(): void {
    this.leaving = true;
    this.socket.end();
  }

  /** Closes at once: what the daemon still sends is not read. */
  destroy(): void {
    this.leaving = true;
    this.socket.destroy();
  }
}

/**
 * `timeoutMs` bounds the connect only; `greetingMs`, the wait for the daemon's greeting (above). The client it gives
 * has written nothing yet; whether the listener is the daemon is known at the first call.
 */
export function connectDaemon(address: DaemonAddress, timeoutMs = 2_000, { greetingMs = GREETING_MS }: { greetingMs?: number } = {}): Promise<DaemonClient | null> {
  const path = address.socket;
  // Someone else's socket (or a link) where the daemon's should be is no daemon of this profile's.
  if (!ownSocket(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(new DaemonClient(socket, address, greetingMs)); });
    socket.once("error", () => { clearTimeout(timer); resolve(null); });
  });
}
