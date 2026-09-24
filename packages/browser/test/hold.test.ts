import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink, createRelayPayload, parseRelayPayload, HOLD_LIMITS, type PaymentRequest, type PkarrTransport, type SignedPacket } from "@ghostly/core";
import { HoldEngine, emptyHoldState, type HoldHost } from "../src/engine/hold";
import { presignS3 } from "../src/backup/s3";
import type { HoldStore, StoredBackup } from "../src/backup/storage";
import type { HoldState, StoredLink } from "../src/shared/types";

/**
 * A bucket in memory that hands out presigned addresses the way S3 does, and a relay in memory: two
 * engines, Alice holding for Bob and Bob picking up, with nothing but these between them.
 */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const store: HoldStore & { objects: typeof objects; tamper(name: string): void } = {
    objects,
    description: "S3 · test",
    async put(name, bytes) { objects.set(name, bytes.slice()); },
    async get(name) { const bytes = objects.get(name); if (!bytes) throw new Error("S3 refused (404 NoSuchKey)"); return bytes; },
    async list() { return []; },
    async listFolder(space, mailbox): Promise<StoredBackup[]> { return [...objects.keys()].filter((k) => k.startsWith(`${space}/hold/${mailbox}/`)).map((name) => ({ name, created: 0 })); },
    async remove(name) { objects.delete(name); },
    presign: (name, seconds) => presignS3({ method: "GET", url: new URL(`https://s3.test/bucket/${name}`), expiresSeconds: seconds }, { region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" }),
    tamper(name) { const bytes = objects.get(name)!; bytes[bytes.length - 2] ^= 0x01; },
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.host !== "s3.test" || !url.searchParams.get("X-Amz-Signature")) return new Response("forbidden", { status: 403 });
    const bytes = objects.get(decodeURIComponent(url.pathname.replace(/^\/bucket\//, "")));
    return bytes ? new Response(bytes.slice() as BodyInit, { headers: { "content-length": String(bytes.length) } }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { store, fetcher };
}

function relay(): PkarrTransport & { packets: Map<string, SignedPacket>; puts: number } {
  const packets = new Map<string, SignedPacket>();
  return {
    packets, puts: 0,
    async publish(identity, records) { this.puts++; packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records))); },
    async resolve(key) { return packets.get(key) ?? null; },
    describe: () => ({ protocol: "memory", relays: [] }),
  };
}

interface Side {
  engine: HoldEngine;
  stored: StoredLink;
  messages: Map<string, { text?: string; file?: { name: string; size: number; mime: string }; request?: PaymentRequest; timestamp: number }>;
  received: { kind: string; id: string; text?: string; name?: string; bytes?: Uint8Array; request?: PaymentRequest; timestamp: number }[];
  delivery: Map<string, { state: string; error?: string }>;
  files: Map<string, { bytes: Uint8Array; name: string; size: number; mime: string }>;
  requests: Map<string, PaymentRequest>;
  open: boolean;
  refuseFiles?: string;
}

export function setup(options: { aliceStorage?: boolean; bobStorage?: boolean; now?: () => number } = {}) {
  const link = createLink();
  const alice = createIdentity(), bob = createIdentity();
  const transport = relay();
  const buckets = { alice: bucket(), bob: bucket() };
  const make = (mine: StoredLink, storageOn: boolean, own: typeof buckets.alice, other: typeof buckets.alice): Side => {
    const side: Partial<Side> = { stored: mine, messages: new Map(), received: [], delivery: new Map(), files: new Map(), requests: new Map(), open: false };
    const host: HoldHost = {
      transport,
      storage: () => (storageOn ? { store: own.store, space: "abcdefghijklmnop" } : null),
      link: () => ({ stored: side.stored!, open: side.open! }),
      linkIds: () => [mine.id],
      saveHold: async (_id, hold) => { side.stored = { ...side.stored!, hold: structuredClone(hold) }; },
      delivery: async (_id, messageId, state, error) => { side.delivery!.set(messageId, { state, error }); },
      text: async (_id, messageId) => side.messages!.get(messageId)?.text ?? null,
      file: async (fileId) => side.files!.get(fileId) ?? null,
      paymentRequest: (paymentId) => side.requests!.get(paymentId) ?? null,
      receiveText: async (_id, m) => { side.received!.push({ kind: "text", id: m.id, text: m.text, timestamp: m.timestamp }); },
      receiveFile: async (_id, f, bytes) => { if (side.refuseFiles) return side.refuseFiles; side.received!.push({ kind: "file", id: f.wireId, name: f.name, bytes, timestamp: f.timestamp }); return null; },
      receivePaymentRequest: async (_id, request) => { side.received!.push({ kind: "pay-req", id: request.id, request, timestamp: request.timestamp }); },
      changed: () => {},
      // Bob reads Alice's bucket and Alice reads Bob's: each fetches from wherever the manifest points.
      fetch: other.fetcher,
      now: options.now,
    };
    side.engine = new HoldEngine(host);
    return side as Side;
  };
  const enabled: HoldState = { ...emptyHoldState(), enabled: true, peerAllows: true, peerPaymentMethods: ["cashu", "lightning"] };
  const a = make({ id: "link-a", ...link.mine, profile: "paired-chat/1", participationSeed: alice.seedB64, pairedPeerKey: bob.pubKeyZ32, createdAt: 0, hold: structuredClone(enabled) }, options.aliceStorage ?? true, buckets.alice, buckets.bob);
  const b = make({ id: "link-b", ...link.invite, profile: "paired-chat/1", participationSeed: bob.seedB64, pairedPeerKey: alice.pubKeyZ32, createdAt: 0, hold: structuredClone(enabled) }, options.bobStorage ?? false, buckets.bob, buckets.alice);
  return { a, b, transport, buckets };
}

const engines: HoldEngine[] = [];
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); vi.useRealTimers(); });

describe("store-and-forward engine", () => {
  it("holds text, a file and a payment request in order, the contact picks them up in order and the sender sees them delivered", async () => {
    const { a, b, buckets, transport } = setup();
    engines.push(a.engine, b.engine);
    a.messages.set("me_t1", { text: "first, while you were out", timestamp: 1000 });
    a.files.set("link-a-out-f1", { bytes: new Uint8Array(70_000).fill(7), name: "ghost.png", size: 70_000, mime: "image/png" });
    a.requests.set("p1", { id: "p1", timestamp: 3000, amount: { value: "21", asset: "sat" }, memo: "coffee", endpoints: [["cashu", '{"mints":["https://mint.test"]}']] });
    a.messages.set("me_2000", { file: { name: "ghost.png", size: 70_000, mime: "image/png" }, timestamp: 2000 });
    a.messages.set("me_3000", { request: a.requests.get("p1"), timestamp: 3000 });
    await a.engine.hold("link-a", { kind: "text", id: "wire-text-1", messageId: "me_t1", bytes: 25, timestamp: 1000 });
    await a.engine.hold("link-a", { kind: "file", id: "wire-file-1", messageId: "me_2000", ref: "link-a-out-f1", bytes: 70_000, timestamp: 2000 });
    await a.engine.hold("link-a", { kind: "pay-req", id: "p1", messageId: "me_3000", ref: "p1", bytes: 1024, timestamp: 3000 });
    expect([...a.delivery.values()].map((d) => d.state)).toEqual(["held", "held", "held"]);
    expect(a.stored.hold!.outSeq).toBe(3);
    expect(a.stored.hold!.outbox.map((e) => e.state)).toEqual(["held", "held", "held"]);
    // Ciphertext, in Alice's own bucket, under her mailbox for Bob; nothing readable.
    const names = [...buckets.alice.store.objects.keys()];
    expect(names).toHaveLength(4);
    expect(names.filter((n) => n.includes("/hold/")).length).toBe(4);
    for (const bytes of buckets.alice.store.objects.values()) expect(new TextDecoder("utf-8", { fatal: false }).decode(bytes)).not.toMatch(/first, while|ghost\.png|mint\.test|coffee/);
    expect(a.engine.view("link-a")).toMatchObject({ outstanding: 3, canHold: true, refused: 0 });
    // Nothing of it in the relay either, only Alice's pointer under a key of its own.
    expect(transport.packets.size).toBe(1);

    // Bob comes back: one look at Alice's pointer, then everything in order, and his acknowledgement goes up.
    b.engine.start();
    await vi.waitFor(() => expect(b.received).toHaveLength(3));
    expect(b.received.map((r) => r.kind)).toEqual(["text", "file", "pay-req"]);
    expect(b.received[0]).toMatchObject({ id: "wire-text-1", text: "first, while you were out", timestamp: 1000 });
    expect(b.received[1].bytes).toEqual(new Uint8Array(70_000).fill(7));
    expect(b.received[2].request).toMatchObject({ id: "p1", amount: { value: "21", asset: "sat" }, memo: "coffee" });
    expect(b.stored.hold!.inSeq).toBe(3);
    expect(transport.packets.size).toBe(2);
    // Alice reads Bob's pointer: delivered, and her bucket is empty again.
    a.engine.start();
    await vi.waitFor(() => expect([...a.delivery.values()].map((d) => d.state)).toEqual(["delivered", "delivered", "delivered"]));
    await vi.waitFor(() => expect(buckets.alice.store.objects.size).toBe(0));
    expect(a.stored.hold!.outbox).toEqual([]);
    expect(a.engine.view("link-a")).toMatchObject({ outstanding: 0, bytes: 0 });
    // A second look changes nothing: no duplicate, no new pointer.
    const puts = transport.puts;
    b.engine.wake("link-b");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.received).toHaveLength(3);
    expect(transport.puts).toBe(puts);
  });

  it("refuses a tampered item, keeps the rest, counts it, and survives a crash between store and acknowledgement", async () => {
    const { a, b, buckets } = setup();
    engines.push(a.engine, b.engine);
    a.messages.set("m1", { text: "one", timestamp: 1 }); a.messages.set("m2", { text: "two", timestamp: 2 }); a.messages.set("m3", { text: "three", timestamp: 3 });
    for (const [i, id] of ["m1", "m2", "m3"].entries()) await a.engine.hold("link-a", { kind: "text", id: `wire-${id}`, messageId: id, bytes: 5, timestamp: i + 1 });
    const second = a.stored.hold!.outbox[1].name;
    buckets.alice.store.tamper(second);
    b.engine.start();
    await vi.waitFor(() => expect(b.received.map((r) => r.text)).toEqual(["one", "three"]));
    expect(b.stored.hold!.refused).toBe(1);
    expect(b.stored.hold!.inSeq).toBe(3);
    expect(b.engine.view("link-b")?.error).toMatch(/Refused a held item/);
    // Alice learns Bob's acknowledgement covers all three: the tampered one is gone from her bucket too.
    a.engine.start();
    await vi.waitFor(() => expect(a.stored.hold!.outbox).toEqual([]));
    // Something Bob's app cannot keep (a file with no room) is refused and skipped the same way.
    a.messages.set("m4", { file: { name: "big", size: 3, mime: "a/b" }, timestamp: 4 });
    a.files.set("f4", { bytes: new Uint8Array(3), name: "big", size: 3, mime: "a/b" });
    b.refuseFiles = "no room for more files";
    await a.engine.hold("link-a", { kind: "file", id: "wire-m4", messageId: "m4", ref: "f4", bytes: 3, timestamp: 4 });
    b.engine.wake("link-b");
    await vi.waitFor(() => expect(b.stored.hold!.inSeq).toBe(4));
    expect(b.stored.hold!.refused).toBe(2);
  });

  it("stops holding at the quota, and fails an item that cannot be uploaded until it is retried", async () => {
    const { a, buckets } = setup();
    engines.push(a.engine);
    const put = buckets.alice.store.put;
    buckets.alice.store.put = async () => { throw new Error("S3 refused (503 SlowDown)"); };
    a.messages.set("m1", { text: "one", timestamp: 1 });
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-m1", messageId: "m1", bytes: 3, timestamp: 1 })).rejects.toThrow(/Could not store/);
    expect(a.delivery.get("m1")).toMatchObject({ state: "failed", error: expect.stringContaining("SlowDown") });
    expect(a.stored.hold!.outbox[0]).toMatchObject({ seq: 1, state: "failed" });
    buckets.alice.store.put = put;
    expect(await a.engine.retry("link-a", "m1")).toBe(true);
    expect(a.delivery.get("m1")?.state).toBe("held");
    expect(a.stored.hold!.outbox[0]).toMatchObject({ seq: 1, state: "held" });
    expect(await a.engine.retry("link-a", "unknown")).toBe(false);
    // Too large, too many, too much: refused before anything is chosen or stored.
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-big", messageId: "big", bytes: HOLD_LIMITS.maxBundleBytes, timestamp: 2 })).rejects.toThrow(/at most/);
    const many: HoldState = { ...a.stored.hold!, outbox: Array.from({ length: HOLD_LIMITS.maxMailboxBundles }, (_, i) => ({ ...a.stored.hold!.outbox[0], seq: i + 1, messageId: `x${i}` })) };
    a.stored = { ...a.stored, hold: many };
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-more", messageId: "more", bytes: 3, timestamp: 3 })).rejects.toThrow(/At most 64 items/);
    a.stored = { ...a.stored, hold: { ...a.stored.hold!, outbox: [{ ...a.stored.hold!.outbox[0], bytes: HOLD_LIMITS.maxMailboxBytes - 10 }] } };
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-fat", messageId: "fat", bytes: 100, timestamp: 4 })).rejects.toThrow(/would exceed/);
    expect(a.delivery.get("fat")?.state).toBe("failed");
  });

  it("drops an item nobody picked up after seven days, and the contact never sees it", async () => {
    let now = Date.parse("2026-09-23T00:00:00Z");
    const { a, b, buckets } = setup({ now: () => now });
    engines.push(a.engine, b.engine);
    a.messages.set("m1", { text: "stale", timestamp: now });
    await a.engine.hold("link-a", { kind: "text", id: "wire-m1", messageId: "m1", bytes: 5, timestamp: now });
    expect(buckets.alice.store.objects.size).toBe(2);
    vi.useFakeTimers({ now });
    a.engine.start();
    now += HOLD_LIMITS.ttlMs + 1000;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(a.delivery.get("m1")).toMatchObject({ state: "failed", error: expect.stringContaining("seven days") });
    expect(a.stored.hold!.outbox).toEqual([]);
    expect(buckets.alice.store.objects.size).toBe(0);
    vi.useRealTimers();
    b.engine.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(b.received).toEqual([]);
  });

  it("holds nothing without storage, without the contact's consent or before the contact is pinned", async () => {
    const { a } = setup({ aliceStorage: false });
    expect(a.engine.canHold("link-a")).toBe(false);
    expect(a.engine.view("link-a")).toMatchObject({ storage: false, canHold: false, enabled: true, peerAllows: true });
    a.messages.set("m1", { text: "one", timestamp: 1 });
    await expect(a.engine.hold("link-a", { kind: "text", id: "wire-m1", messageId: "m1", bytes: 3, timestamp: 1 })).rejects.toThrow(/S3 storage/);
    const { a: c } = setup();
    await c.engine.peerSaid("link-a", { peerAllows: false });
    expect(c.engine.canHold("link-a")).toBe(false);
    expect(c.engine.heldPaymentMethods("link-a")).toBeNull();
    await c.engine.peerSaid("link-a", { peerAllows: true });
    expect(c.engine.heldPaymentMethods("link-a")).toEqual(["cashu", "lightning"]);
    c.stored = { ...c.stored, pairedPeerKey: undefined };
    expect(c.engine.canHold("link-a")).toBe(false);
    expect(c.engine.keysFor("link-a")).toBeNull();
  });
});
