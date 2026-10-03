import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { DHT_FILE_REFUSED, DHT_FILE_TOO_LARGE, DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { dhtFileElements, dhtFileId, readDhtFile, type DhtFileAnnouncement } from "../src/dhtFiles";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import type { PairingCredentials } from "../src/pairedSession";
// covers: chat.dht.files

/**
 * A file's offer on the DHT floor (WISP 403 § Files): the sixteenth element `[wire id, size, type, meta]` beside the
 * file's name as the envelope's text, under the id its wire id gives, to a contact whose record lists `dht-file/1`.
 */

type Got = { id: string; text: string; timestamp: number; file?: DhtFileAnnouncement; reply?: { i: string }; forwarded?: number };

function setup(options: { acceptsFile?: [boolean, boolean]; state?: [DhtDeliveryState?, DhtDeliveryState?] } = {}) {
  const link = createLink(), params = [link.mine, link.invite];
  const packets = new Map<string, SignedPacket>();
  const saved: DhtDeliveryState[] = [options.state?.[0] ?? emptyDhtDeliveryState(), options.state?.[1] ?? emptyDhtDeliveryState()];
  const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
  const got: Got[][] = [[], []];
  const receipts: string[][] = [[], []];
  const publish = vi.fn(async (identity, records) => {
    const wire = createRelayPayload(identity, records);
    expect(wire.length).toBeLessThanOrEqual(1072);
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, wire));
  });
  const resolve = vi.fn(async key => packets.get(key) ?? null);
  const make = (i: number) => new DhtDelivery({
    params: params[i], mode: "dht", state: saved[i], credentials: credentials[i],
    transport: { publish, resolve, describe: () => ({ protocol: "signed-packet fixture", relays: [] }) },
    save: async state => { saved[i] = structuredClone(state); },
    pin: async key => { credentials[i].peerKey = key; },
    message: async m => { got[i].push(m); }, receipt: async id => { receipts[i].push(id); }, changed: () => {}, pollMs: 100,
    peerAcceptsFile: () => options.acceptsFile?.[i] ?? true,
  });
  return { make, got, receipts, saved, publish, credentials };
}
afterEach(() => vi.useRealTimers());
vi.setConfig({ testTimeout: 30_000 });

const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);

describe("a file's offer on the DHT floor", () => {
  it("rides as the sixteenth element: the reader gets the file beside its name, and receipts the id its wire id gives", async () => {
    vi.useFakeTimers(); const h = setup();
    const a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
    const at = Date.now();
    expect(await a.announceFile({ wireId: "Wd9fK2pQx7Lm", name: "beach.jpg", size: 2_345_678, mime: "image/jpeg", image: { width: 4032, height: 3024 } }, at, "abcdefghijklmnopqrstuv", 2)).toBeNull();
    expect(a.pendingId).toBe(dhtFileId("Wd9fK2pQx7Lm"));
    expect(h.saved[0].pending?.file).toEqual(["Wd9fK2pQx7Lm", 2_345_678, "image/jpeg", { image: { width: 4032, height: 3024 } }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.got[1]).toEqual([expect.objectContaining({ id: dhtFileId("Wd9fK2pQx7Lm"), text: "beach.jpg", timestamp: at, reply: { i: "abcdefghijklmnopqrstuv" }, forwarded: 2,
      file: { wireId: "Wd9fK2pQx7Lm", name: "beach.jpg", size: 2_345_678, mime: "image/jpeg", image: { width: 4032, height: 3024 } } })]);
    // The receipt frees the floor for the next text, as a text's does.
    expect(h.receipts[0]).toContain(dhtFileId("Wd9fK2pQx7Lm"));
    expect(a.pendingId).toBeUndefined();
    await a.stop(); await b.stop();
  });

  it("a voice note's waveform is thinned when the whole one does not fit; a name the floor cannot carry is refused", async () => {
    vi.useFakeTimers(); const h = setup();
    const a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
    const name = "voice-2026-10-03.webm";
    expect(await a.announceFile({ wireId: "voice-000001", name, size: 120_000, mime: "audio/webm", voice: { duration: 9_000, peaks } }, Date.now())).toBeNull();
    const said = h.saved[0].pending!.file![3]!.voice!;
    expect(said.duration).toBe(9_000);
    expect(said.peaks.length).toBeLessThan(64);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.got[1][0].file?.voice).toEqual(said);
    // 256 bytes of name leave no room for the rest of the offer: it waits for the live session.
    expect(await a.announceFile({ wireId: "long-0000001", name: "n".repeat(256), size: 1, mime: "text/plain" }, Date.now())).toBe(DHT_FILE_TOO_LARGE);
    await a.stop(); await b.stop();
  });

  it("takes the floor's one slot: a text waits for its receipt, and the offer is not said to an app that does not take it", async () => {
    vi.useFakeTimers(); const h = setup({ acceptsFile: [false, true] });
    const a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
    // An older contact (no dht-file/1 in its record): nothing goes, the file waits for live.
    expect(a.fileError({ wireId: "older-000001", name: "a.txt", size: 1, mime: "text/plain" }, Date.now())).toBe(DHT_FILE_REFUSED);
    expect(await a.announceFile({ wireId: "older-000001", name: "a.txt", size: 1, mime: "text/plain" }, Date.now())).toBe(DHT_FILE_REFUSED);
    expect(h.saved[0].pending).toBeUndefined();
    const c = setup(), x = c.make(0), y = c.make(1);
    await x.start(); await y.start(); await vi.advanceTimersByTimeAsync(4_500);
    expect(await x.announceFile({ wireId: "slot-0000001", name: "a.txt", size: 1, mime: "text/plain" }, Date.now())).toBeNull();
    expect(x.validate("after the file", Date.now(), "abcdefghijklmnopqrstuv")).toMatch(/One DHT text/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(x.validate("after the file", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
    await a.stop(); await b.stop(); await x.stop(); await y.stop();
  });

  it("an offer that does not hold is dropped, never shown as a text, and still receipted", async () => {
    vi.useFakeTimers(); const h = setup();
    const first = h.make(0), b = h.make(1);
    await first.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
    await first.stop();
    // Started again with an envelope whose id is not the one its wire id gives.
    const now = Date.now(), id = "q".repeat(22);
    h.saved[0] = { ...h.saved[0], pending: { message: [id, now, "x.txt"], expires: now + 300_000, attempts: 0, next: now, file: ["zzzzzzzzzzzz", 10, "text/plain", null] } };
    const a = h.make(0);
    await a.start(); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.got[1]).toEqual([]);
    expect(h.receipts[0]).toContain(id);
    await a.stop(); await b.stop();
  });
});

describe("the sixteenth element as a reader takes it", () => {
  const message = (wireId: string, name = "a.bin"): [string, number, string] => [dhtFileId(wireId), 1, name];
  it("checks the id, the size and the type, and keeps only the meta that holds for the type", () => {
    expect(readDhtFile(["wire-0000001", 10, "image/png", { image: { width: 2, height: 3 } }], message("wire-0000001"))).toEqual({ wireId: "wire-0000001", name: "a.bin", size: 10, mime: "image/png", image: { width: 2, height: 3 } });
    // A voice note's meta on a picture is dropped; the file stays.
    expect(readDhtFile(["wire-0000001", 10, "image/png", { voice: { duration: 1, peaks: [1] } }], message("wire-0000001"))).toEqual({ wireId: "wire-0000001", name: "a.bin", size: 10, mime: "image/png" });
    for (const bad of [["wire-0000001", -1, "a/b", null], ["wire-0000001", 1.5, "a/b", null], ["short", 1, "a/b", null], ["wire-0000001", 1, "a/b"], "x", ["wire-0000001", 1, 5, null]])
      expect(readDhtFile(bad, message("wire-0000001"))).toBeNull();
    expect(readDhtFile(["wire-0000001", 1, "a/b", null], message("wire-0000002"))).toBeNull();
    // A name that would be a path is shown as a name.
    expect(readDhtFile(["wire-0000001", 1, "a/b", null], message("wire-0000001", "../etc/passwd"))?.name).toBe("etcpasswd");
  });
  it("a sender tries the whole meta first, then a thinner waveform, then none; a video's poster never", () => {
    const voice = dhtFileElements({ wireId: "w-000000001", name: "v.webm", size: 1, mime: "audio/webm", voice: { duration: 5, peaks } });
    expect(voice.map(e => e[3]?.voice?.peaks.length ?? 0)).toEqual([64, 32, 16, 8, 0]);
    const video = dhtFileElements({ wireId: "w-000000001", name: "v.mp4", size: 1, mime: "video/mp4", video: { duration: 5, width: 4, height: 3, poster: "AAAA" } });
    expect(video[0][3]).toEqual({ video: { duration: 5, width: 4, height: 3 } });
  });
});
