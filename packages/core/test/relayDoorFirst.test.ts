import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { setLinkTraceSink } from "../src/linkTrace";
import { createRelayPayload } from "../src/pkarr";
import { RelayTransport, REQUESTS_PER_MINUTE } from "../src/relay";
import { withRequestOptions } from "../src/transport";

// covers: core.relay-client, groups.community.join

/**
 * A community door whose edges watch the members that had just left, and offer to them (CLI lab, 2026-11-17: joiners let
 * in one after the other, each stopped right after). Those edges spent each relay's minute, and the door's read of its
 * knock bell, held back, answered the bell as it was before the knock, 3 to 6 times in a row: a joiner waited 18 to
 * 23 s to be let in, 5 link joins in 24. Relays kept in memory, three of them as in the default list; fake time.
 */

const NOW = 1_800_000_000_000;
const RELAYS = ["https://a.test", "https://b.test", "https://c.test"];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { setLinkTraceSink(null); vi.useRealTimers(); });

/** Relays kept in memory, one store behind the three names, and a door's transport over them (its groups' side). */
function door() {
  const stored = new Map<string, Uint8Array>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    if (init?.method === "PUT") { stored.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const body = stored.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const relay = new RelayTransport({ relays: RELAYS, log: () => {}, fetch: fetchFn });
  const group = withRequestOptions(relay, { group: true });
  const bell = createIdentity(), beacon = createIdentity(), lobby = createIdentity();
  const away = Array.from({ length: 4 }, () => createIdentity()), edges = Array.from({ length: 4 }, () => createIdentity());
  for (const id of [...away, beacon, lobby]) stored.set(id.pubKeyZ32, createRelayPayload(id, [{ label: "_ts", value: "1" }], 1n));
  /** A joiner knocks: a newer packet under the bell's key. */
  const knock = (n: number) => stored.set(bell.pubKeyZ32, createRelayPayload(bell, [{ label: "k", value: String(n) }], BigInt(n + 1) * 1_000_000n));
  knock(0);
  /** What a door's edges and its community ask for at second `t` of the run, as the lab's tally of each relay's minute. */
  const traffic = async (t: number) => {
    // Each edge watches its member that left, every 2 s (`WATCH_SHARE` keeps them to a third of the minute).
    if (t % 2_000 === 0) for (const id of away) await group.resolve(id.pubKeyZ32, { urgent: true, watch: true }).catch(() => {});
    // Their offers, presence and other writes; a plain read and a read for an answer now and then.
    if (t % 10_000 === 0) await group.publish(edges[(t / 10_000) % 4], [{ label: "_ts", value: String(t) }], { signal: true }).catch(() => {});
    if (t % 15_000 === 0) await group.publish(edges[(t / 15_000 + 1) % 4], [{ label: "_ts", value: String(t) }], { watch: true }).catch(() => {});
    if (t % 20_000 === 5_000) await group.publish(edges[Math.floor(t / 20_000) % 4], [{ label: "_ts", value: String(t) }]).catch(() => {});
    if (t % 10_000 === 2_500) await group.resolve(away[Math.floor(t / 10_000) % 4].pubKeyZ32).catch(() => {});
    if (t % 30_000 === 7_500) await group.resolve(away[Math.floor(t / 30_000) % 4].pubKeyZ32, { urgent: true, signal: true }).catch(() => {});
    // The hub's own community looks: its beacon and lobby read every 10 s, its beacon entry written every 30 s.
    if (t % 10_000 === 0) await group.resolve(beacon.pubKeyZ32, { background: true, door: true }).catch(() => {});
    if (t % 10_000 === 5_000) await group.resolve(lobby.pubKeyZ32, { background: true, door: true }).catch(() => {});
    if (t % 30_000 === 0) await group.publish(beacon, [{ label: "_ts", value: String(t) }], { background: true, door: true }).catch(() => {});
  };
  /** The door's read of its bell (`answerKnocks`): the knock it shows, or null when the read failed. */
  const readBell = async () => {
    const packet = await group.resolve(bell.pubKeyZ32, { background: true, door: true }).catch(() => null);
    return packet ? Number(packet.records.find((r) => r.label === "k")?.value) : null;
  };
  return { relay, bell, knock, traffic, readBell };
}

describe("relay transport: a community door's reads while its edges watch members that left", () => {
  it("reads the bell within a few seconds of each knock", async () => {
    const { knock, traffic, readBell } = door();
    const start = Date.now(), delays: number[] = [];
    let knocks = 0, knockedAt: number | null = null, nextKnock = start + 120_000;
    for (let t = 0; t < 12 * 60_000; t += 500) {
      if (t) await vi.advanceTimersByTimeAsync(500);
      const now = Date.now();
      // A joiner knocks every 13 to 17 s once the edges have watched for 2 minutes.
      if (knockedAt === null && now >= nextKnock) { knock(++knocks); knockedAt = now; }
      await traffic(t);
      // The door reads its bell every 4 s (`knockPollMs`).
      if (t % 4_000 === 0 && (await readBell()) === knocks && knockedAt !== null) {
        delays.push(now - knockedAt);
        knockedAt = null; nextKnock = now + 13_000 + (delays.length * 1_300) % 4_000;
      }
    }
    const sorted = [...delays].sort((a, b) => a - b);
    // Before, the edges took each request the minute freed, and the bell read went out only when its own ask came first:
    // knocks seen up to 37 s late (26 s at the 90th percentile), 24 in the 10 minutes. Now 11 s at most, 9 s at the 90th
    // percentile, 31 knocks: the bell is read every 4 s, and a request frees on each relay every 2 s or so.
    expect(sorted[sorted.length - 1]).toBeLessThanOrEqual(12_000);
    expect(sorted[Math.floor(sorted.length * 0.9)]).toBeLessThanOrEqual(10_000);
    expect(delays.length).toBeGreaterThanOrEqual(30);
  });

  it("says a bell read the budget held back was held, and who spent the minute", async () => {
    const lines: Record<string, unknown>[] = [];
    setLinkTraceSink((line) => lines.push(JSON.parse(line)));
    const { relay, bell, knock, traffic, readBell } = door();
    // The bell as the door last read it; then a minute of the edges' traffic, every relay's minute spent.
    expect(await readBell()).toBe(0);
    for (let t = 0; t < 60_000; t += 500) { await vi.advanceTimersByTimeAsync(500); await traffic(t); }
    knock(1);
    let held: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !held; i++) {
      lines.length = 0;
      const shown = await readBell();
      held = lines.find((l) => l.step === "read.held" && l.me === bell.pubKeyZ32.slice(0, 6));
      // A read held back answers the bell as it was (the packet already known), and says so.
      if (held) { expect(shown).toBe(0); expect(relay.readHeldBackFor(bell.pubKeyZ32)).toBeGreaterThan(0); }
      else await vi.advanceTimersByTimeAsync(250);
    }
    expect(held).toMatchObject({ as: "read background door", known: true });
    // Per relay, what spent its last minute, the edges' watch reads among it.
    const spent = held!.spent as { n: number; by: Record<string, number>; top: [string, number][] }[];
    expect(spent).toHaveLength(RELAYS.length);
    expect(Math.max(...spent.map((s) => s.n))).toBeGreaterThanOrEqual(REQUESTS_PER_MINUTE);
    expect(spent.some((s) => (s.by["read group urgent watch"] ?? 0) > 0)).toBe(true);
  });
});
