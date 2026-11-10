import { expect, it, vi } from "vitest";
import { automaticTransport, checkedDescriptors, dialableIrohRelay, rankTransports, relayUrl, relayedTransports, transportOrder, TRANSPORTS, type PairedTransport, type TransportDescriptors } from "../src/pairedTransports";
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

it("ranks a relayed transport after every direct one, Iroh through its relay excepted, the same from both sides", () => {
  // A relayed HyperDHT (a browser's, through a HyperDHT relay) goes after WebRTC even where both put it first.
  expect(rankTransports(["hyperdht/1", "webrtc/1"], ["hyperdht/1", "webrtc/1"], ["hyperdht/1"])).toEqual(["webrtc/1", "hyperdht/1"]);
  // Iroh through its relay keeps its place by the rank sum (WISP 100, revision 2026-11-08): a tie goes to the fixed
  // order (Iroh first), and two apps that put it first use it.
  expect(rankTransports(["webrtc/1", "iroh/1"], ["iroh/1", "webrtc/1"], ["iroh/1"])).toEqual(["iroh/1", "webrtc/1"]);
  expect(rankTransports(["iroh/1", "webrtc/1"], ["iroh/1", "webrtc/1"], ["iroh/1"])).toEqual(["iroh/1", "webrtc/1"]);
  // Where both put WebRTC first (an explicit choice on each side), WebRTC.
  expect(rankTransports(["webrtc/1", "iroh/1"], ["webrtc/1", "iroh/1"], ["iroh/1"])).toEqual(["webrtc/1", "iroh/1"]);
  // Between direct transports the rank sum still decides.
  expect(rankTransports(["hyperdht/1", "iroh/1", "webrtc/1"], ["hyperdht/1", "webrtc/1", "iroh/1"], ["hyperdht/1"])).toEqual(["iroh/1", "webrtc/1", "hyperdht/1"]);
  // The only common transport is used, relayed or not.
  expect(rankTransports(["hyperdht/1"], ["iroh/1", "hyperdht/1"], ["hyperdht/1"])).toEqual(["hyperdht/1"]);

  const orders = (list: readonly PairedTransport[]): PairedTransport[][] => list.length <= 1 ? [[...list]]
    : list.flatMap((t, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [t, ...rest]));
  for (const relayed of [[], ["iroh/1"], ["hyperdht/1"], ["iroh/1", "hyperdht/1"]])
    for (const a of orders(TRANSPORTS)) for (const b of orders(TRANSPORTS)) {
      const ranked = rankTransports(a, b, relayed);
      expect(rankTransports(b, a, relayed)).toEqual(ranked);
      // What is penalised (a relayed transport other than Iroh) comes last; Iroh is ranked as if direct.
      const penalised = (t: string) => t !== "iroh/1" && relayed.includes(t);
      expect(ranked.slice(0, ranked.filter(t => !penalised(t)).length)).toEqual(ranked.filter(t => !penalised(t)));
      expect(rankTransports(a, b, relayed.filter(t => t !== "iroh/1"))).toEqual(ranked);
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

it("puts a relayed HyperDHT last among a switch's fallbacks, and a relayed Iroh by its rank", () => {
  const h = peers("webrtc/1");
  h.policies[0].available = ["webrtc/1", "iroh/1", "hyperdht/1"];
  h.policies[0].descriptors = { "iroh/1": browser, "hyperdht/1": { publicKey: "c".repeat(64), relayed: true } };
  h.switches[0].changed(false); h.flush();
  h.policies[1].preferred = "iroh/1"; h.switches[1].changed(); h.flush();
  expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["iroh/1", "webrtc/1", "hyperdht/1"] }), true);
  h.switches.forEach(s => s.stop());
});

it("moves a session on Iroh through its relay, ranked first, to WebRTC on the session, nobody having chosen (`upgrade/1`)", () => {
  const policies: Omit<TransportPolicy, "revision" | "intent">[] = [
    { preferred: "iroh/1", fallback: true, available: ["webrtc/1", "iroh/1"], descriptors: { "iroh/1": browser } },
    { preferred: "iroh/1", fallback: true, available: ["webrtc/1", "iroh/1", "hyperdht/1"], descriptors: { "iroh/1": desktop } },
  ];
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const prepare = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1 - i),
    policy: () => structuredClone(policies[i]), send: frame => queue.push({ side: 1 - i, frame: frame as Record<string, unknown> }),
    peer: vi.fn(), state: vi.fn(), prepare: prepare[i], cancel: vi.fn(), upgrade: () => true, timeoutMs: 100 }));
  switches.forEach(s => s.begin("session-1", "iroh/1"));
  while (queue.length) { const { side, frame } = queue.shift()!; switches[side].handle(frame); }
  // Iroh ranks first (the way back after an absence), and the direct WebRTC is where the session goes once live.
  expect(prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["webrtc/1", "iroh/1"], upgrade: true }), true);
  expect(prepare[1]).toHaveBeenCalledWith(expect.objectContaining({ upgrade: true }), false);
  switches.forEach(s => s.stop());
});

/** Two web apps on Automatic, each policy as GhostLink makes it (`ownPreferred`): the app's rule for what runs now. */
function automaticWebPeers(fallback: [boolean, boolean], available: PairedTransport[][]) {
  const policy = (i: number): Omit<TransportPolicy, "revision" | "intent"> => ({ preferred: automaticTransport(available[i], fallback[i]),
    fallback: fallback[i], available: available[i], descriptors: available[i].includes("iroh/1") ? { "iroh/1": browser } : {} });
  const queue: { side: number; frame: Record<string, unknown> }[] = [];
  const prepare = [vi.fn(), vi.fn()], cancel = [vi.fn(), vi.fn()], kept = [vi.fn(), vi.fn()], unreached = [vi.fn(), vi.fn()], state = [vi.fn(), vi.fn()];
  const switches = [0, 1].map(i => new TransportSwitch({ key: String(i), peerKey: String(1 - i),
    policy: () => structuredClone(policy(i)), send: frame => queue.push({ side: 1 - i, frame: frame as Record<string, unknown> }),
    peer: vi.fn(), state: state[i], prepare: prepare[i], cancel: cancel[i], kept: kept[i], unreached: unreached[i], upgrade: () => true, timeoutMs: 100 }));
  const flush = () => { let steps = 0; while (queue.length) { if (++steps > 100) throw new Error("Negotiation loop"); const { side, frame } = queue.shift()!; switches[side].handle(frame); } };
  return { policy, prepare, cancel, kept, unreached, state, switches, flush };
}

it("on Automatic with Fallback off, offers WebRTC alone and leaves a WebRTC session there when the Iroh endpoint comes up", () => {
  const web: PairedTransport[] = ["webrtc/1", "iroh/1"];
  const available: PairedTransport[][] = [["webrtc/1"], web];
  const h = automaticWebPeers([false, true], available);
  h.switches.forEach(s => s.begin("session-1", "webrtc/1")); h.flush();
  // This app's Iroh endpoint comes up while live (`registerEndpoint` → `advertiseTransports`).
  available[0] = web; h.switches[0].changed(false); h.flush();
  expect(h.prepare[0]).not.toHaveBeenCalled();
  expect(h.prepare[1]).not.toHaveBeenCalled();
  expect(h.switches.every(s => !s.pending)).toBe(true);
  // Fallback off allows one transport: WebRTC, as before revision 2026-11-08, not Iroh through its relay for good.
  expect(h.policy(0).preferred).toBe("webrtc/1");
  expect(transportOrder(web, automaticTransport(web, false), false)).toEqual(["webrtc/1"]);
  h.switches.forEach(s => s.stop());
});

it("an upgrade off Iroh's relay whose WebRTC never connects leaves the chat on Iroh, with no row, and is not planned again", () => {
  vi.useFakeTimers();
  try {
    const web: PairedTransport[] = ["webrtc/1", "iroh/1"];
    const h = automaticWebPeers([true, true], [web, web]);
    h.switches.forEach(s => s.begin("session-1", "iroh/1")); h.flush();
    expect(h.prepare[0]).toHaveBeenCalledWith(expect.objectContaining({ choices: ["webrtc/1", "iroh/1"], upgrade: true }), true);
    expect(h.prepare[1]).toHaveBeenCalledWith(expect.objectContaining({ upgrade: true }), false);
    // ICE never settles: the move's own time runs out on both sides.
    vi.advanceTimersByTime(100); h.flush();
    expect(h.cancel.every(c => c.mock.calls.length >= 1)).toBe(true);
    expect([...h.kept, ...h.unreached].every(f => !f.mock.calls.length)).toBe(true);
    // No error and no transport shown as wanted, on either side.
    expect(h.state.every(s => s.mock.calls.every(args => args.every(a => a === undefined)))).toBe(true);
    expect(h.switches.every(s => !s.pending && s.wanted()?.transport === "iroh/1")).toBe(true);
    // Nothing loops: what the session hears again, or minutes on, plans nothing for the same policies.
    h.switches.forEach(s => s.reconsider()); h.flush();
    vi.advanceTimersByTime(10 * 60_000); h.flush();
    expect(h.prepare.map(p => p.mock.calls.length)).toEqual([1, 1]);
    expect(h.switches.every(s => !s.pending)).toBe(true);
    h.switches.forEach(s => s.stop());
  } finally { vi.useRealTimers(); }
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

it("keeps a contact's descriptors only in the shape the adapters make", () => {
  const id = "ab".repeat(32), publicKey = "cd".repeat(32);
  // What each adapter says: a Desktop's Iroh and HyperDHT, a browser's relayed ones, a capability record's.
  for (const descriptors of [
    { "iroh/1": { id, relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.168.1.10:4433", "[2001:db8::1]:4433", "[fe80::1%3]:4433"] }, "hyperdht/1": { publicKey } },
    { "iroh/1": { id, relay: "https://relay.test./", addresses: [], relayed: true }, "hyperdht/1": { publicKey, relayed: true, relay: "wss://relay.test/" } },
    { "iroh/1": { id, relay: null, addresses: ["127.0.0.1:1"] }, "hyperdht/1": { publicKey, relay: "ws://127.0.0.1:4601", relayed: true } },
    { "iroh/1": { id, relay: "http://localhost:4602/", addresses: [] } },
    {},
  ]) expect(checkedDescriptors(descriptors)).toEqual(descriptors);
  // No relay said is no relay, as the adapters read it.
  expect(checkedDescriptors({ "iroh/1": { id, addresses: [] } })).toEqual({ "iroh/1": { id, relay: null, addresses: [] } });
  for (const iroh of [
    null, "iroh", [id], { id: 42, relay: "http://192.168.1.10:8080/x" }, { id, relay: null }, { id: id.toUpperCase(), relay: null, addresses: [] },
    { id, relay: "http://192.168.1.10:8080/x", addresses: [] }, { id, relay: "ftp://relay.test/", addresses: [] }, { id, relay: 7, addresses: [] },
    { id, relay: `https://${"a".repeat(121)}`, addresses: [] }, { id, relay: null, addresses: "10.0.0.1:1" }, { id, relay: null, addresses: [7] },
    { id, relay: null, addresses: ["relay.test:443"] }, { id, relay: null, addresses: ["10.0.0.1"] }, { id, relay: null, addresses: Array(9).fill("10.0.0.1:1") },
    { id, relay: null, addresses: [], relayed: "yes" },
  ]) expect(checkedDescriptors({ "iroh/1": iroh, "hyperdht/1": { publicKey } })).toEqual({ "hyperdht/1": { publicKey } });
  for (const hyper of [
    null, "hyper", { publicKey: "not a key", relay: "ftp://relay.test" }, { publicKey: publicKey.slice(2) }, { publicKey, relay: "ws://192.168.1.10/" },
    { publicKey, relay: null }, { publicKey, relayed: 1 },
    // An older app named its relay as set: a login, a query or a fragment in it is not kept.
    { publicKey, relayed: true, relay: "wss://alice:hunter2@relay.test/" }, { publicKey, relayed: true, relay: "wss://relay.test/?token=s3cr3t" },
    { publicKey, relayed: true, relay: "wss://relay.test/#s3cr3t" }, { publicKey, relayed: true, relay: "ws://alice:hunter2@127.0.0.1:4900/" },
  ]) expect(checkedDescriptors({ "hyperdht/1": hyper })).toEqual({});
  expect(checkedDescriptors({ "hyperdht/1": { publicKey, relayed: true, relay: "wss://relay.test/@path" } })["hyperdht/1"]).toBeDefined();
  for (const none of [undefined, null, "x", 7, [], [{ "iroh/1": { id, relay: null, addresses: [] } }]]) expect(checkedDescriptors(none)).toEqual({});
  expect(checkedDescriptors({ "webrtc/1": "w", "evil/9": { x: 1 }, "hyperdht/1": { publicKey, more: { x: 1 } } })).toEqual({ "hyperdht/1": { publicKey } });
});

it("dials a contact's Iroh relay only at a public https address, or when it is one of the endpoint's own", () => {
  const local = ["http://127.0.0.1:4601", "http://localhost:4601/", "http://[::1]:4601/", "https://10.0.0.1/", "https://[::1]/", "https://192.168.1.2/",
    "https://169.254.169.254/", "https://100.64.0.1/", "https://[fd00::1]/", "https://localhost/", "https://router/", "https://nas.local/", "wss://relay.test/", 7, ""];
  for (const relay of local) expect(dialableIrohRelay(relay, []), String(relay)).toBe(false);
  for (const relay of [null, undefined, "https://relay.test/", "https://use1-1.relay.n0.iroh.link./", "https://8.8.8.8/"]) expect(dialableIrohRelay(relay, []), String(relay)).toBe(true);
  // The person's own relays stay theirs to name, in either spelling; another port on the same host is not one.
  const own = ["http://127.0.0.1:4600", "https://10.0.0.1/", "https://relay.lan.example./"];
  for (const relay of ["http://127.0.0.1:4600/", "https://10.0.0.1", "https://relay.lan.example/"]) expect(dialableIrohRelay(relay, own), relay).toBe(true);
  for (const relay of ["http://127.0.0.1:4601/", "https://10.0.0.2/", "http://127.0.0.1:4600/?x=1"]) expect(dialableIrohRelay(relay, own), relay).toBe(false);
  // What the relay settings take is unchanged: plain http on loopback is still a relay of one's own.
  for (const relay of ["http://127.0.0.1:4600", "http://localhost:4600/", "https://10.0.0.1/"]) expect(relayUrl(relay), relay).toBe(true);
});
