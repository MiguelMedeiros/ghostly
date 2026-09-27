import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { bytesToMs, type CallRate } from "./pcm";

/**
 * A call's audio socket (WISP 11xx § Calls): `<profile>/calls/<call>.sock`, 0600, or under /tmp by a name derived
 * from that path when it is too long for a Unix socket; a named pipe on Windows.
 */
export function audioSocketPath(profileDir: string, callId: string): string {
  const inside = join(profileDir, "calls", `${callId}.sock`);
  const hash = createHash("sha256").update(inside).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-call-${hash}`;
  if (Buffer.byteLength(inside) <= 100) return inside;
  return join("/tmp", `ghostly-call-${hash}.sock`);
}

/** How far a program may fall behind reading the call's audio before frames are dropped for it. */
export const MAX_UNREAD_MS = 1000;

/**
 * Serves one call's audio to one program at a time: what the program writes is handed to `onAudio` as it comes (raw
 * PCM, any amount); `write` gives it the caller's audio. A second connection replaces the first. `close` ends the
 * program's connection (it reads EOF) and removes the socket.
 */
export class AudioSocket {
  private client: Socket | null = null;
  private closed = false;
  /** Frames the program did not read in time, since the start. */
  dropped = 0;

  private constructor(readonly path: string, private readonly server: Server, private readonly rate: CallRate) {}

  static async open(path: string, rate: CallRate, handlers: { onAudio(chunk: Buffer): void; onClient?(connected: boolean): void }): Promise<AudioSocket> {
    if (process.platform !== "win32") {
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      if (existsSync(path)) rmSync(path, { force: true });
    }
    let self: AudioSocket | null = null;
    const server = createServer((socket) => self!.accept(socket, handlers));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") chmodSync(path, 0o600);
    self = new AudioSocket(path, server, rate);
    return self;
  }

  get connected(): boolean {
    return !!this.client && !this.client.destroyed;
  }

  private accept(socket: Socket, handlers: { onAudio(chunk: Buffer): void; onClient?(connected: boolean): void }): void {
    if (this.closed) { socket.destroy(); return; }
    const before = this.client;
    this.client = socket;
    before?.end();
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => { if (this.client === socket) handlers.onAudio(chunk); });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.client !== socket) return;
      this.client = null;
      handlers.onClient?.(false);
    });
    handlers.onClient?.(true);
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
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      if (process.platform !== "win32") rmSync(this.path, { force: true });
    });
  }
}
