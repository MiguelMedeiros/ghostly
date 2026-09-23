import { afterEach, describe, expect, it, vi } from "vitest";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { CommandoClient, CommandoError, CommandoTransportError, MESSAGE, NoiseInitiator, NoiseTransport, ecdh, type SocketLike } from "../src/engine/paymentAdapters/providers/commando";

const h = (hex: string) => hexToBytes(hex.replace(/^0x/, ""));

// The initiator vectors of BOLT 8 (lightning/bolts, 08-transport.md, "Appendix A").
describe("BOLT 8 handshake and transport", () => {
  const rs = h("028d7500dd4c12685d1f568b4c2b5048e8534b873319f3a8daa612b469132ec7f7");
  const ls = h("1111111111111111111111111111111111111111111111111111111111111111");
  const e = h("1212121212121212121212121212121212121212121212121212121212121212");
  const act2 = "0002466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276e2470b93aac583c9ef6eafca3f730ae";

  it("produces the spec's act one and act three", () => {
    const noise = new NoiseInitiator(rs, ls, e);
    expect(bytesToHex(noise.actOne())).toBe("00036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f70df6086551151f58b8afe6c195782c6a");
    const { reply } = noise.actTwoThree(h(act2));
    expect(bytesToHex(reply)).toBe("00b9e3a702e93e3a9948c2ed6e5fd7590a6e1c3a0344cfc9d5b57357049aa22355361aa02e55a8fc28fef5bd6d71ad0c38228dc68b1c466263b47fdf31e560e139ba");
  });

  it.each([
    ["a short act two", act2.slice(0, -2)],
    ["a bad version", `01${act2.slice(2)}`],
    ["a bad public key", `0004${act2.slice(4)}`],
    ["a bad tag", `${act2.slice(0, -2)}af`],
  ])("refuses %s", (_name, input) => {
    const noise = new NoiseInitiator(rs, ls, e);
    noise.actOne();
    expect(() => noise.actTwoThree(h(input))).toThrow();
  });

  it("encrypts messages as the spec does, rotating keys every 1000 nonces", () => {
    const noise = new NoiseInitiator(rs, ls, e);
    noise.actOne();
    const { transport } = noise.actTwoThree(h(act2));
    const outputs = new Map<number, string>([
      [0, "cf2b30ddf0cf3f80e7c35a6e6730b59fe802473180f396d88a8fb0db8cbcf25d2f214cf9ea1d95"],
      [1, "72887022101f0b6753e0c7de21657d35a4cb2a1f5cde2650528bbc8f837d0f0d7ad833b1a256a1"],
      [500, "178cb9d7387190fa34db9c2d50027d21793c9bc2d40b1e14dcf30ebeeeb220f48364f7a4c68bf8"],
      [501, "1b186c57d44eb6de4c057c49940d79bb838a145cb528d6e8fd26dbe50a60ca2c104b56b60e45bd"],
      [1000, "4a2f3cc3b5e78ddb83dcb426d9863d9d9a723b0337c89dd0b005d89f8d3c05c52b76b29b740f09"],
      [1001, "2ecd8c8a5629d0d02ab457a0fdd0f7b90a192cd46be5ecb6ca570bfc5e268338b1a16cf4ef2d36"],
    ]);
    for (let i = 0; i <= 1001; i++) {
      const out = bytesToHex(transport.encryptMessage(utf8ToBytes("hello")));
      if (outputs.has(i)) expect(out, `message ${i}`).toBe(outputs.get(i));
    }
  });
});

// -- a fake node: BOLT 8's responder side over an in-memory socket ------------------

const EMPTY = new Uint8Array(0);
const nonce = (n: number) => { const out = new Uint8Array(12); new DataView(out.buffer).setBigUint64(4, BigInt(n), true); return out; };
const hkdf2 = (salt: Uint8Array, ikm: Uint8Array) => { const out = hkdf(sha256, ikm, salt, EMPTY, 64); return [out.slice(0, 32), out.slice(32)] as const; };
const u16 = (v: number) => new Uint8Array([v >> 8, v & 255]);

type Handler = (method: string, params: Record<string, unknown>, rune: string) => unknown;

class FakeNode {
  readonly key = secp256k1.utils.randomSecretKey();
  readonly id = bytesToHex(secp256k1.getPublicKey(this.key, true));
  readonly requests: { method: string; params: Record<string, unknown>; rune: string }[] = [];
  readonly pongs: Uint8Array[] = [];
  sockets: FakeSocket[] = [];
  /** Split replies in chunks of this many bytes (commando's "continues" messages). */
  chunk = 0;
  constructor(public handler: Handler) {}
  socket = (url: string): SocketLike => { const s = new FakeSocket(this, url); this.sockets.push(s); return s; };
}

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  onclose: SocketLike["onclose"] = null;
  private h = EMPTY; private ck = EMPTY; private e = secp256k1.utils.randomSecretKey(); private re = EMPTY; private temp = EMPTY;
  private transport?: NoiseTransport;
  private stage: "act1" | "act3" | "open" = "act1";
  private buffer = EMPTY;
  constructor(private readonly node: FakeNode, readonly url: string) {
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({}), 0); }
  /** The node hangs up. */
  drop() { this.readyState = 3; this.onclose?.({}); }
  private deliver(bytes: Uint8Array) { const copy = bytes.slice(); setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: copy.buffer }), 0); }
  sendMessage(message: Uint8Array) { this.deliver(this.transport!.encryptMessage(message)); }

  send(data: Uint8Array) {
    const bytes = new Uint8Array(data);
    if (this.stage === "act1") {
      const local = secp256k1.getPublicKey(this.node.key, true);
      this.ck = this.h = sha256(utf8ToBytes("Noise_XK_secp256k1_ChaChaPoly_SHA256"));
      this.h = sha256(concatBytes(this.h, utf8ToBytes("lightning")));
      this.h = sha256(concatBytes(this.h, local));
      this.re = bytes.slice(1, 34);
      this.h = sha256(concatBytes(this.h, this.re));
      [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.node.key, this.re));
      try { chacha20poly1305(this.temp, nonce(0), this.h).decrypt(bytes.slice(34)); } catch { this.drop(); return; }
      this.h = sha256(concatBytes(this.h, bytes.slice(34)));
      const ePub = secp256k1.getPublicKey(this.e, true);
      this.h = sha256(concatBytes(this.h, ePub));
      [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.e, this.re));
      const c = chacha20poly1305(this.temp, nonce(0), this.h).encrypt(EMPTY);
      this.h = sha256(concatBytes(this.h, c));
      this.stage = "act3";
      this.deliver(concatBytes(new Uint8Array([0]), ePub, c));
      return;
    }
    if (this.stage === "act3") {
      const sealed = bytes.slice(1, 50), t = bytes.slice(50);
      const rs = chacha20poly1305(this.temp, nonce(1), this.h).decrypt(sealed);
      this.h = sha256(concatBytes(this.h, sealed));
      [this.ck, this.temp] = hkdf2(this.ck, ecdh(this.e, rs));
      chacha20poly1305(this.temp, nonce(0), this.h).decrypt(t);
      const [rk, sk] = hkdf2(this.ck, EMPTY);
      this.transport = NoiseTransport.from(sk, rk, this.ck);
      this.stage = "open";
      this.sendMessage(concatBytes(u16(MESSAGE.init), u16(0), u16(0)));
      return;
    }
    this.buffer = concatBytes(this.buffer, bytes);
    while (this.buffer.length >= 18) {
      const length = this.transport!.decryptLength(this.buffer.slice(0, 18));
      const message = this.transport!.decryptBody(this.buffer.slice(18, 18 + length + 16));
      this.buffer = this.buffer.slice(18 + length + 16);
      void this.receive(message);
    }
  }

  private async receive(message: Uint8Array) {
    const type = (message[0] << 8) | message[1];
    if (type === MESSAGE.pong) { this.node.pongs.push(message); return; }
    if (type !== MESSAGE.commando) return;
    const id = message.slice(2, 10);
    const request = JSON.parse(new TextDecoder().decode(message.slice(10))) as { method: string; params: Record<string, unknown>; rune: string };
    this.node.requests.push(request);
    let reply: string;
    try { reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: await this.node.handler(request.method, request.params, request.rune) }); }
    catch (error) {
      if (error === HANG) return;
      reply = JSON.stringify({ jsonrpc: "2.0", id: 1, error: error as object });
    }
    const bytes = utf8ToBytes(reply), size = this.node.chunk || bytes.length;
    for (let at = 0; at < bytes.length; at += size) {
      const last = at + size >= bytes.length;
      this.sendMessage(concatBytes(u16(last ? MESSAGE.replyTerm : MESSAGE.replyContinues), id, bytes.slice(at, at + size)));
    }
  }
}
const HANG = Symbol("hang");

describe("CommandoClient", () => {
  let client: CommandoClient | undefined;
  afterEach(async () => { await client?.close(); client = undefined; vi.useRealTimers(); });
  const open = (node: FakeNode, extra: Partial<ConstructorParameters<typeof CommandoClient>[0]> = {}) =>
    (client = new CommandoClient({ url: "ws://127.0.0.1:1", nodeId: node.id, rune: "test-rune", socket: node.socket, ...extra }));

  it("runs a command with the rune, after the handshake and init", async () => {
    const node = new FakeNode((method) => ({ method, network: "regtest" }));
    expect(await open(node).call("getinfo")).toEqual({ method: "getinfo", network: "regtest" });
    expect(node.requests).toEqual([{ method: "getinfo", params: {}, rune: "test-rune", id: expect.stringContaining("getinfo") }]);
    expect(node.sockets).toHaveLength(1);
  });

  it("puts a reply split in many messages back together, and matches concurrent calls by id", async () => {
    const node = new FakeNode(async (_method, params) => { await new Promise((r) => setTimeout(r, Number(params.wait))); return { echo: params.text }; });
    node.chunk = 7;
    const c = open(node);
    const text = "x".repeat(500);
    const [slow, fast] = await Promise.all([c.call("echo", { wait: 30, text: "slow" }), c.call("echo", { wait: 0, text })]);
    expect(slow).toEqual({ echo: "slow" });
    expect(fast).toEqual({ echo: text });
  });

  it("an error answer is a CommandoError with the node's code: the node's final word", async () => {
    const node = new FakeNode(() => { throw { code: 19537, message: "Invalid rune: Not permitted" }; });
    const error = await open(node).call("listfunds").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandoError);
    expect(error).toMatchObject({ code: 19537, message: "listfunds: Invalid rune: Not permitted" });
  });

  it("no answer in time is a CommandoTransportError, sent", async () => {
    const node = new FakeNode(() => { throw HANG; });
    const error = await open(node).call("xpay", {}, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandoTransportError);
    expect(error).toMatchObject({ sent: true });
  });

  it("answers the node's pings", async () => {
    const node = new FakeNode(() => ({}));
    const c = open(node);
    await c.call("getinfo");
    node.sockets[0].sendMessage(concatBytes(u16(MESSAGE.ping), u16(4), u16(0)));
    await vi.waitFor(() => expect(node.pongs).toHaveLength(1));
    expect(bytesToHex(node.pongs[0])).toBe("0013" + "0004" + "00000000");
  });

  it("a wrong node id fails the handshake, and nothing is sent", async () => {
    const node = new FakeNode(() => ({}));
    const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
    const error = await open(node, { nodeId: other }).call("getinfo").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandoTransportError);
    expect(error).toMatchObject({ sent: false });
    expect(node.requests).toHaveLength(0);
  });

  it("a dropped connection fails the calls on it, and the next call connects again", async () => {
    const node = new FakeNode((method) => { if (method === "hang") throw HANG; return { ok: true }; });
    const c = open(node);
    const pending = c.call("hang");
    await vi.waitFor(() => expect(node.requests).toHaveLength(1));
    node.sockets[0].drop();
    await expect(pending).rejects.toMatchObject({ name: "CommandoTransportError", sent: true });
    expect(await c.call("getinfo")).toEqual({ ok: true });
    expect(node.sockets).toHaveLength(2);
  });

  it("refuses an answer larger than it reads", async () => {
    const node = new FakeNode(() => ({ big: "y".repeat(5 * 1024 * 1024) }));
    node.chunk = 60_000;
    await expect(open(node).call("listinvoices", {}, { timeoutMs: 20_000 })).rejects.toThrow(/too large/);
  });

  it("the source's signal ends it", async () => {
    const node = new FakeNode((method) => { if (method === "hang") throw HANG; return {}; });
    const controller = new AbortController();
    const c = open(node, { signal: controller.signal });
    const pending = c.call("hang");
    await vi.waitFor(() => expect(node.requests).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CommandoTransportError);
    await expect(c.call("getinfo")).rejects.toThrow(/closed/);
  });
});
