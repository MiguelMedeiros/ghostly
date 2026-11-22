import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type Identity } from "../src/identity";
import { createRelayPayload, openRelayPayload, parseRelayPayload, PKARR_FUTURE_SKEW_MS, signRelayPayload, type GhostRecord } from "../src/pkarr";
import { RelayTransport } from "../src/relay";
// covers: core.relay-client, chat.paired.clock-behind

/**
 * Several people hold some keys this device writes under (a 1:1 link's keys derived from the invite, a group's lobby,
 * beacon and knock keys). A packet one of them dated far ahead must not set the date of this device's later packets:
 * dated past it, they were either refused by every relay (past 64 bits) or never taken by a reader that already had
 * a packet dated now.
 */
const NOW = 1_800_000_000_000;
const micros = (ms: number) => BigInt(ms) * 1000n;
const U64_MAX = (1n << 64n) - 1n;
const LIMIT = micros(NOW + PKARR_FUTURE_SKEW_MS);
const text = (value: string): GhostRecord[] => [{ label: "_ts", value, ttl: 300 }];

/** Relays as Pkarr's: 400 to a bad signature, the packet dated latest per key, 409 to one dated before it. */
function relays(hosts: string[]) {
  const held = new Map(hosts.map((host) => [host, new Map<string, Uint8Array>()]));
  const puts: { host: string; status: number; at: bigint }[] = [];
  const dated = (payload: Uint8Array) => new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0);
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), store = held.get(url.host)!;
    if (init?.method === "PUT") {
      const body = init.body as Uint8Array, known = store.get(key);
      let status: number;
      try { openRelayPayload(key, body); status = known && dated(body) < dated(known) ? 409 : 204; } catch { status = 400; }
      if (status === 204) store.set(key, body);
      puts.push({ host: url.host, status, at: dated(body) });
      return new Response(null, { status });
    }
    const packet = store.get(key);
    return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = () => new RelayTransport({ freshReadMs: 0, relays: hosts.map((h) => `https://${h}`), fetch: fetchFn });
  const at = (host: string, identity: Identity) => parseRelayPayload(identity.pubKeyZ32, held.get(host)!.get(identity.pubKeyZ32)!);
  /** Another holder of the key puts its own packet, dated as it likes, on the relays given. */
  const other = (identity: Identity, seq: bigint, on: string[]) => {
    for (const host of on) held.get(host)!.set(identity.pubKeyZ32, createRelayPayload(identity, text("pin"), seq));
  };
  return { transport, at, other, puts };
}

/** Reads the key from each relay in turn: the reader's answer after both. */
async function readBoth(reader: RelayTransport, key: Identity) {
  await reader.resolve(key.pubKeyZ32);
  return (await reader.resolve(key.pubKeyZ32))!.records[0].value;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("a packet another holder of the key dated far ahead", () => {
  it.each([["the largest 64-bit date", U64_MAX], ["ten years ahead", micros(NOW + 3650 * 86_400_000)]])("dated %s on one relay, it moves no date of this device: the other relay keeps taking its packets, and a reader takes them", async (_, ahead) => {
    const net = relays(["a.test", "b.test"]), key = createIdentity();
    const writer = net.transport(), reader = net.transport();
    await writer.publish(key, text("honest-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await readBoth(reader, key)).toBe("honest-1");
    net.other(key, ahead, ["a.test"]);
    // The writer reads the key too (a lobby read and written back), and learns the far date from a 409.
    await readBoth(writer, key);
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await writer.publish(key, text(`honest-${i}`));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(net.puts.filter((p) => p.status === 400)).toEqual([]);
    expect(net.puts.every((p) => p.at === ahead || p.at <= LIMIT)).toBe(true);
    expect(net.at("b.test", key).records[0].value).toBe("honest-4");
    expect(net.at("b.test", key).timestampMicros).toBeLessThanOrEqual(LIMIT);
    expect(await readBoth(reader, key)).toBe("honest-4");
  });

  it("held on every relay, a publish fails as a refusal (409) dated now, never as a bad packet, and a restart does the same", async () => {
    const net = relays(["a.test", "b.test"]), key = createIdentity();
    await net.transport().publish(key, text("honest-1"));
    net.other(key, U64_MAX, ["a.test", "b.test"]);
    for (const writer of [net.transport(), net.transport()]) {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(writer.publish(key, text("honest-2"))).rejects.toThrow(/responded 409/);
    }
    expect(net.puts.filter((p) => p.status !== 204).every((p) => p.status === 409 && p.at <= LIMIT)).toBe(true);
  });

  it("a date that does not fit in the packet's 64 bits is refused when signed, not wrapped to 0", () => {
    const key = createIdentity();
    expect(() => signRelayPayload(key, new Uint8Array(12), U64_MAX + 1n)).toThrow(RangeError);
    expect(() => signRelayPayload(key, new Uint8Array(12), -1n)).toThrow(RangeError);
    expect(openRelayPayload(key.pubKeyZ32, signRelayPayload(key, new Uint8Array(12), U64_MAX)).seq).toBe(U64_MAX);
  });
});
