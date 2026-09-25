import { fromBase64Url, type BoundChannel, type FrameChannel, type NativeBinding, type NativeEndpoint } from "@ghostly/core";

/**
 * Iroh (WISP 102) in a browser: the same QUIC/TLS session and binding as the
 * Desktop's native Iroh, but relay only. A page cannot send UDP, so every
 * packet goes through an Iroh relay over a WebSocket; the relay sees who talks
 * to whom and when, never the frames.
 *
 * The wasm (about 1 MB gzip) loads on the first chat that starts an endpoint,
 * never on the app's first load.
 */

/** n0's public relays, the same ones the Desktop's Iroh homes on by default. */
export const DEFAULT_IROH_RELAYS = [
  "https://use1-1.relay.n0.iroh.link/",
  "https://euc1-1.relay.n0.iroh.link/",
  "https://aps1-1.relay.n0.iroh.link/",
  "https://usw1-1.relay.n0.iroh.link/",
] as const;

/**
 * Why a relay URL cannot be used, or null. TLS, except on this machine (a local `iroh-relay --dev`): a page
 * may not open plain WebSockets elsewhere, and the relay's operator would see traffic metadata in the clear.
 */
export function irohRelayProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return `Not a relay address: ${value}`; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return `Use an https:// relay address: ${value}`;
  if (url.username || url.password || url.search || url.hash || value.length > 256) return `Not a relay address: ${value}`;
  return null;
}

/** A browser endpoint's descriptor: no direct addresses, only its relay. */
export interface IrohWebDescriptor { id: string; relay: string | null; addresses: string[] }

interface WasmConn {
  binding(): NativeBinding;
  send(text: string): Promise<void>;
  recv(): Promise<string | undefined>;
  rtt(): number;
  close(): void;
  free(): void;
}
interface WasmNode {
  address(): IrohWebDescriptor;
  connect(descriptor: unknown, timeoutMs: number): Promise<WasmConn>;
  accept(): Promise<WasmConn | undefined>;
  close(): Promise<void>;
  free(): void;
}
export interface IrohWasm {
  IrohNode: { start(seed: Uint8Array, relays: string[], onlineMs: number): Promise<WasmNode> };
}

let loaded: Promise<IrohWasm> | null = null;
/** Loads the wasm once per page. Tests pass their own `load` (Node reads the file). */
export function loadIrohWasm(): Promise<IrohWasm> {
  loaded ??= import("@ghostly/iroh-web").then(async module => {
    await module.default();
    return module as unknown as IrohWasm;
  }).catch(error => { loaded = null; throw error; });
  return loaded;
}

export interface IrohWebOptions {
  /** Relay URLs, first preferred. Default: n0's public relays. */
  relays?: readonly string[];
  /** How long to wait for the first relay to answer. */
  onlineMs?: number;
  connectMs?: number;
  load?: () => Promise<IrohWasm>;
}

const SEND_BUDGET = 120 * 1024;
const MAX_FRAME = 60 * 1024;

/** One paired channel over one QUIC stream. Sends are queued in order. */
class IrohWebChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: string[] = [];
  private queue = Promise.resolve();
  private closed = false;
  bufferedAmount = 0;
  onClose: FrameChannel["onClose"] = null;
  constructor(private conn: WasmConn, private forget: () => void) { void this.read(); }
  get onMessage() { return this.reader; }
  set onMessage(reader: FrameChannel["onMessage"]) {
    this.reader = reader;
    if (reader) for (const text of this.buffered.splice(0)) reader(text);
  }
  private async read() {
    try {
      for (;;) {
        const text = await this.conn.recv();
        if (text === undefined || this.closed) break;
        if (this.reader) this.reader(text);
        else if (this.buffered.length < 64) this.buffered.push(text);
        else break;
      }
    } catch { /* A broken stream ends the channel. */ }
    this.close();
  }
  send(data: string | Uint8Array) {
    if (typeof data !== "string" || this.closed || !data.length || data.length > MAX_FRAME || this.bufferedAmount + data.length > SEND_BUDGET)
      throw new Error("Iroh channel is closed or its send budget is full");
    this.bufferedAmount += data.length;
    this.queue = this.queue.then(() => this.closed ? undefined : this.conn.send(data))
      .catch(() => this.close()).finally(() => { this.bufferedAmount -= data.length; });
  }
  drained() { return this.queue; }
  get rttMs() { const rtt = this.conn.rtt(); return rtt >= 0 ? rtt : undefined; }
  close() {
    if (this.closed) return;
    this.closed = true; this.buffered = [];
    try { this.conn.close(); } catch { /* Already gone. */ }
    this.forget();
    this.onClose?.();
  }
}

/** A NativeEndpoint for `iroh/1`, as the Desktop's is, for one chat's transport seed. */
export async function createIrohWebEndpoint(seedB64: string, options: IrohWebOptions = {}): Promise<NativeEndpoint> {
  const seed = fromBase64Url(seedB64);
  if (seed.length !== 32) throw new Error("Invalid transport seed");
  const relays = [...(options.relays?.length ? options.relays : DEFAULT_IROH_RELAYS)];
  const wasm = await (options.load ?? loadIrohWasm)();
  const node = await wasm.IrohNode.start(seed, relays, options.onlineMs ?? 10_000);
  const channels = new Set<IrohWebChannel>();
  let stopped = false;
  let handler: NativeEndpoint["onConnection"] = null;
  const early: BoundChannel[] = [];
  const bind = (conn: WasmConn): BoundChannel => {
    const channel: IrohWebChannel = new IrohWebChannel(conn, () => channels.delete(channel));
    channels.add(channel);
    return { channel, binding: conn.binding() };
  };
  const endpoint: NativeEndpoint = {
    transport: "iroh/1",
    // Relay only: the rank puts it after every direct path (WISP 100, "Relayed").
    descriptor: { ...node.address(), relayed: true },
    onDescriptor: null,
    get onConnection() { return handler; },
    set onConnection(value) { handler = value; if (value) for (const bound of early.splice(0)) value(bound); },
    async connect(descriptor) {
      if (stopped) throw new Error("Iroh endpoint is stopped");
      const conn = await node.connect(descriptor, options.connectMs ?? 20_000);
      if (stopped) { conn.close(); throw new Error("Iroh endpoint is stopped"); }
      return bind(conn);
    },
    async close() {
      if (stopped) return;
      stopped = true;
      for (const channel of [...channels]) channel.close();
      for (const bound of early.splice(0)) bound.channel.close();
      await node.close().catch(() => {});
    },
  };
  void (async () => {
    while (!stopped) {
      let conn: WasmConn | undefined;
      try { conn = await node.accept(); } catch { break; }
      if (!conn) break;
      if (stopped) { conn.close(); break; }
      const bound = bind(conn);
      const accept = endpoint.onConnection;
      if (accept) accept(bound); else if (early.length < 4) early.push(bound); else bound.channel.close();
    }
    // The relay went away for good (or the endpoint was closed): stop offering Iroh.
    if (!stopped) { endpoint.onUnavailable?.(); await endpoint.close(); }
  })();
  return endpoint;
}
