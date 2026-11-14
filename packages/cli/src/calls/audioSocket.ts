import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CliError } from "../errors";
import { privateFolder, runtimePath } from "../privateFolder";
import { bytesToMs, type CallRate, type PlaybackQueue } from "./pcm";

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
 */
export function sharedFolder(path: string): void {
  const what = "calls will not put their audio there";
  let info;
  try { info = lstatSync(path); } catch { throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) is not there: ${what}. Make it a folder of this user's, 0750 with the group that reads the audio (chmod 2750)`); }
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) is not a folder of this user's: ${what}`);
  if ((info.mode & 0o027) !== 0) throw new CliError("refused", `${path} (GHOSTLY_CALL_SOCKET_DIR) may be written by others or entered by anyone outside its group: ${what}. Run \`chmod 2750 ${path}\`, then try again`);
}

/**
 * Removes the call sockets a daemon that died during a call left in this profile's folder (`audioSocketPath`; call
 * ids are 12 hex digits), or in the shared folder: no call outlives its daemon. A folder that is a link or someone
 * else's is left alone.
 */
export function clearAudioSockets(profileDir: string, sharedDir?: string): void {
  if (process.platform === "win32") return;
  const folder = dirname(audioSocketPath(profileDir, "0".repeat(12), sharedDir));
  try {
    const info = lstatSync(folder);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.endsWith(".sock") && !entry.isDirectory()) rmSync(join(folder, entry.name), { force: true });
    }
  } catch {
    // No folder yet, or one it cannot read: nothing to clear.
  }
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

/** How far a program may fall behind reading the call's audio before frames are dropped for it. */
export const MAX_UNREAD_MS = 1000;

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
  /** Frames the program did not read in time, since the start. */
  dropped = 0;
  readonly token = randomBytes(32).toString("hex");

  private constructor(readonly path: string, private readonly server: Server, private readonly rate: CallRate, private readonly requireToken: boolean, private readonly proveMs: number) {}

  static async open(path: string, rate: CallRate, handlers: { onAudio(chunk: Buffer): void; onClient?(connected: boolean): void }, options: { requireToken?: boolean; proveMs?: number; shared?: boolean } = {}): Promise<AudioSocket> {
    const shared = !!options.shared && process.platform !== "win32";
    if (process.platform !== "win32") {
      if (shared) sharedFolder(dirname(path));
      else privateFolder(join(path, ".."), "calls will not put their audio there");
      if (existsSync(path)) rmSync(path, { force: true });
    }
    let self: AudioSocket | null = null;
    const server = createServer((socket) => self ? self.accept(socket, handlers) : socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") chmodSync(path, shared ? 0o660 : 0o600);
    self = new AudioSocket(path, server, rate, options.requireToken ?? (shared || process.platform === "win32"), options.proveMs ?? PROVE_MS);
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
      handlers.onClient?.(false);
    });
  }

  /** One frame of the caller's audio for the program; dropped when nobody listens or the program stopped reading. */
  write(frame: Buffer): void {
    const client = this.client;
    if (!client || client.destroyed) return;
    if (bytesToMs(this.rate, client.writableLength) > MAX_UNREAD_MS) { this.dropped++; return; }
    client.write(frame);
  }

  /** Ends the program's connection (EOF once what was written is read) and removes the socket. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const client = this.client;
    this.client = null;
    client?.end();
    if (client) setTimeout(() => client.destroy(), 2000).unref();
    for (const socket of this.unproven) socket.destroy();
    this.unproven.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      if (process.platform !== "win32") rmSync(this.path, { force: true });
    });
  }
}
