import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarriedTransport, createIdentity, createRelayPayload, parseRelayPayload, RelayTransport, type GhostRecord, type Identity } from "../src";
// covers: groups.protocol.signals, core.relay-client

/**
 * A group edge's offer and answer are packets signed by the edge (`CarriedTransport`) and put byte for byte on the
 * relays. A relay keeps the packet dated latest under a key and refuses (409) one dated at or before it, so a packet no
 * newer than the relay's copy is lost: the edge's contact reads the old offer, or none, until a later publish wins.
 */
const NOW = 1_800_000_000_000;
const micros = (ms: number) => BigInt(ms) * 1000n;
const offer = (value: string): GhostRecord[] => [{ label: "_rtc", value, ttl: 300 }];

/** Relays as Pkarr answers: the packet dated latest per key, 409 to another one dated at or before it. */
function relays(hosts: string[]) {
  const held = new Map(hosts.map((host) => [host, new Map<string, Uint8Array>()]));
  const puts: { host: string; status: number; at: bigint }[] = [];
  const gets: string[] = [];
  const dated = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0);
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), store = held.get(url.host)!;
    if (init?.method === "PUT") {
      const body = init.body as Uint8Array, known = store.get(key);
      const status = known && !same(body, known) && dated(body) <= dated(known) ? 409 : 204;
      if (status === 204) store.set(key, body);
      puts.push({ host: url.host, status, at: dated(body) });
      return new Response(null, { status });
    }
    gets.push(url.host);
    const packet = store.get(key);
    return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = () => new RelayTransport({ freshReadMs: 0, relays: hosts.map((h) => `https://${h}`), fetch: fetchFn });
  const at = (host: string, identity: Identity) => { const p = held.get(host)!.get(identity.pubKeyZ32); return p ? parseRelayPayload(identity.pubKeyZ32, p) : null; };
  const put = (host: string, identity: Identity, records: GhostRecord[], atMs: number) => held.get(host)!.set(identity.pubKeyZ32, createRelayPayload(identity, records, micros(atMs)));
  return { transport, at, put, puts, gets };
}

/** An edge whose packets no member can carry: each goes to the relays at once. */
const edge = (inner: RelayTransport, me: Identity, peer: Identity, after?: bigint) =>
  new CarriedTransport(inner, me.pubKeyZ32, peer.pubKeyZ32, { carry: () => ({ taken: 0, sure: false }), open: () => false, look: () => {}, after });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("a group edge's signal packets on relays that keep the latest", () => {
  it("an edge started again in the same millisecond leaves its newest offer on the relays", async () => {
    const net = relays(["a.test", "b.test"]), me = createIdentity(), peer = createIdentity(), inner = net.transport();
    const first = edge(inner, me, peer);
    await first.publish(me, offer("old"));
    // Its WebRTC gave up (`edgeWithoutRtc`): the edge starts again at once, with a transport of its own.
    first.stop();
    const again = edge(inner, me, peer, first.lastDated());
    await again.publish(me, offer("new"));
    await vi.advanceTimersByTimeAsync(0);
    for (const host of ["a.test", "b.test"]) expect(net.at(host, me)!.records[0].value).toBe("new");
    expect(net.puts.filter((p) => p.status === 409)).toEqual([]);
  });

  it("a newer offer refused (409) by a relay holding a later copy goes again at once, and the reader gets it", async () => {
    const net = relays(["a.test"]), me = createIdentity(), peer = createIdentity();
    // An earlier transport of this edge (an earlier run, a restart) left a packet dated past this clock.
    net.put("a.test", me, offer("old"), NOW + 2 * 60_000);
    const mine = edge(net.transport(), me, peer);
    await mine.publish(me, offer("new"));
    await vi.advanceTimersByTimeAsync(0);
    expect(net.puts.map((p) => p.status)).toEqual([409, 204]);
    expect(net.puts[1].at).toBe(micros(NOW + 2 * 60_000) + 1n);
    // No poll later: read now.
    const read = await net.transport().resolve(me.pubKeyZ32);
    expect(read!.records[0].value).toBe("new");
    // What it signs next stays past it, with no refusal.
    await mine.publish(me, offer("newer"));
    expect(net.puts.slice(2).map((p) => p.status)).toEqual([204]);
    expect(net.at("a.test", me)!.records[0].value).toBe("newer");
  });

  it("two copies at once in the same millisecond, on two relays: both end with the newest", async () => {
    const net = relays(["a.test", "b.test"]), me = createIdentity(), peer = createIdentity();
    // b.test still holds the last transport's packet of this very millisecond; a.test missed it.
    net.put("b.test", me, offer("old"), NOW);
    const mine = edge(net.transport(), me, peer);
    await mine.publish(me, offer("new"));
    await vi.advanceTimersByTimeAsync(0);
    for (const host of ["a.test", "b.test"]) expect(net.at(host, me)!.records[0].value).toBe("new");
  });

  it("a 409 of a packet a newer one replaced already puts nothing again", async () => {
    const net = relays(["a.test"]), me = createIdentity(), peer = createIdentity(), inner = net.transport();
    const mine = edge(inner, me, peer);
    await mine.publish(me, offer("one"));
    await mine.publish(me, offer("two"));
    // A late put of "one" refused: the relay holds "two", and "one" is not signed again past it.
    await inner.publishPayload(me.pubKeyZ32, createRelayPayload(me, offer("one"), micros(NOW)), { signedAt: micros(NOW), redate: () => { throw new Error("redated"); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(net.at("a.test", me)!.records[0].value).toBe("two");
  });

  it("goes again past a relay that keeps refusing three times at most: no loop", async () => {
    const me = createIdentity(), peer = createIdentity();
    let puts = 0;
    // Each read finds a copy dated later still.
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") { puts++; return new Response(null, { status: 409 }); }
      return new Response(createRelayPayload(me, offer("x"), micros(NOW + puts * 60_000)) as BodyInit);
    }) as typeof fetch;
    const mine = edge(new RelayTransport({ freshReadMs: 0, relays: ["https://a.test"], fetch: fetchFn }), me, peer);
    await expect(mine.publish(me, offer("new"))).rejects.toThrow(/responded 409/);
    expect(puts).toBe(3);
  });
});
