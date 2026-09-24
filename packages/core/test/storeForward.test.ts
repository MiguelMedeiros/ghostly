import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { utf8Encode, utf8Decode } from "../src/bytes";
import { createRelayPayload, parseRelayPayload } from "../src/pkarr";
import { HOLD_LIMITS, HoldKeys, HoldRefusedError, newHoldMailbox, readManifest, type HoldPointer } from "../src/storeForward";
import { PairedSession, type PairedSessionOptions } from "../src/pairedSession";
import { createChannelPair } from "./helpers";

/** Alice invited Bob; both pinned each other's participation key. */
function pairKeys() {
  const link = createLink();
  const alice = createIdentity(), bob = createIdentity();
  return {
    alice: new HoldKeys(link.mine, alice.seedB64, bob.pubKeyZ32),
    bob: new HoldKeys(link.invite, bob.seedB64, alice.pubKeyZ32),
    link, aliceSeed: alice.seedB64, bobSeed: bob.seedB64,
  };
}
const item = (mailbox: string, seq: number, over: Partial<{ kind: "text" | "file" | "pay-req" | "manifest"; meta: unknown; expires: number; ts: number; id: string }> = {}) =>
  ({ mailbox, seq, id: over.id ?? "abcdefghijklmnopqrstuv", ts: over.ts ?? Date.now(), kind: over.kind ?? "text" as const, meta: over.meta, expires: over.expires ?? Date.now() + HOLD_LIMITS.ttlMs });

describe("held bundles", () => {
  it("derives the same sealing key on both sides and different pointer keys per direction", () => {
    const { alice, bob } = pairKeys();
    expect(alice.peerAddress).toBe(bob.identity.pubKeyZ32);
    expect(bob.peerAddress).toBe(alice.identity.pubKeyZ32);
    expect(alice.identity.pubKeyZ32).not.toBe(bob.identity.pubKeyZ32);
    const bytes = alice.seal(item(newHoldMailbox(), 1), utf8Encode("held hello 🌙"));
    expect(utf8Decode(bob.open(bytes).body)).toBe("held hello 🌙");
    expect(new TextDecoder().decode(bytes)).not.toContain("held hello");
  });

  it("refuses a tampered, replayed-to-the-wrong-chat, resigned or oversized bundle, never partially", () => {
    const { alice, bob, link } = pairKeys();
    const mailbox = newHoldMailbox();
    const good = alice.seal(item(mailbox, 3, { kind: "file", meta: { name: "ghost.png", size: 5, mime: "image/png" } }), new Uint8Array([1, 2, 3, 4, 5]));
    const flipped = good.slice(); flipped[flipped.length - 3] ^= 0x40;
    expect(() => bob.open(flipped)).toThrow(HoldRefusedError);
    expect((() => { try { bob.open(flipped); } catch (e) { return (e as HoldRefusedError).reason; } })()).toBe("tampered");
    // The sender cannot open what it sealed: the header names the other direction.
    expect((() => { try { alice.open(good); } catch (e) { return (e as HoldRefusedError).reason; } })()).toBe("not-for-me");
    // Another contact of Bob's, with the same invite secret but its own participation key, is not Alice.
    const impostor = new HoldKeys(link.mine, createIdentity().seedB64, bob.me);
    const forged = impostor.seal(item(mailbox, 4), utf8Encode("from someone else"));
    expect(() => bob.open(forged)).toThrow(/changed|another/);
    expect(() => bob.open(good.subarray(0, 40))).toThrow(HoldRefusedError);
    expect(() => bob.open(good, { maxBytes: 10 })).toThrow(/larger/);
    expect(() => bob.open(good, { mailbox: newHoldMailbox() })).toThrow(/another mailbox/);
    // A file whose body disagrees with its description, or a text that is not text, is refused whole.
    expect(() => bob.open(alice.seal(item(mailbox, 5, { kind: "file", meta: { name: "x", size: 9, mime: "a/b" } }), new Uint8Array(3)))).toThrow(/does not match/);
    expect(() => bob.open(alice.seal(item(mailbox, 6), new Uint8Array([0xff, 0xfe])))).toThrow(/not text/);
    expect(() => bob.open(alice.seal(item(mailbox, 7), new Uint8Array(HOLD_LIMITS.maxTextBytes + 1)))).toThrow(/too long/);
    expect(() => bob.open(alice.seal(item(mailbox, 8, { expires: Date.now() + HOLD_LIMITS.ttlMs * 3 }), utf8Encode("x")))).toThrow(/lifetime/);
    expect(() => bob.open(alice.seal(item(mailbox, 9, { ts: Date.now() + 10 * 60_000 }), utf8Encode("x")))).toThrow(/future/);
    // What passed is exactly what was sealed.
    const opened = bob.open(good);
    expect(opened.header).toMatchObject({ seq: 3, kind: "file", author: alice.me, recipient: bob.me, mailbox, meta: { name: "ghost.png", size: 5, mime: "image/png" } });
    expect([...opened.body]).toEqual([1, 2, 3, 4, 5]);
  });

  it("checks a manifest's entries: increasing sequences, bounded sizes, fetchable addresses", () => {
    const entry = (seq: number, bytes = 10, url = "https://s3.example/b/o?X-Amz-Signature=1") => [seq, "abcdefgh", "text", bytes, url, Date.now() + 1000];
    expect(readManifest({ entries: [entry(1), entry(2)] })).toHaveLength(2);
    expect(() => readManifest({ entries: [entry(2), entry(2)] })).toThrow(/malformed/);
    expect(() => readManifest({ entries: [entry(1, HOLD_LIMITS.maxBundleBytes + 1)] })).toThrow(/malformed/);
    expect(() => readManifest({ entries: [entry(1, 10, "ftp://x/y")] })).toThrow(/malformed/);
    expect(() => readManifest({ entries: [entry(1, 10, "http://evil.example/o")] })).toThrow(/malformed/);
    expect(readManifest({ entries: [entry(1, 10, "http://127.0.0.1:46010/b/o")] })).toHaveLength(1);
    expect(() => readManifest({ entries: Array.from({ length: HOLD_LIMITS.maxMailboxBundles + 1 }, (_, i) => entry(i + 1)) })).toThrow(/too many/);
    expect(() => readManifest({ entries: Array.from({ length: 9 }, (_, i) => entry(i + 1, HOLD_LIMITS.maxBundleBytes)) })).toThrow(/more than a mailbox/);
    const { alice, bob } = pairKeys();
    const manifest = alice.seal(item(newHoldMailbox(), 0, { kind: "manifest", meta: { entries: [entry(1)] } }), new Uint8Array());
    expect(readManifest(bob.open(manifest).header.meta)).toHaveLength(1);
  });

  it("publishes a pointer that fits a DHT packet, reads it back only from the contact, and refuses forgeries", () => {
    const { alice, bob, link } = pairKeys();
    const pointer: HoldPointer = { rev: 7, issued: Date.now(), expires: Date.now() + HOLD_LIMITS.ttlMs, top: 12, ack: 3, count: 2, bytes: 4096,
      manifestUrl: `https://s3.eu-central-1.amazonaws.com/some-bucket/ghostly/abcdefghijklmnop/hold/${newHoldMailbox()}/manifest.ghostly-held?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260923%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20260923T120000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${"f".repeat(64)}` };
    const records = alice.pointerRecords(pointer);
    const wire = createRelayPayload(alice.identity, records);
    expect(wire.length).toBeLessThanOrEqual(1072);
    expect(new TextDecoder().decode(wire)).not.toContain("X-Amz-Signature");
    const packet = parseRelayPayload(alice.identity.pubKeyZ32, wire);
    expect(bob.readPointer(packet)).toEqual(pointer);
    // Alice's own pointer is not Bob's; a pointer under the wrong key, or signed by another key, is nothing.
    expect(alice.readPointer(packet)).toBeNull();
    const impostor = new HoldKeys(link.mine, createIdentity().seedB64, bob.me);
    expect(bob.readPointer(parseRelayPayload(impostor.identity.pubKeyZ32, createRelayPayload(impostor.identity, impostor.pointerRecords(pointer))))).toBeNull();
    expect(bob.readPointer(parseRelayPayload(alice.identity.pubKeyZ32, createRelayPayload(alice.identity, [{ label: "_hold", value: "not a pointer", ttl: 60 }])))).toBeNull();
    expect(() => alice.pointerRecords({ ...pointer, manifestUrl: `https://${"a".repeat(900)}/x` })).toThrow(/too long/);
  });
});

describe("hold/1 negotiation", () => {
  const active: PairedSession[] = [];
  afterEach(() => { active.splice(0).forEach(s => s.stop()); });
  const keys = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32] as [string, string];
  function pair(a: Partial<PairedSessionOptions>, b: Partial<PairedSessionOptions>) {
    const [ac, bc] = createChannelPair();
    const config = (): PairedSessionOptions => ({ credentials: { seedB64: createIdentity().seedB64 }, rendezvousKeys: keys, fingerprints: ["a".repeat(64), "b".repeat(64)],
      trustOnFirstUse: true, pinPeer: vi.fn(async () => {}), onState: vi.fn(), onReady: vi.fn(), onApplication: vi.fn(), onFailure: vi.fn() });
    const sa = new PairedSession(ac, { ...config(), ...a }), sb = new PairedSession(bc, { ...config(), ...b });
    active.push(sa, sb); sa.start(); sb.start();
    return [sa, sb] as const;
  }
  it.each([[false, false], [true, false], [false, true], [true, true]])("both must offer it (%s, %s); each side sees the other's offer on its own", async (a, b) => {
    const [sa, sb] = pair({ holdSupport: a }, { holdSupport: b });
    await vi.waitFor(() => { expect(sa.state.status).toBe("ready"); expect(sb.state.status).toBe("ready"); });
    expect(sa.supports("hold/1")).toBe(a && b);
    expect(sb.supports("hold/1")).toBe(a && b);
    expect(sa.peerHoldSupport).toBe(b);
    expect(sb.peerHoldSupport).toBe(a);
  });
  it("an offer without hold/1 (an older app) still pairs, files and payments unchanged", async () => {
    const [sa, sb] = pair({ holdSupport: true, filesSupport: true, paymentsSupport: true }, { filesSupport: true, paymentsSupport: true });
    await vi.waitFor(() => { expect(sa.state.status).toBe("ready"); expect(sb.state.status).toBe("ready"); });
    expect(sa.supports("files/2")).toBe(true);
    expect(sa.supports("payments/1")).toBe(true);
    expect(sa.supports("hold/1")).toBe(false);
    expect(sa.peerHoldSupport).toBe(false);
  });
});
