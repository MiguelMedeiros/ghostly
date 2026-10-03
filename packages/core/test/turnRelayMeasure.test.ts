import { describe, expect, it } from "vitest";
import { encodeTxtPacket, RelayTransport, classifyTurnRead, randomBytes, signRelayPayload, signTurnPacket, turnKeys, turnSequence, TOMBSTONE_SEQUENCE, type TurnKeys } from "../src/index";
import { devices, signerOf } from "./turnVectors";
// covers: devices.turn.read

/*
 * The measurement WISP 06 asks for (§ Measured, and still to measure): what a real Pkarr relay answers to a lower
 * packet, to a different packet at an equal sequence, to `If-Match`, and to a sequence that is not a timestamp.
 * Skipped unless a relay is named; never point it at a public relay (it puts under random keys, a dozen requests):
 *
 *   pkarr-relay --testnet            # the `pkarr-relay` crate built with `--features testnet`: its own DHT, port 15411
 *   GHOSTLY_TURN_RELAY=http://127.0.0.1:15411 npx vitest run test/turnRelayMeasure.test.ts
 *
 * It prints one line per experiment, and asserts only what the turn's safety rests on: a lower sequence is refused,
 * and the turn's own read and put work against the relay.
 */
const relay = process.env.GHOSTLY_TURN_RELAY?.replace(/\/+$/, "");
const all = devices();
const slots = all.map((device, i) => (i < 2 ? { key: device.publicKey, name: device.name } : null));
const packet = (keys: TurnKeys, turn: number, rev: number, author: number, instance = 1) =>
  signTurnPacket(keys, { turn, rev, author, active: author, slots, instance: new Uint8Array(8).fill(instance) }, signerOf(all[author]));

async function put(keys: TurnKeys, payload: Uint8Array, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${relay}/${keys.identity.pubKeyZ32}`, { method: "PUT", body: payload as BodyInit, headers });
  return `${response.status}${response.ok ? "" : ` ${(await response.text()).slice(0, 80)}`}`;
}
async function get(keys: TurnKeys, query = ""): Promise<{ status: number; body: Uint8Array; headers: Headers }> {
  const response = await fetch(`${relay}/${keys.identity.pubKeyZ32}${query}`, { cache: "no-store" });
  return { status: response.status, body: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const log = (what: string, result: string) => console.info(`[turn relay] ${what}: ${result}`);

describe.skipIf(!relay)("a real Pkarr relay and the turn record", () => {
  it("a sequence that is not a timestamp, a lower one, an equal one with other bytes, If-Match", { timeout: 120_000 }, async () => {
    const keys = turnKeys(randomBytes(32));
    const first = await packet(keys, 100, 0, 0), second = await packet(keys, 100, 1, 0);
    log("first put, sequence 100 * 2^20 (not a clock time)", await put(keys, first));
    const read = await get(keys);
    log("read back", `${read.status}, the same bytes: ${same(read.body, first)}`);
    expect(read.status).toBe(200);
    expect(same(read.body, first)).toBe(true);

    log("the same bytes again", await put(keys, first));
    log("If-Match naming the held sequence, a higher packet", await put(keys, second, { "If-Match": String(turnSequence(100, 0, 0)) }));
    const third = await packet(keys, 100, 2, 0);
    const mismatch = await put(keys, third, { "If-Match": "12345" });
    log("If-Match naming another sequence, a higher packet", mismatch);
    const after = await get(keys, "?policy=NetworkOnly");
    log("…and what the relay holds afterwards", same(after.body, third) ? "the new packet: If-Match was ignored" : same(after.body, second) ? "the old packet: If-Match was honoured" : `status ${after.status}`);
    log("If-None-Match: * while a packet is held, a higher packet", await put(keys, await packet(keys, 100, 3, 0), { "If-None-Match": "*" }));

    const lower = await put(keys, first);
    log("a lower sequence", lower);
    expect(lower.startsWith("2")).toBe(false);

    // A different packet at an equal sequence: two seals of one record, and two records with other instances.
    const twins = turnKeys(randomBytes(32));
    const a = await packet(twins, 200, 0, 0, 1), b = await packet(twins, 200, 0, 0, 2);
    const [low, high] = [a, b].sort((x, y) => { for (let i = 72; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    log("equal sequence, first the packet with the smaller encoded bytes", await put(twins, low));
    log("equal sequence, then the larger one", await put(twins, high));
    log("…held afterwards", same((await get(twins, "?policy=NetworkOnly")).body, high) ? "the larger" : "the smaller");
    const again = turnKeys(randomBytes(32));
    const c = await packet(again, 200, 0, 0, 1), d = await packet(again, 200, 0, 0, 2);
    const [low2, high2] = [c, d].sort((x, y) => { for (let i = 72; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    log("equal sequence, first the larger", await put(again, high2));
    log("equal sequence, then the smaller one", await put(again, low2));
    log("…held afterwards", same((await get(again, "?policy=NetworkOnly")).body, high2) ? "the larger" : "the smaller");

    // The highest sequences: the tombstone's, and what lies above 2^53.
    const top = turnKeys(randomBytes(32));
    const junk = (sequence: bigint) => signRelayPayload(top.identity, encodeTxtPacket([{ name: `_s.${top.identity.pubKeyZ32}`, value: "x", ttl: 300 }]), sequence);
    log("sequence 2^52 - 1 (a tombstone's)", await put(top, junk(BigInt(TOMBSTONE_SEQUENCE))));
    log("…read back", String((await get(top)).status));
    log("sequence 2^63 - 1", await put(top, junk(2n ** 63n - 1n)).catch((e: unknown) => String(e)));
    const none = await get(turnKeys(randomBytes(32)));
    log("a key nobody put", String(none.status));
    log("CORS on a GET", `access-control-allow-origin: ${read.headers.get("access-control-allow-origin")}, cache-control: ${read.headers.get("cache-control")}`);
  });

  it("the turn's own read and put against it: mine, a refusal reported, never a bare retry", { timeout: 60_000 }, async () => {
    const keys = turnKeys(randomBytes(32)), key = keys.identity.pubKeyZ32;
    const transport = new RelayTransport({ relays: [relay!] });
    const reader = (stored: Uint8Array | null) => ({ keys, ownKey: all[0].publicKey, stored });
    const empty = classifyTurnRead(reader(null), await transport.turnRead(key));
    expect(empty).toMatchObject({ result: "none", conditions: { [relay!]: null } });
    const mine = await packet(keys, 300, 0, 0);
    expect((await transport.turnPut(key, mine, empty.conditions))[0].outcome).toBe("stored");
    const back = classifyTurnRead(reader(mine), await transport.turnRead(key));
    expect(back.result).toBe("mine");
    // Another device takes the turn; this one's next record, conditional on what it read, is lower and refused.
    const theirs = await packet(keys, 301, 0, 1);
    expect((await transport.turnPut(key, theirs, back.conditions))[0].outcome).toBe("stored");
    const stale = await transport.turnPut(key, await packet(keys, 300, 1, 0), back.conditions);
    log("a stale device's next record after another took the turn", `${stale[0].outcome} (${stale[0].detail})`);
    expect(stale[0].outcome).toBe("refused");
    expect(classifyTurnRead(reader(mine), await transport.turnRead(key)).result).toBe("other");
  });
});

/*
 * The one question a local relay cannot answer: whether a relay run by someone else honours `If-Match`. Three
 * requests to the relay named, under one random key, with packets dated by the clock like any chat's:
 *
 *   GHOSTLY_TURN_RELAY_PROBE=https://pkarr.pubky.app npx vitest run test/turnRelayMeasure.test.ts
 */
const probe = process.env.GHOSTLY_TURN_RELAY_PROBE?.replace(/\/+$/, "");
describe.skipIf(!probe)("whether a relay honours If-Match (three requests)", () => {
  it("a higher packet whose If-Match names a sequence the relay does not hold", { timeout: 60_000 }, async () => {
    const identity = turnKeys(randomBytes(32)).identity;
    const dated = (at: bigint) => signRelayPayload(identity, encodeTxtPacket([{ name: `_s.${identity.pubKeyZ32}`, value: "x", ttl: 300 }]), at);
    const now = BigInt(Date.now()) * 1000n;
    const send = async (payload: Uint8Array, headers: Record<string, string> = {}) => {
      const response = await fetch(`${probe}/${identity.pubKeyZ32}`, { method: "PUT", body: payload as BodyInit, headers });
      return `${response.status}${response.ok ? "" : ` ${(await response.text()).slice(0, 80)}`}`;
    };
    log(`${probe}: first put`, await send(dated(now)));
    log(`${probe}: a higher packet, If-Match naming another sequence`, await send(dated(now + 1_000_000n), { "If-Match": "12345" }));
    const read = await fetch(`${probe}/${identity.pubKeyZ32}?policy=NetworkOnly`, { cache: "no-store" });
    log(`${probe}: GET ?policy=NetworkOnly`, `${read.status}, access-control-expose-headers: ${read.headers.get("access-control-expose-headers")}`);
  });
});
