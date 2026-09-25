import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64, type BoundChannel, type FrameChannel, type NativeEndpoint } from "@ghostly/core";

/**
 * HyperDHT (WISP 103) for a browser, through a dht-relay: a server that runs the UDP half of HyperDHT and
 * talks to the browser over one WebSocket. It runs non-custodial: the browser keeps its keys, runs the
 * Noise handshake and the encrypted stream itself, and the relay moves handshake messages and ciphertext.
 * The binding (the handshake hash and both keys) is computed here, at the endpoint, as the Desktop does.
 *
 * What the relay sees: this browser's address, the HyperDHT keys it listens on and dials, and when and how
 * much it sends. Not the frames, not the keys' secrets, not the handshake hash.
 *
 * The wire is the Desktop's (native-transports/hyperdht/endpoint.mjs): the same preface, u32 length-prefixed
 * UTF-8 frames of at most 60 KiB, so a browser and a Desktop talk HyperDHT to each other.
 */

const PREFACE = "ghostly/paired-chat/1";
const MAX_FRAME = 60 * 1024;
const SEND_BUDGET = 120 * 1024;
const HANDSHAKE_MS = 20_000;
const RELAY_OPEN_MS = 10_000;
const LISTEN_MS = 20_000;
const MAX_CHANNELS = 2;

/** The descriptor a browser's HyperDHT endpoint gives out: its key, and that it is reached only through a relay. */
export interface RelayedHyperDescriptor { publicKey: string; relayed: true }

/** The parts of dht-relay and its streams this adapter uses. */
interface SecretSocket {
  handshakeHash: Uint8Array | null;
  publicKey: Uint8Array;
  remotePublicKey: Uint8Array;
  opened?: Promise<boolean>;
  destroyed?: boolean;
  write(data: Uint8Array): boolean;
  destroy(error?: Error): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}
interface RelayedServer {
  listen(keyPair: KeyPair): Promise<void>;
  close(): Promise<void>;
}
interface RelayedNode {
  ready(): Promise<void>;
  connect(remotePublicKey: Uint8Array, options: { keyPair: KeyPair }): SecretSocket;
  createServer(options: object, onconnection: (socket: SecretSocket) => void): RelayedServer;
  destroy(): Promise<void>;
}
interface KeyPair { publicKey: Uint8Array; secretKey: Uint8Array }

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, byte => parseInt(byte, 16));

/** HyperDHT's key pair for a seed: libsodium's layout (the seed, then the public key). */
export function hyperKeyPair(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error("Invalid HyperDHT seed");
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed); secretKey.set(publicKey, 32);
  return { publicKey, secretKey };
}

/** Only `wss://`, or `ws://` to this machine (a relay for tests or development). */
export function relayUrlProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Enter a relay address (wss://…)"; }
  if (parsed.protocol === "wss:") return null;
  if (parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
  return "Use a wss:// relay address";
}

/**
 * One WebSocket per relay for the whole app, shared by every chat's endpoint (each listens on its own
 * key). It closes when the last endpoint does. When the relay goes away, every endpoint on it says it is
 * unavailable, and the next one to start opens a new connection.
 */
interface RelayClient {
  node: RelayedNode;
  endpoints: Set<{ unavailable(): void }>;
  gone: boolean;
  /** Settles when the relay connection closes. */
  closed: Promise<void>;
}
const clients = new Map<string, Promise<RelayClient>>();

async function relayClient(url: string, createSocket: (url: string) => WebSocket): Promise<RelayClient> {
  const existing = clients.get(url);
  if (existing) {
    const client = await existing.catch(() => null);
    if (client && !client.gone) return client;
    if (clients.get(url) === existing) clients.delete(url);
  }
  const opening = (async () => {
    const [{ default: RelayedDHT }, { default: WebSocketStream }] = await Promise.all([
      import("@hyperswarm/dht-relay"), import("@hyperswarm/dht-relay/ws"),
    ]);
    const socket = createSocket(url);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("The HyperDHT relay did not answer")); }, RELAY_OPEN_MS);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not reach the HyperDHT relay")); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("The HyperDHT relay closed the connection")); }, { once: true });
    });
    // Non-custodial: the relay is told public keys only, never a secret key (dht-relay's default sends them).
    // The node's own key is never used to listen or dial: a random one says nothing about this app.
    const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false, keyPair: hyperKeyPair(crypto.getRandomValues(new Uint8Array(32))) }) as RelayedNode;
    let closed!: () => void;
    const client: RelayClient = { node, endpoints: new Set(), gone: false, closed: new Promise(resolve => { closed = resolve; }) };
    socket.addEventListener("close", () => {
      client.gone = true; closed();
      if (clients.get(url) === opening) clients.delete(url);
      for (const endpoint of [...client.endpoints]) endpoint.unavailable();
    });
    return client;
  })();
  clients.set(url, opening);
  opening.catch(() => { if (clients.get(url) === opening) clients.delete(url); });
  return opening;
}

function release(url: string, client: RelayClient, endpoint: { unavailable(): void }): void {
  client.endpoints.delete(endpoint);
  if (client.endpoints.size || client.gone) return;
  client.gone = true;
  void clients.get(url)?.then(current => { if (current === client) clients.delete(url); }).catch(() => {});
  void client.node.destroy().catch(() => {});
}

/** One authenticated stream as a frame channel, with a bounded queue before the session installs its reader. */
class RelayedChannel implements FrameChannel {
  private reader: FrameChannel["onMessage"] = null;
  private buffered: string[] = [];
  private closed = false;
  private pendingBytes = 0;
  onClose: FrameChannel["onClose"] = null;
  constructor(private readonly socket: SecretSocket) {
    socket.on("drain", () => { this.pendingBytes = 0; });
  }
  get bufferedAmount(): number { return this.pendingBytes; }
  get onMessage() { return this.reader; }
  set onMessage(reader: FrameChannel["onMessage"]) {
    this.reader = reader;
    if (reader) for (const text of this.buffered.splice(0)) reader(text);
  }
  receive(text: string): boolean {
    if (this.closed) return true;
    if (this.reader) this.reader(text);
    else if (this.buffered.length < 64) this.buffered.push(text);
    else return false;
    return true;
  }
  send(data: string | Uint8Array): void {
    if (typeof data !== "string" || this.closed || !data.length) throw new Error("Native channel is closed or exceeds its frame budget");
    const payload = new TextEncoder().encode(data);
    if (payload.length > MAX_FRAME || this.pendingBytes + payload.length > SEND_BUDGET) throw new Error("Native channel is closed or exceeds its frame budget");
    // The stream takes every write; past its high-water mark it says so until it drains.
    if (!writeFrame(this.socket, payload) || this.pendingBytes) this.pendingBytes += payload.length + 4;
  }
  drained(): Promise<void> {
    if (!this.pendingBytes) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { this.socket.off("close", gone); resolve(); };
      const gone = () => { this.socket.off("drain", done); reject(new Error("Native channel closed")); };
      this.socket.once("drain", done); this.socket.once("close", gone);
    });
  }
  closedByPeer(): void {
    if (this.closed) return;
    this.closed = true; this.buffered = [];
    this.onClose?.();
  }
  close(): void {
    if (this.closed) return;
    this.socket.destroy();
    this.closedByPeer();
  }
}

function writeFrame(socket: SecretSocket, payload: Uint8Array): boolean {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  return socket.write(frame);
}

/**
 * Waits for the peer's preface on an authenticated stream (sending ours as soon as the handshake is
 * done), then hands the channel over with the binding the stream itself gives. A frame of the wrong size,
 * bytes that are not UTF-8 or another protocol close the stream.
 */
function attach(socket: SecretSocket, channels: Set<RelayedChannel>): Promise<BoundChannel> {
  if (channels.size >= MAX_CHANNELS) { socket.destroy(); return Promise.reject(new Error("Native connection limit reached")); }
  const channel = new RelayedChannel(socket);
  channels.add(channel);
  return new Promise<BoundChannel>((resolve, reject) => {
    let buffer = new Uint8Array(0);
    let prefaced = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const timer = setTimeout(() => socket.destroy(new Error("HyperDHT handshake timed out")), HANDSHAKE_MS);
    const fail = (error: Error) => { socket.destroy(error); };
    socket.on("error", (error: Error) => reject(error));
    socket.on("close", () => {
      clearTimeout(timer); channels.delete(channel);
      reject(new Error("Native channel closed"));
      channel.closedByPeer();
    });
    const opened = () => {
      if (socket.handshakeHash?.length !== 64 || socket.publicKey?.length !== 32 || socket.remotePublicKey?.length !== 32) {
        fail(new Error("Noise session binding unavailable")); return;
      }
      writeFrame(socket, new TextEncoder().encode(PREFACE));
    };
    if (socket.opened) void socket.opened.then(ok => { if (ok) opened(); else reject(new Error("Noise handshake failed")); });
    else socket.once("open", opened);
    socket.on("data", (chunk: Uint8Array) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer); joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        if (length === 0 || length > MAX_FRAME) { fail(new Error("Invalid frame length")); return; }
        if (buffer.length < 4 + length) break;
        let text: string;
        try { text = decoder.decode(buffer.subarray(4, 4 + length)); }
        catch { fail(new Error("Invalid UTF-8 frame")); return; }
        buffer = buffer.slice(4 + length);
        if (!prefaced) {
          if (text !== PREFACE) { fail(new Error("Unexpected application protocol")); return; }
          prefaced = true; clearTimeout(timer);
          resolve({ channel, binding: { transport: "hyperdht/1", context: hex(socket.handshakeHash!),
            identities: [hex(socket.publicKey), hex(socket.remotePublicKey)].sort() as [string, string] } });
        } else if (!channel.receive(text)) { fail(new Error("Receive queue exceeded")); return; }
      }
    });
  });
}

export interface RelayedHyperOptions {
  /** How to open the WebSocket (tests pass Node's `ws`). Default: the browser's. */
  createSocket?: (url: string) => WebSocket;
}

/**
 * A chat's HyperDHT endpoint through the relay at `url`: it listens on the key of `seedB64` (the chat's
 * own transport seed, as on the Desktop) and dials a contact's descriptor. Fails, and so is not offered,
 * when the relay cannot be reached or does not let it listen.
 */
export async function createRelayedHyperEndpoint(seedB64: string, url: string, options: RelayedHyperOptions = {}): Promise<NativeEndpoint> {
  const problem = relayUrlProblem(url);
  if (problem) throw new Error(problem);
  const keyPair = hyperKeyPair(fromBase64(seedB64));
  const client = await relayClient(url, options.createSocket ?? (address => new WebSocket(address)));
  const channels = new Set<RelayedChannel>();
  let stopped = false;
  let handler: NativeEndpoint["onConnection"] = null;
  const waiting: BoundChannel[] = [];
  let endpoint: NativeEndpoint | null = null;
  const member = {
    unavailable() {
      if (stopped) return;
      stopped = true;
      for (const channel of channels) channel.close();
      endpoint?.onUnavailable?.();
    },
  };
  client.endpoints.add(member);
  const server = client.node.createServer({}, socket => {
    void attach(socket, channels).then(bound => {
      if (stopped) bound.channel.close();
      else if (handler) handler(bound);
      else if (waiting.length < MAX_CHANNELS) waiting.push(bound);
      else bound.channel.close();
    }).catch(() => {});
  });
  try {
    await Promise.race([
      server.listen(keyPair),
      client.closed.then(() => { throw new Error("The HyperDHT relay closed the connection"); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The HyperDHT relay did not let this chat listen")), LISTEN_MS)),
    ]);
    if (client.gone) throw new Error("The HyperDHT relay closed the connection");
  } catch (error) {
    stopped = true;
    void server.close().catch(() => {});
    release(url, client, member);
    throw error;
  }
  const descriptor: RelayedHyperDescriptor = { publicKey: hex(keyPair.publicKey), relayed: true };
  endpoint = {
    transport: "hyperdht/1", descriptor, onDescriptor: null, onUnavailable: null,
    get onConnection() { return handler; },
    set onConnection(value) { handler = value; if (value) for (const bound of waiting.splice(0)) value(bound); },
    async connect(address) {
      const publicKey = (address as { publicKey?: unknown } | null)?.publicKey;
      if (stopped || typeof publicKey !== "string" || !/^[a-f0-9]{64}$/.test(publicKey)) throw new Error("Invalid HyperDHT endpoint");
      return attach(client.node.connect(fromHex(publicKey), { keyPair }), channels);
    },
    async close() {
      stopped = true;
      for (const channel of channels) channel.close();
      waiting.length = 0;
      await server.close().catch(() => {});
      release(url, client, member);
    },
  };
  return endpoint;
}
