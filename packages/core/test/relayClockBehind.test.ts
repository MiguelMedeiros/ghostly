import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type Identity } from "../src/identity";
import { createRelayPayload, parseRelayPayload, type GhostRecord } from "../src/pkarr";
import { emptyLinkRecords } from "../src/records";
import { RelayTransport } from "../src/relay";
// covers: core.relay-client, chat.paired.clock-behind

/**
 * A key is not always written by one device with one clock. An inviter warms the key it gives its contact with an empty
 * packet; a group's lobby, beacon and knock records are written by every member. A relay (and the DHT behind it) keeps
 * only the packet dated latest and answers 409 to one dated before it, so a device whose clock is behind the last
 * writer's could not write, or wrote and was never read, until its clock caught up.
 */
const NOW = 1_800_000_000_000;
const micros = (ms: number) => BigInt(ms) * 1000n;
const RECORDS: GhostRecord[] = [{ label: "_ts", value: "1", ttl: 300 }];

/** Relays as Pkarr's answer: the packet dated latest per key, 409 to one dated before it. */
function relays(hosts: string[]) {
  const held = new Map(hosts.map((host) => [host, new Map<string, Uint8Array>()]));
  const puts: { host: string; status: number; at: bigint }[] = [];
  const gets: string[] = [];
  const dated = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0);
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), store = held.get(url.host)!;
    if (init?.method === "PUT") {
      const body = init.body as Uint8Array, known = store.get(key);
      const status = known && dated(body) < dated(known) ? 409 : 204;
      if (status === 204) store.set(key, body);
      puts.push({ host: url.host, status, at: dated(body) });
      return new Response(null, { status });
    }
    gets.push(url.host);
    const packet = store.get(key);
    return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = () => new RelayTransport({ freshReadMs: 0, relays: hosts.map((h) => `https://${h}`), fetch: fetchFn });
  /** What a relay holds under a key, as a reader takes it. */
  const at = (host: string, identity: Identity) => { const p = held.get(host)!.get(identity.pubKeyZ32); return p ? parseRelayPayload(identity.pubKeyZ32, p) : null; };
  /** Another device's packet, dated by its own clock, put on the relays given. */
  const other = (identity: Identity, records: GhostRecord[], atMs: number, on = hosts) => { for (const host of on) held.get(host)!.set(identity.pubKeyZ32, createRelayPayload(identity, records, micros(atMs))); };
  return { transport, at, other, puts, gets };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("a packet under a key another clock dated", () => {
  it.each([["two minutes", 2 * 60_000], ["ten minutes", 10 * 60_000], ["an hour", 60 * 60_000]])("a joiner whose clock is %s behind its inviter's is read at its first packet, not once its clock catches up", async (_, behind) => {
    const net = relays(["a.test", "b.test"]), key = createIdentity();
    // The inviter warmed the key it gave its contact, dated by its own clock (as apps up to 1.0.1 do).
    net.other(key, emptyLinkRecords(), NOW + behind);
    const joiner = net.transport();
    await joiner.publish(key, RECORDS);
    await vi.advanceTimersByTimeAsync(0);
    for (const host of ["a.test", "b.test"]) {
      const held = net.at(host, key)!;
      expect(held.records.map((r) => r.value)).toEqual(["1"]);
      expect(held.timestampMicros).toBe(micros(NOW + behind) + 1n);
    }
    // Refused once on each relay, read on one of them, then taken by both.
    expect(net.puts.map((p) => p.status).sort()).toEqual([204, 204, 409, 409]);
    expect(net.gets).toHaveLength(1);
    // What it publishes next stays past it, with no relay refusing anything.
    await vi.advanceTimersByTimeAsync(5_000);
    await joiner.publish(key, RECORDS);
    expect(net.puts.filter((p) => p.status === 409)).toHaveLength(2);
    expect(net.at("a.test", key)!.timestampMicros).toBe(micros(NOW + behind) + 2n);
  });

  it("a relay that took the packet does not leave the other one's later-dated empty packet in place", async () => {
    const net = relays(["a.test", "b.test"]), key = createIdentity();
    // Only b.test has the inviter's warm packet: a.test takes the joiner's first packet, and the publication succeeds.
    net.other(key, emptyLinkRecords(), NOW + 2 * 60_000, ["b.test"]);
    const joiner = net.transport(), reader = net.transport();
    await joiner.publish(key, RECORDS);
    await vi.advanceTimersByTimeAsync(0);
    // A reader takes the packet dated latest of the two relays: it has to be the joiner's.
    for (let i = 0; i < 2; i++) await reader.resolve(key.pubKeyZ32);
    const seen = await reader.resolve(key.pubKeyZ32);
    expect(seen!.records.map((r) => r.value)).toEqual(["1"]);
    expect(net.at("b.test", key)!.records.map((r) => r.value)).toEqual(["1"]);
  });

  it("a record several devices write is dated past the one just read, with no refusal first", async () => {
    const net = relays(["a.test"]), lobby = createIdentity();
    // Another member, its clock ten minutes ahead, wrote the record last.
    net.other(lobby, RECORDS, NOW + 10 * 60_000);
    const member = net.transport();
    expect((await member.resolve(lobby.pubKeyZ32))!.timestampMicros).toBe(micros(NOW + 10 * 60_000));
    await member.publish(lobby, [{ label: "_ts", value: "2", ttl: 300 }]);
    expect(net.puts).toEqual([{ host: "a.test", status: 204, at: micros(NOW + 10 * 60_000) + 1n }]);
    expect(net.at("a.test", lobby)!.records[0].value).toBe("2");
  });

  it("a device whose clock was set back keeps writing: its next packet is dated past its own last one on the relay", async () => {
    const net = relays(["a.test"]), key = createIdentity();
    // An earlier run of this device, when its clock was five minutes ahead.
    net.other(key, RECORDS, NOW + 5 * 60_000);
    const device = net.transport();
    await device.publish(key, [{ label: "_ts", value: "2", ttl: 300 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.at("a.test", key)!.records[0].value).toBe("2");
  });

  it("dates by its own clock when nothing under the key is later", async () => {
    const net = relays(["a.test"]), key = createIdentity();
    net.other(key, emptyLinkRecords(), NOW - 24 * 60 * 60_000);
    const device = net.transport();
    await device.publish(key, RECORDS);
    expect(net.puts).toEqual([{ host: "a.test", status: 204, at: micros(NOW) }]);
    expect(net.gets).toEqual([]);
  });

  it("a 409 for a packet that is not dated before the relay's is a failure as before: nothing is published again", async () => {
    const key = createIdentity();
    const calls: string[] = [];
    // The relay is still putting an earlier packet of this key on the DHT, and says so with 409.
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return init?.method === "PUT" ? new Response(null, { status: 409 }) : new Response(createRelayPayload(key, emptyLinkRecords(), micros(NOW - 3_000)) as BodyInit);
    }) as typeof fetch;
    const device = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
    await expect(device.publish(key, RECORDS)).rejects.toThrow(/responded 409/);
    expect(calls).toEqual(["PUT", "GET"]);
  });

  it("goes past a later-dated packet once per publication: a relay that refuses again is a failure", async () => {
    const key = createIdentity();
    let puts = 0;
    // Each read finds a packet dated later still (another writer keeps writing): no loop.
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") { puts++; return new Response(null, { status: 409 }); }
      return new Response(createRelayPayload(key, emptyLinkRecords(), micros(NOW + puts * 60_000)) as BodyInit);
    }) as typeof fetch;
    const device = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn });
    await expect(device.publish(key, RECORDS)).rejects.toThrow(/responded 409/);
    expect(puts).toBe(2);
  });
});
