import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CliError } from "../errors";
import { dropRuntimeFolder, privateFolder, runtimePath } from "../privateFolder";
import { bytesToMs, frameBytes, type CallRate, type PlaybackQueue } from "./pcm";

/**
 * A call's audio socket (WISP 1100 § Calls): `<profile>/calls/<call>.sock`, 0600, in a folder only the owner may
 * open. When that path is too long for a Unix socket: `ghostly-calls-<hash of the profile>/<call>.sock` in the user's
 * runtime folder (`runtimePath`), a folder of the owner's, 0700, checked as such before use. A named pipe on Windows.
 * With a shared folder (`callSocketDir`): `<that folder>/<call>.sock`.
 */
export function audioSocketPath(profileDir: string, callId: string, sharedDir?: string): string {
  if (sharedDir && process.platform !== "win32") return join(sharedDir, `${callId}.sock`);
  const inside = join(profileDir, "calls", `${callId}.sock`);
  if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-call-${createHash("sha256").update(inside).digest("hex").slice(0, 24)}`;
  if (Buffer.byteLength(inside) <= 100) return inside;
  return runtimePath("ghostly-calls", profileDir, `${callId}.sock`);
}

/**
 * GHOSTLY_CALL_SOCKET_DIR: a folder the machine made for its daemon's call sockets, shared with the group of another
 * user that runs the program on the audio (a Ghostly OS node's assistant). Unset: the profile's own folder. Refused
 * (`usage`) when it is not an absolute path, is too long for a socket's, or on Windows, whose calls are named pipes.
 */
export function callSocketDir(value = process.env.GHOSTLY_CALL_SOCKET_DIR): string | undefined {
  if (value === undefined) return undefined;
  if (process.platform === "win32") throw new CliError("usage", "GHOSTLY_CALL_SOCKET_DIR is for Linux and macOS: on Windows a call's audio is a named pipe");
  if (!value.trim() || !isAbsolute(value)) throw new CliError("usage", "GHOSTLY_CALL_SOCKET_DIR takes an absolute path: the folder for the calls' audio sockets");
  const dir = resolve(value);
  if (Buffer.byteLength(join(dir, `${"0".repeat(12)}.sock`)) > 100) throw new CliError("usage", `GHOSTLY_CALL_SOCKET_DIR is too long for a socket's path (${dir}): choose a folder of at most 82 bytes`);
  return dir;
}

/**
 * The shared folder (`callSocketDir`), checked before a socket goes in it: the machine made it, so it is not made here.
 * Refused when it is missing, a link, someone else's, or when anyone else may write it (and so replace a socket) or
 * anyone outside its group may enter it: 0750, its group the other user's (setgid, so the sockets take that group).
 * Refused too on Linux when its group is not this user's own and it is not setgid: a socket there takes this user's
 * group, not the folder's, and the other user's program could never open one.
 */
export function sharedFolder(path: string): void {
  const what = "calls will not put their audio there";
  let info;
  try { info = lstatSync(path); } catch { throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) is not there: ${what}. Make it a folder of this user's, 0750 with the group that reads the audio (chmod 2750)`); }
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) is not a folder of this user's: ${what}`);
  if ((info.mode & 0o027) !== 0) throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) may be written by others or entered by anyone outside its group: ${what}. Run \`chmod 2750 ${path}\`, then try again`);
  if (process.platform === "linux" && process.getegid && info.gid !== process.getegid() && (info.mode & 0o2000) === 0) throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) is not setgid: a call's socket there would take this user's group, not the folder's, and its group could not open it. Run \`chmod 2750 ${path}\`, then try again`);
}

/** A call's socket's name: its call id, 12 hex digits. */
const CALL_SOCKET = /^[0-9a-f]{12}\.sock$/;

/**
 * Removes the call sockets a daemon that died during a call left in this profile's folder (`audioSocketPath`; call
 * ids are 12 hex digits), or in the shared folder: no call outlives its daemon. A folder that is a link or someone
 * else's is left alone, and so is anything else in it: the shared folder is the machine's, not Ghostly's alone. There a
 * socket goes only once nobody answers on it (`removeIfDead`): two profiles' daemons may share the folder, and the
 * other one's call is live.
 */
export function clearAudioSockets(profileDir: string, sharedDir?: string): void {
  if (process.platform === "win32") return;
  const folder = dirname(audioSocketPath(profileDir, "0".repeat(12), sharedDir));
  try {
    const info = lstatSync(folder);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!CALL_SOCKET.test(entry.name) || entry.isDirectory()) continue;
      if (sharedDir && entry.isSocket()) removeIfDead(join(folder, entry.name));
      else rmSync(join(folder, entry.name), { force: true });
    }
  } catch {
    // No folder yet, or one it cannot read: nothing to clear.
  }
}

/**
 * Removes a shared folder's call socket once a connection to it is refused: its daemon is gone. A live one is another
 * daemon's call, and the connection (which sends no token) replaces nobody there and is closed at once.
 */
function removeIfDead(path: string): void {
  const probe = connect(path);
  probe.once("connect", () => probe.destroy());
  probe.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ECONNREFUSED") return;
    try { rmSync(path, { force: true }); } catch { /* Left for the next start. */ }
  });
}

/**
 * The socket's handlers for a call's queue: what the program writes is queued, and a program that takes the socket
 * (the first, or one that replaces the last) starts on a queue of its own (`PlaybackQueue.newWriter`): the last
 * one's leftover, half a sample included, would otherwise shift all of its audio by a byte.
 */
export function feedQueue(queue: PlaybackQueue): { onAudio(chunk: Buffer): void; onClient(connected: boolean): void } {
  return {
    onAudio: (chunk) => { queue.push(chunk); },
    onClient: (connected) => { if (connected) queue.newWriter(); },
  };
}

/**
 * How far a program may fall behind reading the call's audio before frames are dropped for it, what the kernel holds
 * for it included (`kernelShare`): checked against Node's `writableLength` alone, the kernel's buffer came on top,
 * seconds more on Linux. Where the kernel holds more than this even in the smallest writes (`MAX_PIECES`), that is
 * the bound, plus one frame.
 */
export const MAX_UNREAD_MS = 1000;

/**
 * The most pieces a frame is written in (`kernelShare`): 1.25 ms of audio each. Linux counts its socket buffer per
 * write (~1 KiB each however small, ~200 KiB in all), so it holds 3.6 s of 20 ms frames at 8 or 16 kHz and 1 s at
 * 48 kHz for a program that stopped reading, and ~0.4 s in 16 pieces. macOS counts bytes (8 KiB): one write a frame.
 */
const MAX_PIECES = 16;

/** How the kernel holds a rate's audio, measured once per daemon (`kernelShare`). */
type KernelShare = { pieces: number; heldMs: number };
const kernelShares = new Map<CallRate, KernelShare>();

/**
 * How many pieces each frame of `rate` is written in, and how much of it the kernel then holds for a program that
 * reads none. Each count, 1, 2, 4, ... `MAX_PIECES`, is measured on the call's own socket before anyone else may open
 * it (`AudioSocket.open`); the first that leaves the kernel half of `MAX_UNREAD_MS` or less is taken, else the one
 * that held least (a count is taken only when it holds 5% less than fewer pieces did: macOS stays at one). Once per
 * rate, since it depends on the system, not on the call. Windows, or no measure (an error): one piece, nothing held,
 * the bound what waits in the daemon, as before; the next call measures again.
 */
async function kernelShare(path: string, rate: CallRate, onConnection: (take: ((socket: Socket) => void) | null) => void): Promise<KernelShare> {
  const known = kernelShares.get(rate);
  if (known) return known;
  const none = { pieces: 1, heldMs: 0 };
  if (process.platform === "win32") return none;
  let best: KernelShare | null = null;
  for (let pieces = 1; pieces <= MAX_PIECES && !(best && best.heldMs <= MAX_UNREAD_MS / 2); pieces *= 2) {
    const held = await kernelHolds(path, frameBytes(rate) / pieces, (rate * 2 * 30_000) / 1000, onConnection);
    if (held === null) return none;
    const heldMs = bytesToMs(rate, held);
    if (!best || heldMs < best.heldMs * 0.95) best = { pieces, heldMs };
  }
  kernelShares.set(rate, best!);
  return best!;
}

/**
 * Bytes the kernel takes in writes of `piece` bytes, one by one as `AudioSocket` writes them, until it holds one back
 * (or `most`): all in one turn of the event loop, so the reader, this process's own connection, has read none. Null
 * when no connection came.
 */
function kernelHolds(path: string, piece: number, most: number, onConnection: (take: ((socket: Socket) => void) | null) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const reader = connect(path);
    reader.on("error", () => {});
    const done = (held: number | null) => { clearTimeout(timer); onConnection(null); reader.destroy(); resolve(held); };
    const timer = setTimeout(() => done(null), 2000);
    onConnection((writer) => {
      writer.on("error", () => {});
      const bytes = Buffer.alloc(piece);
      let held = 0;
      while (held < most) {
        writer.write(bytes);
        if (writer.writableLength > 0) break;
        held += piece;
      }
      writer.destroy();
      done(held);
    });
  });
}

/** How long a connection that must send the call's token (`requireToken`) has to send it before it is closed. */
export const PROVE_MS = 5000;

/**
 * Serves one call's audio to one program at a time: what the program writes is handed to `onAudio` as it comes (raw
 * PCM, any amount); `write` gives it the caller's audio. A second connection replaces the first. `close` ends the
 * program's connection (it reads EOF) and removes the socket.
 *
 * Each call has a token (`token`, 32 random bytes as hex, given to the daemon's clients with the socket's path). A
 * program sends it first, then a line feed. With `requireToken` (the default on Windows, whose named pipe any account
 * of the machine may open and read), a connection is nobody's until it has: it hears nothing and replaces nobody, it is
 * closed when what it sent is not the token, and when `proveMs` pass without it. On an owner-only Unix socket the token
 * is optional: a connection is the program at once, and a token line it sends first is kept out of the call's audio.
 * `shared`: the socket is in the shared folder (`sharedFolder`), 0660 for its group, and the token is required.
 */
export class AudioSocket {
  private client: Socket | null = null;
  /** Connections that have not sent the token yet. */
  private readonly unproven = new Set<Socket>();
  private closed = false;
  /**
   * Audio for the program that waits in the daemon while the kernel holds a write back (it is full: the program reads
   * slower than the call speaks), in the pieces `kernelShare` measured. Handed to the kernel one write at a time:
   * Node's own buffer would join them into one larger write, which the kernel takes more of.
   */
  private backlog: Buffer[] = [];
  private backlogBytes = 0;
  /** Frames the program did not read in time, since the start. */
  dropped = 0;
  readonly token = randomBytes(32).toString("hex");

  private constructor(readonly path: string, private readonly server: Server, private readonly rate: CallRate, private readonly requireToken: boolean, private readonly proveMs: number, private readonly kernel: KernelShare) {}

  static async open(path: string, rate: CallRate, handlers: { onAudio(chunk: Buffer): void; onClient?(connected: boolean): void }, options: { requireToken?: boolean; proveMs?: number; shared?: boolean } = {}): Promise<AudioSocket> {
    const shared = !!options.shared && process.platform !== "win32";
    if (process.platform !== "win32") {
      if (shared) sharedFolder(dirname(path));
      else privateFolder(join(path, ".."), "calls will not put their audio there");
      if (existsSync(path)) rmSync(path, { force: true });
    }
    let self: AudioSocket | null = null;
    let probe: ((socket: Socket) => void) | null = null;
    const server = createServer((socket) => self ? self.accept(socket, handlers) : probe ? probe(socket) : socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    // Before the socket is opened up to the program (or the shared folder's group): the measure's own connection only.
    const kernel = await kernelShare(path, rate, (take) => { probe = take; });
    if (process.platform !== "win32") chmodSync(path, shared ? 0o660 : 0o600);
    self = new AudioSocket(path, server, rate, options.requireToken ?? (shared || process.platform === "win32"), options.proveMs ?? PROVE_MS, kernel);
    return self;
  }

  get connected(): boolean {
    return !!this.client && !this.client.destroyed;
  }

  private accept(socket: Socket, handlers: { onAudio(chunk: Buffer): void; onClient?(connected: boolean): void }): void {
    if (this.closed) { socket.destroy(); return; }
    socket.setNoDelay?.(true);
    socket.on("error", () => {});
    const line = Buffer.from(`${this.token}\n`);
    // What came before the token line is known to be there or not: held, never audio, until then.
    let head: Buffer | null = Buffer.alloc(0);
    const take = () => {
      this.unproven.delete(socket);
      const before = this.client;
      this.client = socket;
      this.backlog = [];
      this.backlogBytes = 0;
      // The program it replaces reads EOF and is let go 2 s later, as `close` lets the last one go: one that kept its
      // side open held its connection until it died, and the socket's close (a stopping daemon's) waited on it.
      if (before) {
        before.end();
        setTimeout(() => before.destroy(), 2000).unref();
      }
      handlers.onClient?.(true);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (this.requireToken) {
      this.unproven.add(socket);
      timer = setTimeout(() => socket.destroy(), this.proveMs);
      timer.unref?.();
    } else {
      take();
    }
    socket.on("data", (chunk: Buffer) => {
      if (head) {
        head = Buffer.concat([head, chunk]);
        if (this.requireToken) {
          // Compared whole and in constant time: a connection that may not hear the call learns nothing byte by byte.
          if (head.length < line.length) return;
          if (!timingSafeEqual(head.subarray(0, line.length), line)) { socket.destroy(); return; }
          if (timer) clearTimeout(timer);
          take();
        } else {
          const seen = Math.min(head.length, line.length);
          if (!head.subarray(0, seen).equals(line.subarray(0, seen))) {
            // A program that sends no token: all of it is audio.
            chunk = head;
            head = null;
            if (this.client === socket) handlers.onAudio(chunk);
            return;
          }
          if (head.length < line.length) return;
        }
        chunk = head.subarray(line.length);
        head = null;
        if (!chunk.length) return;
      }
      if (this.client === socket) handlers.onAudio(chunk);
    });
    socket.on("close", () => {
      if (timer) clearTimeout(timer);
      this.unproven.delete(socket);
      if (this.client !== socket) return;
      this.client = null;
      this.backlog = [];
      this.backlogBytes = 0;
      handlers.onClient?.(false);
    });
  }

  /**
   * One frame of the caller's audio for the program; dropped when nobody listens or the program stopped reading. A
   * program that keeps up gets it at once: the kernel takes it, nothing waits. Once the kernel holds one back, it is
   * full (`kernel.heldMs` the program has not read), and what waits in the daemon may make up the rest of
   * `MAX_UNREAD_MS`.
   */
  write(frame: Buffer): void {
    const client = this.client;
    if (!client || client.destroyed) return;
    if ((client.writableLength > 0 || this.backlog.length) && this.kernel.heldMs + bytesToMs(this.rate, client.writableLength + this.backlogBytes + frame.length) > MAX_UNREAD_MS) { this.dropped++; return; }
    const piece = Math.ceil(frame.length / this.kernel.pieces / 2) * 2;
    for (let at = 0; at < frame.length; at += piece) this.backlog.push(frame.subarray(at, at + piece));
    this.backlogBytes += frame.length;
    this.pump();
  }

  /** Hands the kernel what waits, one write a piece, for as long as it takes each whole (`backlog`). */
  private readonly pump = (): void => {
    const client = this.client;
    while (client && !client.destroyed && client.writableLength === 0 && this.backlog.length) {
      const piece = this.backlog.shift()!;
      this.backlogBytes -= piece.length;
      client.write(piece, this.pump);
    }
  };

  /** Ends the program's connection (EOF once what was written is read) and removes the socket. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const client = this.client;
    this.client = null;
    // What waits in the daemon goes before the end, as Node's own buffer did.
    if (client && !client.destroyed) for (const piece of this.backlog) client.write(piece);
    this.backlog = [];
    this.backlogBytes = 0;
    client?.end();
    if (client) setTimeout(() => client.destroy(), 2000).unref();
    for (const socket of this.unproven) socket.destroy();
    this.unproven.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      if (process.platform !== "win32") rmSync(this.path, { force: true });
      // Its folder outside the profile with it, once no other call's socket is in it.
      dropRuntimeFolder(this.path);
    });
  }
}
