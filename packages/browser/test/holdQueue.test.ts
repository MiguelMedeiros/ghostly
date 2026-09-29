import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink, createRelayPayload, parseRelayPayload, DiscoveryBudgetError, HOLD_LIMITS, type PaymentRequest, type PkarrTransport, type SignedPacket } from "@ghostly/core";
import { HoldEngine, emptyHoldState, type HoldHost } from "../src/engine/hold";
import { presignS3 } from "../src/backup/s3";
import { manifestName, type HoldStore } from "../src/backup/storage";
import type { HoldState, StoredLink } from "../src/shared/types";
// covers: delivery.hold.text, delivery.hold.request, delivery.hold.tamper, delivery.hold.expiry, delivery.hold.protocol

/**
 * Store-and-forward beyond the happy path (test/hold.test.ts): what is removed before pickup, items
 * whose content is gone, a storage that misbehaves while the contact picks up (errors, oversize
 * answers, a broken stream), an interrupted pickup that resumes without a duplicate, and the timers
 * that keep the pointer and manifest alive. One clock drives both sides.
 */

function bucket() {
  const objects = new Map<string, Uint8Array>();
  const store: HoldStore & { objects: typeof objects } = {
    objects,
    description: "S3 · test",
    async put(name, bytes) { objects.set(name, bytes.slice()); },
    async get(name) { const bytes = objects.get(name); if (!bytes) throw new Error("404"); return bytes; },
    async list() { return []; },
    async listFolder() { return []; },
    async remove(name) { objects.delete(name); },
    presign: (name, seconds) => presignS3({ method: "GET", url: new URL(`https://s3.test/bucket/${name}`), expiresSeconds: seconds }, { region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" }),
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const bytes = objects.get(decodeURIComponent(url.pathname.replace(/^\/bucket\//, "")));
    return bytes ? new Response(bytes.slice() as BodyInit, { headers: { "content-length": String(bytes.length) } }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { store, fetcher };
}

/** `held`: how many requests the relays' budget refuses next (a wait of a minute each), reads and publishes alike. */
function relay(): PkarrTransport & { packets: Map<string, SignedPacket>; puts: number; fail?: string; held: number } {
  const packets = new Map<string, SignedPacket>();
  return {
    packets, puts: 0, held: 0,
    async publish(identity, records) {
      if (this.held > 0) { this.held--; throw new DiscoveryBudgetError(60_000); }
      if (this.fail) throw new Error(this.fail);
      this.puts++; packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
    },
    async resolve(key) { if (this.held > 0) { this.held--; throw new DiscoveryBudgetError(60_000); } return packets.get(key) ?? null; },
    describe: () => ({ protocol: "memory", relays: [] }),
  };
}

interface Side {
  engine: HoldEngine;
  stored: StoredLink;
  texts: Map<string, string>;
  files: Map<string, { bytes: Uint8Array; name: string; size: number; mime: string }>;
  requests: Map<string, PaymentRequest>;
  received: { kind: string; id: string; text?: string }[];
  delivery: Map<string, { state: string; error?: string }>;
  storageOn: boolean;
  saves: number;
  ttl?: number;
  bucket: ReturnType<typeof bucket>;
  /** How this side reads the other's storage; tests wrap it. */
  fetch: typeof fetch;
}

function setup() {
  const clock = { t: Date.now() };
  const link = createLink();
  const alice = createIdentity(), bob = createIdentity();
  const transport = relay();
  const make = (mine: StoredLink): Side => {
    const side = { stored: mine, texts: new Map(), files: new Map(), requests: new Map(), received: [], delivery: new Map(), storageOn: true, saves: 0, bucket: bucket() } as unknown as Side;
    const host: HoldHost = {
      transport,
      storage: () => (side.storageOn ? { store: side.bucket.store, space: "abcdefghijklmnop" } : null),
      link: () => ({ stored: side.stored, open: false }),
      linkIds: () => [mine.id],
      saveHold: async (_id, hold) => { side.saves++; side.stored = { ...side.stored, hold: structuredClone(hold) }; },
      delivery: async (_id, messageId, state, error) => { side.delivery.set(messageId, { state, error }); },
      text: async (_id, messageId) => side.texts.get(messageId) ?? null,
      file: async (fileId) => side.files.get(fileId) ?? null,
      paymentRequest: (paymentId) => side.requests.get(paymentId) ?? null,
      receiveText: async (_id, m) => { side.received.push({ kind: "text", id: m.id, text: m.text }); },
      receiveFile: async (_id, f) => { side.received.push({ kind: "file", id: f.wireId }); return null; },
      receivePaymentRequest: async (_id, request) => { side.received.push({ kind: "pay-req", id: request.id }); },
      changed: () => {},
      fetch: ((...args: Parameters<typeof fetch>) => side.fetch(...args)) as typeof fetch,
      now: () => clock.t,
      ttlMs: () => side.ttl,
    };
    side.engine = new HoldEngine(host);
    return side;
  };
  const enabled: HoldState = { ...emptyHoldState(), enabled: true, peerAllows: true, peerPaymentMethods: ["cashu", "lightning"] };
  const a = make({ id: "link-a", ...link.mine, profile: "paired-chat/1", participationSeed: alice.seedB64, pairedPeerKey: bob.pubKeyZ32, createdAt: 0, hold: structuredClone(enabled) });
  const b = make({ id: "link-b", ...link.invite, profile: "paired-chat/1", participationSeed: bob.seedB64, pairedPeerKey: alice.pubKeyZ32, createdAt: 0, hold: structuredClone(enabled) });
  a.fetch = b.bucket.fetcher; b.fetch = a.bucket.fetcher;
  engines.push(a.engine, b.engine);
  /**
   * One look by this side, finished when it returns: expiry, uploads, renewals and the contact's pointer.
   * The engine runs (as after `start()`), but only this look is in flight: no background one races it.
   */
  const look = async (side: Side, advance = 10_000) => {
    clock.t += advance;
    const engine = side.engine as unknown as { running: boolean; tick(all: boolean): Promise<void> };
    engine.running = true;
    await engine.tick(true);
  };
  const holdText = async (id: string, text: string) => { a.texts.set(id, text); await a.engine.hold("link-a", { kind: "text", id: `wire-${id}-item`, messageId: id, bytes: text.length, timestamp: clock.t }); };
  return { a, b, transport, clock, look, holdText };
}

const engines: HoldEngine[] = [];
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); });

describe("the sender's queue", () => {
  it("a message deleted before pickup leaves storage and the manifest, and the contact never sees it", async () => {
    const { a, b, look, holdText } = setup();
    await holdText("m1", "one"); await holdText("m2", "two");
    const name = a.stored.hold!.outbox[0].name;
    await a.engine.forget("link-a", "m1");
    await a.engine.forget("link-a", "unknown");
    expect(a.stored.hold!.outbox.map((e) => e.messageId)).toEqual(["m2"]);
    expect(a.bucket.store.objects.has(name)).toBe(false);
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["two"]);
    expect(b.stored.hold!.inSeq).toBe(2);
  });

  it("retrying an item that is already held uploads nothing and only says held", async () => {
    const { a, transport, holdText } = setup();
    await holdText("m1", "one");
    const puts = transport.puts, objects = a.bucket.store.objects.size;
    a.delivery.clear();
    expect(await a.engine.retry("link-a", "m1")).toBe(true);
    expect(a.delivery.get("m1")?.state).toBe("held");
    expect(transport.puts).toBe(puts);
    expect(a.bucket.store.objects.size).toBe(objects);
  });

  it("an item whose message, file or payment request is gone fails with that reason and is kept for a retry", async () => {
    const { a } = setup();
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-t-item", messageId: "t", bytes: 3, timestamp: 1 })).rejects.toThrow(/message is gone/);
    await expect(a.engine.hold("link-a", { kind: "file", id: "wire-f-item", messageId: "f", ref: "file-1", bytes: 3, timestamp: 2 })).rejects.toThrow(/file is gone/);
    await expect(a.engine.hold("link-a", { kind: "pay-req", id: "p1-payment-req", messageId: "p", ref: "p1-payment-req", bytes: 3, timestamp: 3 })).rejects.toThrow(/payment request is gone/);
    expect(a.stored.hold!.outbox.map((e) => [e.seq, e.state])).toEqual([[1, "failed"], [2, "failed"], [3, "failed"]]);
    expect(a.delivery.get("f")).toMatchObject({ state: "failed", error: "The file is gone" });
    expect(a.engine.view("link-a")).toMatchObject({ outstanding: 0, error: "The payment request is gone" });
    // Back again: the retry holds it under its first sequence.
    a.texts.set("t", "now here");
    expect(await a.engine.retry("link-a", "t")).toBe(true);
    expect(a.stored.hold!.outbox[0]).toMatchObject({ seq: 1, state: "held" });
    expect(a.engine.view("link-a")!.error).toBeUndefined();
  });

  it("stored but not announced: the item fails with that reason, and a retry announces it", async () => {
    const { a, transport, holdText } = setup();
    transport.fail = "relay down";
    await expect(holdText("m1", "one")).rejects.toThrow(/Stored, but could not tell the contact where: relay down/);
    expect(a.delivery.get("m1")?.state).toBe("failed");
    transport.fail = undefined;
    expect(await a.engine.retry("link-a", "m1")).toBe(true);
    expect(a.delivery.get("m1")?.state).toBe("held");
  });

  it("a pointer the relays' budget held back is no failure: the item is held, and its pointer goes out on the next look", async () => {
    const { a, b, transport, look, holdText } = setup();
    transport.held = 1;
    await holdText("m1", "one");
    expect(a.delivery.get("m1")?.state).toBe("held");
    expect(a.engine.view("link-a")!.error).toBeUndefined();
    expect(transport.puts, "the pointer waits for the budget").toBe(0);
    await look(a);
    expect(transport.puts).toBe(1);
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
  });

  it("a pointer read the relays' budget held back is no error, and read again", async () => {
    const { b, transport, look, holdText } = setup();
    await holdText("m1", "one");
    transport.held = 1;
    await look(b);
    expect(b.engine.view("link-b")!.error).toBeUndefined();
    expect(b.received).toEqual([]);
    await look(b, 1_000);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
  });

  it("an item cut off by a crash before its upload goes up on the next look", async () => {
    const { a, b, look, holdText } = setup();
    const put = a.bucket.store.put;
    a.bucket.store.put = async () => { throw new Error("crash"); };
    await expect(holdText("m1", "one")).rejects.toThrow();
    a.bucket.store.put = put;
    a.stored = { ...a.stored, hold: { ...a.stored.hold!, outbox: a.stored.hold!.outbox.map((e) => ({ ...e, state: "queued" as const })) } };
    await look(a);
    expect(a.delivery.get("m1")?.state).toBe("held");
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
  });

  it("a shorter lifetime asked by the host is honored, a longer one is capped at seven days", async () => {
    const { a, clock, holdText } = setup();
    a.ttl = 1_000;
    await holdText("m1", "one");
    expect(a.stored.hold!.outbox[0].expires).toBe(clock.t + 1_000);
    a.ttl = 30 * 24 * 3600_000;
    await holdText("m2", "two");
    expect(a.stored.hold!.outbox[1].expires).toBe(clock.t + HOLD_LIMITS.ttlMs);
  });

  it("the switch and the contact's payment methods are saved only when they change", async () => {
    const { a } = setup();
    let saves = a.saves;
    await a.engine.rememberPeerMethods("link-a", ["cashu", "lightning"]);
    expect(a.saves).toBe(saves);
    await a.engine.rememberPeerMethods("link-a", ["lightning", "onchain" as never]);
    expect(a.saves).toBe(++saves);
    expect(a.engine.heldPaymentMethods("link-a")).toEqual(["lightning"]);
    await a.engine.peerSaid("link-a", { peerAllows: true });
    expect(a.saves).toBe(saves);
    await a.engine.setEnabled("link-a", false);
    expect(a.engine.canHold("link-a")).toBe(false);
    expect(a.engine.heldPaymentMethods("link-a")).toBeNull();
  });

  it("no keys and no view for a chat that is not a paired one or whose pinned key is not a key", () => {
    const { a } = setup();
    a.stored = { ...a.stored, pairedPeerKey: "not a key" };
    expect(a.engine.keysFor("link-a")).toBeNull();
    expect(a.engine.canHold("link-a")).toBe(false);
    a.stored = { ...a.stored, profile: undefined };
    expect(a.engine.view("link-a")).toBeUndefined();
  });
});

describe("the sender's timers", () => {
  it("repeats its pointer hourly while something is held, and signs the manifest again before it gets old", async () => {
    const { a, transport, look, holdText } = setup();
    await holdText("m1", "one");
    const signed = a.stored.hold!.manifestSignedAt!;
    const puts = transport.puts;
    await look(a);
    expect(transport.puts).toBe(puts); // nothing due
    await look(a, 61 * 60_000);
    expect(transport.puts).toBe(puts + 1);
    expect(a.stored.hold!.manifestSignedAt).toBe(signed);
    await look(a, 4 * 24 * 3600_000);
    expect(transport.puts).toBe(puts + 2);
    expect(a.stored.hold!.manifestSignedAt).toBeGreaterThan(signed);
  });
});

describe("picking up: the storage and the pointer misbehave", () => {
  it("an interrupted pickup stops where it was and resumes there: nothing is received twice", async () => {
    const { b, look, holdText } = setup();
    for (const [id, text] of [["m1", "one"], ["m2", "two"], ["m3", "three"]]) await holdText(id, text);
    const real = b.fetch;
    let calls = 0;
    b.fetch = (async (...args: Parameters<typeof fetch>) => { if (++calls === 3) throw new TypeError("network down"); return real(...args); }) as typeof fetch;
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
    expect(b.stored.hold!.inSeq).toBe(1);
    expect(b.engine.view("link-b")!.error).toMatch(/Could not pick up held items: network down/);
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one", "two", "three"]);
    expect(b.stored.hold!).toMatchObject({ inSeq: 3, refused: 0 });
    expect(b.engine.view("link-b")!.error).toBeUndefined();
    await look(b);
    expect(b.received).toHaveLength(3);
  });

  it("a pointer that cannot be read is reported, and read again at the next look", async () => {
    const { b, transport, look, holdText } = setup();
    await holdText("m1", "one");
    const resolve = transport.resolve;
    transport.resolve = async () => { throw new Error("DHT unreachable"); };
    await look(b);
    expect(b.engine.view("link-b")!.error).toBe("Could not read the contact's pointer: DHT unreachable");
    transport.resolve = resolve;
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
  });

  it("a storage that answers with an error is tried again later, not counted as a refusal", async () => {
    const { b, look, holdText } = setup();
    await holdText("m1", "one");
    const real = b.fetch;
    b.fetch = (async () => new Response("slow down", { status: 503 })) as unknown as typeof fetch;
    await look(b);
    expect(b.engine.view("link-b")).toMatchObject({ refused: 0, error: expect.stringContaining("The storage answered 503") });
    expect(b.stored.hold!.inSeq).toBe(0);
    b.fetch = real;
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
  });

  it("a manifest that does not open is refused and counted", async () => {
    const { a, b, look, holdText } = setup();
    await holdText("m1", "one");
    const bytes = a.bucket.store.objects.get(manifestName("abcdefghijklmnop", a.stored.hold!.mailbox!))!;
    bytes[bytes.length - 2] ^= 1;
    await look(b);
    expect(b.received).toEqual([]);
    expect(b.engine.view("link-b")).toMatchObject({ refused: 1, error: expect.stringMatching(/^Refused what the contact's storage offered/) });
  });

  it("an item larger than the manifest declared is refused, whether the size is announced or only streamed", async () => {
    const { a, b, look, holdText } = setup();
    await holdText("m1", "one"); await holdText("m2", "two");
    const [first, second] = a.stored.hold!.outbox.map((e) => e.name);
    const real = b.fetch;
    b.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      const bytes = a.bucket.store.objects.get(path.replace(/^\/bucket\//, ""));
      if (path.endsWith(first)) return new Response(bytes!.slice() as BodyInit, { headers: { "content-length": String(10 * 1024 * 1024) } });
      if (path.endsWith(second)) {
        // No length announced, and one byte more than the item is.
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes!.slice()); c.enqueue(new Uint8Array(1)); c.close(); } }));
      }
      return real(input, init);
    }) as typeof fetch;
    await look(b);
    expect(b.received).toEqual([]);
    expect(b.stored.hold!).toMatchObject({ inSeq: 2, refused: 2, refusedSeqs: [1, 2] });
    expect(b.engine.view("link-b")!.error).toMatch(/larger than the manifest said/);
  });

  it("a storage answering without a stream is read whole, and still bounded", async () => {
    const { a, b, look, holdText } = setup();
    await holdText("m1", "one"); await holdText("m2", "two");
    const second = a.stored.hold!.outbox[1].name;
    const real = b.fetch;
    b.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const whole = decodeURIComponent(String(input)).includes(second) ? new Uint8Array(bytes.length + 64) : bytes;
      return { ok: true, status: 200, headers: new Headers(), body: null, arrayBuffer: async () => whole.buffer } as unknown as Response;
    }) as typeof fetch;
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["one"]);
    expect(b.stored.hold!).toMatchObject({ inSeq: 2, refused: 1 });
  });

  it("an item that expired before pickup is skipped, never shown", async () => {
    const { a, b, look, holdText } = setup();
    a.ttl = 5_000;
    await holdText("m1", "stale");
    a.ttl = undefined;
    await holdText("m2", "fresh");
    await look(b);
    expect(b.received.map((r) => r.text)).toEqual(["fresh"]);
    expect(b.stored.hold!).toMatchObject({ inSeq: 2, refused: 0 });
  });

  it("a held payment request that is not one is refused", async () => {
    const { a, b, look } = setup();
    a.requests.set("p1-payment-req", { id: "p1-payment-req", timestamp: 3, amount: { value: "lots", asset: "sat" }, endpoints: [] } as unknown as PaymentRequest);
    await a.engine.hold("link-a", { kind: "pay-req", id: "p1-payment-req", messageId: "p", ref: "p1-payment-req", bytes: 64, timestamp: 3 });
    await look(b);
    expect(b.received).toEqual([]);
    expect(b.engine.view("link-b")).toMatchObject({ refused: 1, error: expect.stringContaining("Not a payment request") });
  });

  it("items announced while the storage is off cannot be fetched: the contact is told the address expired", async () => {
    const { a, b, look, holdText } = setup();
    await holdText("m1", "one"); await holdText("m2", "two");
    a.storageOn = false;
    await a.engine.forget("link-a", "m2");
    await look(b);
    expect(b.received).toEqual([]);
    expect(b.engine.view("link-b")!.error).toMatch(/address expired/);
  });

  it("an older pointer replayed by a relay changes nothing", async () => {
    const { a, b, transport, look, holdText } = setup();
    await holdText("m1", "one");
    const key = [...transport.packets.keys()][0];
    const old = transport.packets.get(key)!;
    await holdText("m2", "two");
    await look(b);
    expect(b.received).toHaveLength(2);
    transport.packets.set(key, old);
    await look(b);
    expect(b.received).toHaveLength(2);
    expect(b.stored.hold!.inSeq).toBe(2);
    void a;
  });

  it("a contact saying it holds items makes this side look at once; an acknowledgement read twice settles once", async () => {
    const { a, b, look, holdText } = setup();
    await look(b);
    await holdText("m1", "one");
    await b.engine.peerSaid("link-b", { peerAllows: true, peerTop: 1 });
    await vi.waitFor(() => expect(b.received).toHaveLength(1));
    await vi.waitFor(() => expect(b.stored.hold!.inSeq).toBe(1));
    await look(a);
    expect(a.delivery.get("m1")?.state).toBe("delivered");
    a.delivery.clear();
    await look(a);
    expect(a.delivery.size).toBe(0);
    // A fresh device that knows nothing of the old acknowledgement takes it in without delivering anything again.
    a.stored = { ...a.stored, hold: { ...a.stored.hold!, peerAck: 0 } };
    await look(a);
    expect(a.stored.hold!.peerAck).toBe(1);
    expect(a.delivery.size).toBe(0);
  });
});
