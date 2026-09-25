import { expect, it, vi } from "vitest";
import { rankTransports, relayedTransports, TRANSPORTS, type PairedTransport, type TransportDescriptors } from "../src/pairedTransports";
import { TransportSwitch, type TransportPolicy } from "../src/transportSwitch";
// covers: transport.relayed, transport.preference, transport.switch

const desktop = { id: "a".repeat(64), relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.168.0.2:4000"] };
const browser = { id: "b".repeat(64), relay: "https://use1-1.relay.n0.iroh.link/", addresses: [], relayed: true };

it("calls a transport relayed when either side's descriptor is relay only", () => {
  expect(relayedTransports({ "iroh/1": desktop }, { "iroh/1": desktop })).toEqual([]);
  expect(relayedTransports({ "iroh/1": desktop }, { "iroh/1": browser })).toEqual(["iroh/1"]);
  expect(relayedTransports({ "iroh/1": browser }, { "iroh/1": desktop })).toEqual(["iroh/1"]);
  // An Iroh descriptor with no direct address is relayed even without the flag (an older browser build).
  expect(relayedTransports({ "iroh/1": { ...browser, relayed: undefined } }, {})).toEqual(["iroh/1"]);
  // Any transport can say so, e.g. HyperDHT reached through a DHT relay.
  expect(relayedTransports({}, { "hyperdht/1": { publicKey: "c".repeat(64), relayed: true } })).toEqual(["hyperdht/1"]);
  // What a contact cannot prove is not trusted to demote anything: junk is just not relayed.
  expect(relayedTransports({ "iroh/1": "iroh" }, { "hyperdht/1": null, "iroh/1": { relayed: "yes" } } as TransportDescriptors)).toEqual([]);
});

it("ranks a relayed transport after every direct one, the same from both sides", () => {
  // Without the flag a tie goes to the fixed order (Iroh first); relayed, WebRTC wins.
  expect(rankTransports(["webrtc/1", "iroh/1"], ["iroh/1", "webrtc/1"])).toEqual(["iroh/1", "webrtc/1"]);
  expect(rankTransports(["webrtc/1", "iroh/1"], ["iroh/1", "webrtc/1"], ["iroh/1"])).toEqual(["webrtc/1", "iroh/1"]);
  // Even a side that put Iroh first gets the direct path first.
  expect(rankTransports(["iroh/1", "webrtc/1"], ["iroh/1", "webrtc/1"], ["iroh/1"])).toEqual(["webrtc/1", "iroh/1"]);
  // Between direct transports the rank sum still decides.
  expect(rankTransports(["hyperdht/1", "iroh/1", "webrtc/1"], ["hyperdht/1", "webrtc/1", "iroh/1"], ["iroh/1"])).toEqual(["hyperdht/1", "webrtc/1", "iroh/1"]);
  // The only common transport is used, relayed or not.
  expect(rankTransports(["iroh/1"], ["iroh/1", "hyperdht/1"], ["iroh/1"])).toEqual(["iroh/1"]);

  const orders = (list: readonly PairedTransport[]): PairedTransport[][] => list.length <= 1 ? [[...list]]
    : list.flatMap((t, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [t, ...rest]));
  for (const relayed of [[], ["iroh/1"], ["hyperdht/1"], ["iroh/1", "hyperdht/1"]])
    for (const a of orders(TRANSPORTS)) for (const b of orders(TRANSPORTS)) {
      const ranked = rankTransports(a, b, relayed);
      expect(rankTransports(b, a, relayed)).toEqual(ranked);
      const direct = ranked.filter(t => !relayed.includes(t));
      expect(ranked.slice(0, direct.length)).toEqual(direct);
    }
});

function peers(actual: PairedTransport) {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [
    { preferred: "webrtc/1", fallback: true, available: ["webrtc/1", "iroh/1"], descriptors: { "iroh/1": browser } },
    { preferred: "webrtc/1", fallback: true, available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": desktop, "hyperdht/1": "hyper" } },
  ];
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const prepare = [vi.fn(), vi.fn()], kept = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1 - i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({ side: 1 - i, frame: frame as Record<string, unknown> }),
    peer: vi.fn(), state: vi.fn(), prepare: prepare[i], cancel: vi.fn(), kept: kept[i], timeoutMs: 100 }));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const { side, frame } = queue.shift()!; switches[side].handle(frame); } };
  switches.forEach(s => s.begin("session-1", actual)); flush();
  return { policies, prepare, kept, switches, flush };
}

it("keeps a direct WebRTC session when a relayed Iroh is also available", () => {
  const h = peers("webrtc/1");
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.prepare.every(p => !p.mock.calls.length)).toBe(true);
  h.switches.forEach(s => s.stop());
});

it("keeps a relayed session where it is while live: no probing for WebRTC (WISP 100)", () => {
  const h = peers("iroh/1");
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.prepare.every(p => !p.mock.calls.length)).toBe(true);
  h.switches.forEach(s => s.stop());
});

it("puts the relayed transport last among a switch's fallbacks", () => {
  const h = peers("webrtc/1");
  h.policies[0].available = ["webrtc/1", "iroh/1", "hyperdht/1"];
  h.policies[0].descriptors = { "iroh/1": browser, "hyperdht/1": "hyper" };
  h.switches[0].changed(false); h.flush();
  h.policies[1].preferred = "hyperdht/1"; h.switches[1].changed(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["hyperdht/1", "webrtc/1", "iroh/1"] }), true);
  h.switches.forEach(s => s.stop());
});

it("lets an explicit choice of the relayed transport stand", () => {
  const h = peers("webrtc/1");
  h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["iroh/1", "webrtc/1"] }), true);
  h.switches.forEach(s => s.begin("session-2", "iroh/1", true)); h.flush();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  expect(h.prepare[0]).toHaveBeenCalledTimes(1);
  h.switches.forEach(s => s.stop());
});
