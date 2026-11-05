import { dialableIrohRelay, fromBase64Url, irohDescriptor, irohRelayUrl, type BoundChannel, type FrameChannel, type NativeBinding, type NativeEndpoint } from "@ghostly/core";

/**
 * Iroh (WISP 102) in a browser: the same QUIC/TLS session and binding as the
 * Desktop's native Iroh, but relay only. A page cannot send UDP, so every
 * packet goes through an Iroh relay over a WebSocket; the relay sees who talks
 * to whom and when, never the frames.
 *
 * The wasm (about 1 MB gzip) loads on the first chat that starts an endpoint,
 * never on the app's first load.
 */

/**
 * n0's public relays, the same ones the Desktop's Iroh homes on by default, then Ghostly's own (`iroh-relay` behind a
 * Cloudflare tunnel) as one more fallback. Iroh homes on the one with the lowest latency it measures, not the first.
 * Iroh itself names n0's with the trailing dot of a full domain name (`use1-1.relay.n0.iroh.link.`), and compares relay
 * URLs as text; here they have none, because WebKit opens no host name that ends in a dot. `BROWSER_SPELLING` is what
 * keeps the two one relay. Ghostly's stays plain everywhere: the tunnel in front of it answers the dotted name with 404.
 * At most `MAX_IROH_RELAYS`, the wasm's own limit.
 */
export const DEFAULT_IROH_RELAYS = [
  "https://use1-1.relay.n0.iroh.link/",
  "https://euc1-1.relay.n0.iroh.link/",
  "https://aps1-1.relay.n0.iroh.link/",
  "https://usw1-1.relay.n0.iroh.link/",
  "https://iroh.miguelmedeiros.dev/",
] as const;

/** The most relays an endpoint homes on: the wasm refuses more (`native/transports/iroh-web`), as does the Desktop. */
export const MAX_IROH_RELAYS = 5;

/**
 * Whether one of these relays is n0's public ones (`*.iroh.link`, either spelling): those refused six of sixteen
 * listeners started at once, so an app that may home on one keeps the listener count they took.
 */
export function onPublicIrohRelay(relays: readonly string[]): boolean {
  return relays.some(relay => { try { return /(^|\.)iroh\.link\.?$/.test(new URL(relay).hostname); } catch { return false; } });
}

/**
 * The spelling of every relay URL handed to the wasm Iroh (`irohRelayUrl`): the relays it homes on and a contact's
 * relay before a dial. One spelling, so a contact on this endpoint's relay is reached over the connection already
 * open to it; without the dot, so Safari can open it (a Desktop's record names its relay with the dot).
 */
const BROWSER_SPELLING = "plain";

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
  /**
   * Dial only through one of `relays` (Hide my IP from contacts, WISP 100 § Relay only): the wasm reaches a peer through
   * the relay its descriptor names, and a contact who runs that relay would see this profile's address there.
   */
  ownRelaysOnly?: boolean;
}

const SEND_BUDGET = 120 * 1024;
const MAX_FRAME = 60 * 1024;
/** How often an endpoint reads which relay it is homed on (`createIrohWebEndpoint`). */
const HOME_CHECK_MS = 5_000;

/** One paired channel over one QUIC stream. Sends are queued in order. */
class IrohWebChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: string[] = [];
  private queue = Promise.resolve();
  private closed = false;
  bufferedAmount = 0;
  readonly sendBudget = SEND_BUDGET;
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

/**
 * The relay the first endpoint on a relay list homed on, per wasm loader and list. Each endpoint keeps measuring
 * every relay in its list (a `GET /ping` to each, about 1.3 a minute), and all the endpoints in one app share one
 * network, so the first measures for all: the others start on its home relay alone, which is also the one their
 * descriptor names. Dialling a contact on another relay still works; only the measuring is skipped.
 */
const homes = new WeakMap<object, Map<string, Promise<string | null>>>();

/** Starts a node on the home relay the first endpoint found, or on every relay when there is none or it fails. */
async function startNode(wasm: IrohWasm, homesOfList: Map<string, Promise<string | null>>, seed: Uint8Array, relays: string[], onlineMs: number): Promise<WasmNode> {
  const key = relays.join(" ");
  const found = relays.length > 1 ? homesOfList.get(key) : undefined;
  const home = found ? await found : null;
  if (found && home) {
    try { return await wasm.IrohNode.start(seed, [home], onlineMs); } catch {
      // That relay stopped answering: measure again, from the next endpoint on.
      if (homesOfList.get(key) === found) homesOfList.delete(key);
    }
  }
  let settle = (_home: string | null) => {};
  const mine = relays.length > 1 && !homesOfList.has(key) ? new Promise<string | null>(resolve => { settle = resolve; }) : null;
  if (mine) homesOfList.set(key, mine);
  try {
    const node = await wasm.IrohNode.start(seed, relays, onlineMs);
    const homed = node.address().relay;
    settle(relays.find(relay => homed && new URL(relay).href === new URL(homed).href) ?? null);
    return node;
  } catch (error) {
    if (mine && homesOfList.get(key) === mine) homesOfList.delete(key);
    settle(null);
    throw error;
  }
}

/** Whether a descriptor (in `BROWSER_SPELLING`) names one of these relays, whichever way its URL is written. */
function onOwnRelay(descriptor: unknown, relays: readonly string[]): boolean {
  const relay = (descriptor as { relay?: unknown } | null | undefined)?.relay;
  if (typeof relay !== "string") return false;
  try { return relays.some(own => new URL(own).href === new URL(relay).href); } catch { return false; }
}

/** A NativeEndpoint for `iroh/1`, as the Desktop's is, for one chat's transport seed. */
export async function createIrohWebEndpoint(seedB64: string, options: IrohWebOptions = {}): Promise<NativeEndpoint> {
  const seed = fromBase64Url(seedB64);
  if (seed.length !== 32) throw new Error("Invalid transport seed");
  // Either spelling of a relay (with or without the trailing dot) homes on it under the one a browser opens.
  const relays = [...new Set((options.relays?.length ? options.relays : DEFAULT_IROH_RELAYS).map(relay => irohRelayUrl(relay, BROWSER_SPELLING)))];
  const load = options.load ?? loadIrohWasm;
  const wasm = await load();
  let homesOfList = homes.get(load);
  if (!homesOfList) homes.set(load, homesOfList = new Map());
  const node = await startNode(wasm, homesOfList, seed, relays, options.onlineMs ?? 10_000);
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
      if (!dialableIrohRelay((descriptor as { relay?: unknown } | null)?.relay, relays)) throw new Error("The contact's Iroh relay is not one this device dials");
      const dialled = irohDescriptor(descriptor, BROWSER_SPELLING);
      if (options.ownRelaysOnly && !onOwnRelay(dialled, relays)) throw new Error("The contact is not on one of this profile's Iroh relays");
      const conn = await node.connect(dialled, options.connectMs ?? 20_000);
      if (stopped) { conn.close(); throw new Error("Iroh endpoint is stopped"); }
      return bind(conn);
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(watching);
      for (const channel of [...channels]) channel.close();
      for (const bound of early.splice(0)) bound.channel.close();
      await node.close().catch(() => {});
    },
  };
  // Iroh moves its home to another of the relays when the one it homed on goes away or another answers faster, and a
  // contact reaches it only through the relay its record names (the one left: no answer, every time). The wasm says
  // nothing when it moves, so its address is read again (`HOME_CHECK_MS`) and a new home is published, as the
  // Desktop's own Iroh does (`onDescriptor`). Between two homes it has none: the last stays published.
  const watching = setInterval(() => {
    let now: IrohWebDescriptor;
    try { now = node.address(); } catch { return; }
    if (stopped || !now.relay || now.relay === (endpoint.descriptor as IrohWebDescriptor).relay) return;
    endpoint.descriptor = { ...now, relayed: true };
    endpoint.onDescriptor?.();
  }, HOME_CHECK_MS);
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
