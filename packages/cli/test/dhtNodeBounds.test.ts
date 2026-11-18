import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { ed25519 } from "@noble/curves/ed25519.js";
import { DhtQueryLimit, Mainline } from "../src/runtime/mainline";
// covers: headless.daemon

/**
 * What the CLI's own Mainline DHT node does for a stranger: a raw UDP socket on loopback speaks plain BEP5/BEP44 to it,
 * as any address on the internet can. The node routes (ping, find_node) and keeps the signed mutable items Pkarr is
 * made of, but answers each address at a bounded rate (a forged source address made it send ~12.5x the bytes of each
 * query to someone else, as fast as they came), and keeps nothing the app has no use for: immutable items and peers
 * announced for torrents, which it stored for anyone and served to anyone.
 */

type Value = Buffer | number | Value[] | { [key: string]: Value };

function encode(value: Value | string): Buffer {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string") value = Buffer.from(value);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(encode), Buffer.from("e")]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([Buffer.from("d"), ...keys.flatMap((key) => [encode(key), encode(value[key]!)]), Buffer.from("e")]);
}

function decode(buffer: Buffer): Value {
  let at = 0;
  const next = (): Value => {
    const c = String.fromCharCode(buffer[at]!);
    if (c === "i") { const end = buffer.indexOf("e", at); const n = Number(buffer.subarray(at + 1, end).toString()); at = end + 1; return n; }
    if (c === "l") { at++; const list: Value[] = []; while (buffer[at] !== 0x65) list.push(next()); at++; return list; }
    if (c === "d") { at++; const dict: Record<string, Value> = {}; while (buffer[at] !== 0x65) { const key = (next() as Buffer).toString(); dict[key] = next(); } at++; return dict; }
    const colon = buffer.indexOf(":", at);
    const length = Number(buffer.subarray(at, colon).toString());
    at = colon + 1 + length;
    return buffer.subarray(colon + 1, at);
  };
  return next();
}

type Reply = { y: string; r?: Record<string, Value>; e?: Value[]; bytes: number };

/** A DHT node nobody knows, on its own UDP port: sends queries to `port` and collects what comes back. */
class Stranger {
  readonly id = randomBytes(20);
  private readonly socket: Socket = createSocket("udp4");
  private readonly waiting = new Map<string, (reply: Reply) => void>();
  private tid = 0;
  replies = 0;
  bytesIn = 0;

  constructor(private readonly port: number) {
    this.socket.on("message", (message) => {
      this.replies++; this.bytesIn += message.length;
      const decoded = decode(message) as Record<string, Value>;
      const t = (decoded.t as Buffer).toString("hex");
      this.waiting.get(t)?.({ y: (decoded.y as Buffer).toString(), r: decoded.r as Record<string, Value>, e: decoded.e as Value[], bytes: message.length });
      this.waiting.delete(t);
    });
  }

  bound(): Promise<void> { return new Promise((resolve) => this.socket.bind(0, "127.0.0.1", resolve)); }

  /** Sends one query; its reply, or null when none comes within `waitMs`. */
  ask(q: string, a: Record<string, Value>, waitMs = 1_000): Promise<Reply | null> {
    const t = Buffer.alloc(4); t.writeUInt32BE(this.tid++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(t.toString("hex")); resolve(null); }, waitMs);
      this.waiting.set(t.toString("hex"), (reply) => { clearTimeout(timer); resolve(reply); });
      this.socket.send(encode({ t, y: Buffer.from("q"), q: Buffer.from(q), a: { id: this.id, ...a } }), this.port, "127.0.0.1");
    });
  }

  /** Sends `count` queries as fast as it can, not waiting for answers. */
  flood(count: number, q: string, a: Record<string, Value>): void {
    for (let i = 0; i < count; i++) {
      const t = Buffer.alloc(4); t.writeUInt32BE(this.tid++);
      this.socket.send(encode({ t, y: Buffer.from("q"), q: Buffer.from(q), a: { id: this.id, ...a } }), this.port, "127.0.0.1");
    }
  }

  close(): void { this.socket.close(); }
}

const sha1 = (data: Buffer) => createHash("sha1").update(data).digest();
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const thing of open.splice(0)) await thing.close();
});

async function nodeAndStranger(): Promise<{ node: Mainline; stranger: Stranger }> {
  const node = new Mainline({ bootstrap: false, host: "127.0.0.1", timeoutMs: 2_000 });
  await node.listening;
  open.push({ close: () => node.destroy() });
  const stranger = new Stranger(node.address().port);
  await stranger.bound();
  open.push(stranger);
  return { node, stranger };
}

describe("the CLI's Mainline DHT node, asked by a stranger", { timeout: 30_000 }, () => {
  it("routes: ping and find_node are answered", async () => {
    const { stranger } = await nodeAndStranger();
    expect((await stranger.ask("ping", {}))?.y).toBe("r");
    expect((await stranger.ask("find_node", { target: randomBytes(20) }))?.y).toBe("r");
  });

  it("answers one address at a bounded rate, not every query it sends, and answers it again after", async () => {
    const { stranger } = await nodeAndStranger();
    stranger.flood(1_000, "get", { target: randomBytes(20) });
    await settle(500);
    expect(stranger.replies).toBeGreaterThan(0);
    expect(stranger.replies).toBeLessThanOrEqual(30);
    await settle(1_000);
    expect((await stranger.ask("ping", {}))?.y).toBe("r");
  });

  it("does not keep an immutable item a stranger puts", async () => {
    const { stranger } = await nodeAndStranger();
    const v = randomBytes(990);
    const target = sha1(encode(v));
    const token = (await stranger.ask("get", { target }))?.r?.token as Buffer;
    expect(token).toBeInstanceOf(Buffer);
    expect((await stranger.ask("put", { token, v }))?.y).not.toBe("r");
    const got = await stranger.ask("get", { target });
    expect(got?.y).toBe("r");
    expect(got?.r?.v).toBeUndefined();
  });

  it("refuses a put signed with no key, and keeps answering", async () => {
    const { stranger } = await nodeAndStranger();
    const token = (await stranger.ask("get", { target: randomBytes(20) }))?.r?.token as Buffer;
    expect((await stranger.ask("put", { token, v: Buffer.from("x"), seq: 1, sig: randomBytes(64) }))?.y).not.toBe("r");
    expect((await stranger.ask("ping", {}))?.y).toBe("r");
  });

  it("drops malformed queries (a number where a hash goes, a salt that is no string) and keeps answering", async () => {
    const { stranger } = await nodeAndStranger();
    const token = (await stranger.ask("get", { target: randomBytes(20) }))?.r?.token as Buffer;
    await stranger.ask("get", { target: 5 }, 200);
    await stranger.ask("get_peers", { info_hash: 5 }, 200);
    await stranger.ask("find_node", { target: 5 }, 200);
    await stranger.ask("put", { token, k: randomBytes(32), v: Buffer.from("x"), seq: 1, sig: randomBytes(64), salt: 7 }, 200);
    expect((await stranger.ask("ping", {}))?.y).toBe("r");
  });

  it("does not keep peers a stranger announces for a torrent", async () => {
    const { stranger } = await nodeAndStranger();
    const info_hash = randomBytes(20);
    const token = (await stranger.ask("get_peers", { info_hash }))?.r?.token as Buffer;
    expect((await stranger.ask("announce_peer", { info_hash, port: 6881, token }))?.y).not.toBe("r");
    const got = await stranger.ask("get_peers", { info_hash });
    expect(got?.y).toBe("r");
    expect(got?.r?.values).toBeUndefined();
  });

  it("refuses a signed put whose value is no string of at most 1000 bytes, or whose seq is no integer, and serves none of them", async () => {
    const { stranger } = await nodeAndStranger();
    const putSigned = async (v: Value, seq: Value) => {
      const secret = ed25519.utils.randomSecretKey();
      const k = Buffer.from(ed25519.getPublicKey(secret));
      const sig = Buffer.from(ed25519.sign(encode({ seq, v }).subarray(1, -1), secret));
      const target = sha1(k);
      const token = (await stranger.ask("get", { target }))?.r?.token as Buffer;
      const put = await stranger.ask("put", { token, k, v, seq, sig });
      const got = await stranger.ask("get", { target });
      return { put, got };
    };
    // A dictionary or a list has no length bittorrent-dht reads: a 60 KB one was stored and served to any get.
    for (const [v, seq, code] of [
      [{ a: randomBytes(4_000) }, 1, 205],
      [[randomBytes(600), randomBytes(600)], 1, 205],
      [randomBytes(1_001), 1, 205],
      [Buffer.from("a packet"), Buffer.from("1"), 203],
      [Buffer.from("a packet"), -1, 203],
    ] as Array<[Value, Value, number]>) {
      const { put, got } = await putSigned(v, seq);
      expect(put?.y).toBe("e");
      expect(put?.e?.[0]).toBe(code);
      expect(got?.y).toBe("r");
      expect(got?.r?.v).toBeUndefined();
    }
    const { put, got } = await putSigned(randomBytes(1_000), 1_700_000_000_000_000);
    expect(put?.y).toBe("r");
    expect((got?.r?.v as Buffer).length).toBe(1_000);
  });

  it("keeps a signed mutable item (what Pkarr is made of) and serves it, for two hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { stranger } = await nodeAndStranger();
    const secret = ed25519.utils.randomSecretKey();
    const k = Buffer.from(ed25519.getPublicKey(secret));
    const v = Buffer.from("a packet");
    const seq = 1;
    const sig = Buffer.from(ed25519.sign(encode({ seq, v }).subarray(1, -1), secret));
    const target = sha1(k);
    const token = (await stranger.ask("get", { target }))?.r?.token as Buffer;
    expect((await stranger.ask("put", { token, k, v, seq, sig }))?.y).toBe("r");
    expect(((await stranger.ask("get", { target }))?.r?.v as Buffer).toString()).toBe("a packet");
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 60_000);
    const later = await stranger.ask("get", { target });
    expect(later?.y).toBe("r");
    expect(later?.r?.v).toBeUndefined();
  });
});

describe("DhtQueryLimit", () => {
  it("lets each address a burst, then its rate; and all addresses together no more than the total", () => {
    const limit = new DhtQueryLimit({ perAddress: 5, perAddressBurst: 10, total: 20, totalBurst: 40 });
    let t = 0;
    const taken = (host: string, n: number) => Array.from({ length: n }, () => limit.take(host, t)).filter(Boolean).length;
    expect(taken("10.0.0.1", 100)).toBe(10);
    t += 1_000;
    expect(taken("10.0.0.1", 100)).toBe(5);
    // Many addresses at once (a forged source each): the total holds.
    t += 10_000;
    let all = 0;
    for (let i = 0; i < 1_000; i++) all += taken(`10.1.${i >> 8}.${i & 255}`, 1);
    expect(all).toBe(40);
  });

  it("remembers a bounded number of addresses", () => {
    const limit = new DhtQueryLimit({ perAddress: 5, perAddressBurst: 10, total: 1e9, totalBurst: 1e9 });
    for (let i = 0; i < 100_000; i++) limit.take(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 0);
    expect(limit.size).toBeLessThanOrEqual(4_096);
  });
});
