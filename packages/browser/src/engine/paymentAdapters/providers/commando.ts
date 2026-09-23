import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Commando: JSON-RPC to a Core Lightning node over the Lightning peer protocol, authenticated with a rune.
 * The browser opens a websocket to the node (`bind-addr=ws:…`, or a wss:// proxy in front of it), speaks
 * BOLT 8 (Noise_XK over secp256k1) as a throwaway peer, and sends `commando` messages. The handshake
 * authenticates the node's public key, so a proxy in the middle only ever sees ciphertext.
 *
 * Only what Ghostly needs: the handshake, the transport, `init`, `ping`/`pong` and the three commando
 * messages. Everything the node sends is bounded (message sizes, reply size, time).
 */

// -- BOLT 8 --------------------------------------------------------------------

const PROTOCOL = utf8ToBytes("Noise_XK_secp256k1_ChaChaPoly_SHA256");
const PROLOGUE = utf8ToBytes("lightning");
const EMPTY = new Uint8Array(0);
const ACT_TWO = 50;
const MAC = 16;
const ROTATE_AT = 1000;

const nonce = (n: number) => { const out = new Uint8Array(12); new DataView(out.buffer).setBigUint64(4, BigInt(n), true); return out; };
const encrypt = (key: Uint8Array, n: number, ad: Uint8Array, plain: Uint8Array) => chacha20poly1305(key, nonce(n), ad).encrypt(plain);
const decrypt = (key: Uint8Array, n: number, ad: Uint8Array, cipher: Uint8Array) => chacha20poly1305(key, nonce(n), ad).decrypt(cipher);
const hkdf2 = (salt: Uint8Array, ikm: Uint8Array) => { const out = hkdf(sha256, ikm, salt, EMPTY, 64); return [out.slice(0, 32), out.slice(32)] as const; };
/** BOLT 8's ECDH: the SHA-256 of the compressed shared point. */
export const ecdh = (privateKey: Uint8Array, publicKey: Uint8Array) => sha256(secp256k1.getSharedSecret(privateKey, publicKey, true));
const publicOf = (privateKey: Uint8Array) => secp256k1.getPublicKey(privateKey, true);

/** One direction of the transport: a key, its chaining key and a nonce that rotates the key every 1000 uses. */
class CipherState {
  private n = 0;
  constructor(private key: Uint8Array, private ck: Uint8Array) {}
  private next() {
    const n = this.n++;
    if (this.n === ROTATE_AT) { [this.ck, this.key] = hkdf2(this.ck, this.key); this.n = 0; }
    return n;
  }
  seal(plain: Uint8Array) { const key = this.key; return encrypt(key, this.next(), EMPTY, plain); }
  open(cipher: Uint8Array) { const key = this.key; return decrypt(key, this.next(), EMPTY, cipher); }
}

/** An encrypted Lightning transport, once the handshake is done: frames out, frames in. */
export class NoiseTransport {
  constructor(private readonly sending: CipherState, private readonly receiving: CipherState) {}
  static from(sk: Uint8Array, rk: Uint8Array, ck: Uint8Array) { return new NoiseTransport(new CipherState(sk, ck), new CipherState(rk, ck)); }
  /** One Lightning message, as it goes on the wire: encrypted length, then encrypted body. */
  encryptMessage(message: Uint8Array) {
    if (message.length > 0xffff) throw new Error("Lightning messages are at most 65535 bytes");
    const length = new Uint8Array(2); new DataView(length.buffer).setUint16(0, message.length);
    return concatBytes(this.sending.seal(length), this.sending.seal(message));
  }
  /** The body length from an 18-byte encrypted length. Throws when it does not authenticate. */
  decryptLength(header: Uint8Array) { return new DataView(this.receiving.open(header).buffer).getUint16(0); }
  decryptBody(body: Uint8Array) { return this.receiving.open(body); }
}

/**
 * The initiator's side of the handshake. `remote` is the node's public key (33 bytes); `local` and
 * `ephemeral` are private keys (random unless a test pins them to the BOLT 8 vectors).
 */
export class NoiseInitiator {
  private h: Uint8Array;
  private ck: Uint8Array;
  private temp = EMPTY;
  private re = EMPTY;
  constructor(private readonly remote: Uint8Array, private readonly local = secp256k1.utils.randomSecretKey(), private readonly ephemeral = secp256k1.utils.randomSecretKey()) {
    this.ck = this.h = sha256(PROTOCOL);
    this.h = sha256(concatBytes(this.h, PROLOGUE));
    this.h = sha256(concatBytes(this.h, remote));
  }

  actOne(): Uint8Array {
    const e = publicOf(this.ephemeral);
    this.h = sha256(concatBytes(this.h, e));
    [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.ephemeral, this.remote));
    const c = encrypt(this.temp, 0, this.h, EMPTY);
    this.h = sha256(concatBytes(this.h, c));
    return concatBytes(new Uint8Array([0]), e, c);
  }

  /** Reads act two and answers with act three. The transport is ready once this returns. */
  actTwoThree(act: Uint8Array): { reply: Uint8Array; transport: NoiseTransport } {
    if (act.length !== ACT_TWO || act[0] !== 0) throw new Error("The node answered the handshake with something else");
    this.re = act.slice(1, 34);
    const c = act.slice(34);
    this.h = sha256(concatBytes(this.h, this.re));
    [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.ephemeral, this.re));
    decrypt(this.temp, 0, this.h, c);
    this.h = sha256(concatBytes(this.h, c));
    const sealed = encrypt(this.temp, 1, this.h, publicOf(this.local));
    this.h = sha256(concatBytes(this.h, sealed));
    [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.local, this.re));
    const t = encrypt(this.temp, 0, this.h, EMPTY);
    const [sk, rk] = hkdf2(this.ck, EMPTY);
    return { reply: concatBytes(new Uint8Array([0]), sealed, t), transport: NoiseTransport.from(sk, rk, this.ck) };
  }
}

// -- Lightning messages ---------------------------------------------------------

export const MESSAGE = { init: 16, error: 17, ping: 18, pong: 19, commando: 0x4c4f, replyContinues: 0x594b, replyTerm: 0x594d } as const;
const u16 = (value: number) => { const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, value); return out; };
const readU16 = (bytes: Uint8Array, at = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at);
/** `init` with no features: a peer that only wants to talk to the node's RPC, not open channels. */
const INIT = concatBytes(u16(MESSAGE.init), u16(0), u16(0));

// -- the client -----------------------------------------------------------------

/** The part of a WebSocket the client uses (the browser's, or Node's global one). */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;
const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/** The node answered, with an error: the command ran (or was refused) and this is its final word. */
export class CommandoError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = "CommandoError"; }
}
/** No answer: the connection failed or the time ran out. Whether a command ran is unknown. */
export class CommandoTransportError extends Error {
  constructor(message: string, readonly sent = false) { super(message); this.name = "CommandoTransportError"; }
}
/** The error codes that mean the node did not run the command at all. */
export const COMMANDO_NOT_RUN = {
  /** The rune does not allow this method or these parameters. */
  notAuthorized: 0x4c51,
  /** No such command on this node (an older version, a plugin that is not loaded). */
  unknownMethod: -32601,
} as const;

export interface CommandoOptions {
  /** ws:// or wss:// */
  url: string;
  /** The node's public key, 33 bytes in hex. */
  nodeId: string;
  rune: string;
  socket?: SocketFactory;
  /** Handshake and init. */
  connectTimeoutMs?: number;
  /** Ends every call and the connection. */
  signal?: AbortSignal;
}

interface Pending { method: string; chunks: Uint8Array[]; size: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

const MAX_REPLY = 4 * 1024 * 1024;
const MAX_BUFFER = 70_000;
const text = new TextDecoder();

/**
 * One connection to a node, opened on first use and again after it drops. Calls run concurrently, matched
 * to their answers by an 8-byte id.
 */
export class CommandoClient {
  private socket?: SocketLike;
  private opening?: Promise<void>;
  private transport?: NoiseTransport;
  private readonly calls = new Map<string, Pending>();
  private closed = false;
  private readonly remote: Uint8Array;
  /** Fails the handshake under way, when there is one. */
  private abortHandshake?: (message: string) => void;

  constructor(private readonly options: CommandoOptions) {
    this.remote = hexToBytes(options.nodeId);
    options.signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  /**
   * Runs `method` on the node. Resolves with its result; throws `CommandoError` when the node answered with
   * an error, `CommandoTransportError` when there was no answer (`sent`: the request left this side).
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, { timeoutMs = 30_000, filter }: { timeoutMs?: number; filter?: unknown } = {}): Promise<T> {
    if (this.closed) throw new CommandoTransportError("The connection to the node is closed");
    await this.open();
    const id = crypto.getRandomValues(new Uint8Array(8)), key = bytesToHex(id);
    const body = utf8ToBytes(JSON.stringify({ id: `ghostly:${method}#${key}`, rune: this.options.rune, method, params, ...(filter ? { filter } : {}) }));
    const message = concatBytes(u16(MESSAGE.commando), id, body);
    if (message.length > 0xffff) throw new CommandoTransportError("The request is too large");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(key, new CommandoTransportError(`The node did not answer ${method} in time`, true)), timeoutMs);
      this.calls.set(key, { method, chunks: [], size: 0, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.write(message); }
      catch (error) { this.settle(key, new CommandoTransportError(error instanceof Error ? error.message : "Could not send to the node")); }
    });
  }

  async close() {
    this.closed = true;
    this.drop(new CommandoTransportError("The connection to the node was closed", true));
  }

  private open(): Promise<void> {
    if (this.transport && this.socket?.readyState === 1) return Promise.resolve();
    return this.opening ??= this.handshake().finally(() => { this.opening = undefined; });
  }

  private handshake(): Promise<void> {
    const { url, socket = defaultSocket, connectTimeoutMs = 15_000 } = this.options;
    return new Promise<void>((resolve, reject) => {
      let ws: SocketLike;
      try { ws = socket(url); }
      catch (error) {
        // A page served over https cannot open ws:// to another machine; neither can a strict CSP.
        reject(new CommandoTransportError(url.startsWith("ws://") ? "This page cannot open a ws:// connection to that address: use a wss:// address" : `Could not open ${error instanceof Error ? error.name : "the connection"}`));
        return;
      }
      ws.binaryType = "arraybuffer";
      this.socket = ws; this.transport = undefined;
      const noise = new NoiseInitiator(this.remote);
      let buffer: Uint8Array = new Uint8Array(0), stage: "act2" | "init" | "ready" = "act2", length: number | undefined;
      const fail = (message: string) => { clearTimeout(timer); reject(new CommandoTransportError(message)); this.drop(new CommandoTransportError(message, true), ws); };
      const timer = setTimeout(() => fail("The node did not complete the handshake in time"), connectTimeoutMs);
      this.abortHandshake = fail;
      ws.onopen = () => { try { ws.send(noise.actOne()); } catch { fail("Could not start the handshake"); } };
      ws.onerror = () => { if (stage !== "ready") fail("Could not reach the node at that address"); };
      ws.onclose = () => { if (stage !== "ready") fail("The node closed the connection during the handshake (is the node id right?)"); else this.drop(new CommandoTransportError("The connection to the node dropped", true), ws); };
      ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return fail("The node sent something that is not binary");
        const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        buffer = concatBytes(buffer, chunk);
        if (buffer.length > MAX_BUFFER) return fail("The node sent more than a Lightning message");
        try {
          if (stage === "act2") {
            if (buffer.length < ACT_TWO) return;
            const { reply, transport } = noise.actTwoThree(buffer.slice(0, ACT_TWO));
            buffer = buffer.slice(ACT_TWO);
            ws.send(reply);
            this.transport = transport;
            ws.send(transport.encryptMessage(INIT));
            stage = "init";
          }
          for (;;) {
            if (length === undefined) {
              if (buffer.length < 2 + MAC) return;
              length = this.transport!.decryptLength(buffer.slice(0, 2 + MAC));
              buffer = buffer.slice(2 + MAC);
            }
            if (buffer.length < length + MAC) return;
            const message = this.transport!.decryptBody(buffer.slice(0, length + MAC));
            buffer = buffer.slice(length + MAC); length = undefined;
            if (stage === "init") {
              if (message.length < 2 || readU16(message) !== MESSAGE.init) continue;
              stage = "ready"; clearTimeout(timer); this.abortHandshake = undefined; resolve();
              continue;
            }
            this.receive(message);
          }
        } catch {
          fail(stage === "act2" ? "The handshake failed: that is not this node's id" : "The node sent a message that does not decrypt");
        }
      };
    });
  }

  private write(message: Uint8Array) {
    if (!this.transport || this.socket?.readyState !== 1) throw new Error("Not connected to the node");
    this.socket.send(this.transport.encryptMessage(message));
  }

  private receive(message: Uint8Array) {
    if (message.length < 2) return;
    const type = readU16(message);
    if (type === MESSAGE.ping && message.length >= 4) {
      const wanted = readU16(message, 2);
      if (wanted < 65532) try { this.write(concatBytes(u16(MESSAGE.pong), u16(wanted), new Uint8Array(wanted))); } catch { /* the close will say it */ }
      return;
    }
    if (type === MESSAGE.error) { this.drop(new CommandoTransportError("The node closed the connection with an error", true)); return; }
    if ((type !== MESSAGE.replyContinues && type !== MESSAGE.replyTerm) || message.length < 10) return;
    const key = bytesToHex(message.slice(2, 10)), call = this.calls.get(key);
    if (!call) return;
    const chunk = message.slice(10);
    call.size += chunk.length; call.chunks.push(chunk);
    if (call.size > MAX_REPLY) { this.settle(key, new CommandoTransportError(`The node's answer to ${call.method} is too large`, true)); return; }
    if (type === MESSAGE.replyContinues) return;
    let reply: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try { reply = JSON.parse(text.decode(concatBytes(...call.chunks))); }
    catch { this.settle(key, new CommandoTransportError(`The node's answer to ${call.method} cannot be read`, true)); return; }
    if (reply?.error) {
      const code = typeof reply.error.code === "number" ? reply.error.code : 0;
      const detail = typeof reply.error.message === "string" ? reply.error.message.slice(0, 200) : "error";
      this.settle(key, new CommandoError(code, `${call.method}: ${detail}`, reply.error.data));
    } else if (reply && "result" in reply) this.settle(key, undefined, reply.result);
    else this.settle(key, new CommandoTransportError(`The node's answer to ${call.method} has no result`, true));
  }

  private settle(key: string, error?: Error, value?: unknown) {
    const call = this.calls.get(key);
    if (!call) return;
    this.calls.delete(key); clearTimeout(call.timer);
    if (error) call.reject(error); else call.resolve(value);
  }

  /** Ends the connection (or only `socket`, when it is still the current one) and every call on it. */
  private drop(error: Error, socket = this.socket) {
    if (!socket || socket !== this.socket) return;
    const handshake = this.abortHandshake;
    this.socket = undefined; this.transport = undefined; this.abortHandshake = undefined;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch { /* already closed */ }
    handshake?.(error.message);
    for (const key of [...this.calls.keys()]) this.settle(key, error);
  }
}
