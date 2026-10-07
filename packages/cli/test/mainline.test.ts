import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GhostLink, createIdentity, edgeParams, randomBytes, toBase64Url, type Identity, type PollIntervals } from "@ghostly/core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Mainline, RelaysAndDht } from "../src/runtime/mainline";
import { mainlineNetwork, pkarrRelays } from "../src/runtime/engine";
import { error, ghostly, home, hyperdhtTestnet, ok, Running } from "./support/cli";
// covers: headless.daemon, headless.groups, core.relay-client

/**
 * Pkarr over the Mainline DHT on Node (WISP 1100 § Runtime): a headless Ghostly keeps finding its contacts while the
 * relays fail. A DHT testnet of this process's own nodes on loopback, relays that answer 500 (or work), and two group
 * edges (paired links pinned to member keys, as the engine builds them) with WebRTC stood in for.
 */
const nodes: Mainline[] = [];
async function testnet(size: number): Promise<string> {
  const first = new Mainline({ bootstrap: false, host: "127.0.0.1", timeoutMs: 5_000 });
  await first.listening;
  nodes.push(first);
  const bootstrap = `127.0.0.1:${first.address().port}`;
  for (let i = 1; i < size; i++) { const node = new Mainline({ bootstrap: [bootstrap], host: "127.0.0.1", timeoutMs: 5_000 }); await node.listening; nodes.push(node); }
  for (const a of nodes) for (const b of nodes) if (a !== b) a.addNode("127.0.0.1", b.address().port);
  testnetNodes.push(...nodes);
  return bootstrap;
}
const testnetNodes: Mainline[] = [];
/** A node of another app on the testnet, bound and knowing the testnet's nodes. */
async function peer(bootstrap: string): Promise<Mainline> {
  const node = new Mainline({ bootstrap: [bootstrap], host: "127.0.0.1", timeoutMs: 5_000 });
  await node.listening;
  for (const other of testnetNodes) node.addNode("127.0.0.1", other.address().port);
  nodes.push(node);
  return node;
}

/** Relays in memory: every request answers 500 while `down`, else a shared store. */
function relays(state: { down: boolean; packets: Map<string, Uint8Array> }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.down) return new Response("internal error", { status: 500 });
    const key = new URL(String(input)).pathname.slice(1);
    if (init?.method === "PUT") { state.packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const packet = state.packets.get(key);
    return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
  }) as typeof fetch;
}
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

let bootstrap = "";
beforeAll(async () => { bootstrap = await testnet(6); }, 30_000);
afterAll(async () => { await Promise.all(nodes.map((n) => n.destroy())); });

describe("Pkarr over the Mainline DHT, beside the relays", { timeout: 60_000 }, () => {
  it("a packet published while every relay answers 500 is read back from the DHT", async () => {
    const store = { down: true, packets: new Map<string, Uint8Array>() };
    const a = new RelaysAndDht(await peer(bootstrap), { relays: RELAYS, fetch: relays(store), log: () => {} });
    const b = new RelaysAndDht(await peer(bootstrap), { relays: RELAYS, fetch: relays(store), log: () => {} });
    const me = createIdentity();
    await a.publish(me, [{ label: "_hello", value: "from the dht" }]);
    const found = await b.resolve(me.pubKeyZ32);
    expect(found?.records).toEqual([expect.objectContaining({ label: "_hello", value: "from the dht" })]);
    // A newer one wins over an older one.
    await a.publish(me, [{ label: "_hello", value: "newer" }]);
    expect((await b.resolve(me.pubKeyZ32))?.records[0].value).toBe("newer");
    expect(b.discovery().path).toEqual({ via: "dht" });
  });

  it("with the relays working, reads go to them, and every packet is on the DHT too", async () => {
    const store = { down: false, packets: new Map<string, Uint8Array>() };
    const dht = await peer(bootstrap);
    const a = new RelaysAndDht(dht, { relays: RELAYS, fetch: relays(store), log: () => {} });
    const me = createIdentity();
    await a.publish(me, [{ label: "_x", value: "both" }]);
    expect((await a.resolve(me.pubKeyZ32))?.records[0].value).toBe("both");
    expect(a.discovery().path).toMatchObject({ via: "relay" });
    // The DHT has it as well: an app that reads only the DHT (the Desktop) finds it.
    const deadline = Date.now() + 10_000;
    let onDht = null;
    while (!onDht && Date.now() < deadline) { onDht = await (await peer(bootstrap)).get(me.pubKeyZ32).catch(() => null); if (!onDht) await new Promise((r) => setTimeout(r, 200)); }
    expect(onDht?.records[0].value).toBe("both");
  });

  it("a group's edge goes live while every relay answers 500, through the DHT, without a restart", async () => {
    const store = { down: true, packets: new Map<string, Uint8Array>() };
    const group = toBase64Url(randomBytes(16));
    const [one, two] = [createIdentity(), createIdentity()];
    const fast: PollIntervals = { active: 500, idle: 1_000, fast: 250, background: 1_000, connected: 2_000 };
    const edge = async (me: Identity, other: Identity) => {
      const link = new GhostLink({
        params: edgeParams(group, me.seed, me.pubKeyZ32, other.pubKeyZ32),
        pairing: { credentials: { seedB64: me.seedB64, peerKey: other.pubKeyZ32, requireSignedSignals: true, verifiedPeerKey: other.pubKeyZ32 },
          pinPeer: async (key) => { if (key !== other.pubKeyZ32) throw new Error("Not the member this edge belongs to"); }, trustOnFirstUse: false },
        transport: new RelaysAndDht(await peer(bootstrap), { relays: RELAYS, fetch: relays(store), log: () => {} }),
        pollIntervals: fast, autoConnect: true, groupsSupport: true,
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        localFetch: async () => { throw new Error("no services"); }, getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
      });
      link.start();
      return link;
    };
    const a = await edge(one, two), b = await edge(two, one);
    try {
      const started = Date.now();
      while (!(a.isDataLinkOpen && b.isDataLinkOpen) && Date.now() - started < 40_000) await new Promise((r) => setTimeout(r, 200));
      console.log(`MAINLINE edge live in ${(Date.now() - started) / 1000} s with every relay answering 500`);
      expect(a.isDataLinkOpen && b.isDataLinkOpen).toBe(true);
      expect(store.packets.size).toBe(0);
    } finally {
      await Promise.all([a.stop(false), b.stop(false)]);
    }
  });
});

describe("a private network's relays (GHOSTLY_PKARR_RELAYS)", { timeout: 60_000 }, () => {
  it("are read from the environment, and leave the public DHT out unless a bootstrap is given", () => {
    expect(pkarrRelays({})).toBeNull();
    expect(pkarrRelays({ GHOSTLY_PKARR_RELAYS: " http://127.0.0.1:49501 , https://relay.lan/ ," })).toEqual(["http://127.0.0.1:49501", "https://relay.lan/"]);
    expect(() => pkarrRelays({ GHOSTLY_PKARR_RELAYS: "relay.lan" })).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/http:\/\/ or https:\/\//) }));
    expect(mainlineNetwork({ GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:49501" })).toEqual({ off: true });
    expect(mainlineNetwork({ GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:49501", GHOSTLY_DHT_BOOTSTRAP: "127.0.0.1:49502" })).toEqual({ off: false, bootstrap: ["127.0.0.1:49502"], host: "127.0.0.1" });
    expect(mainlineNetwork({})).toEqual({ off: false });
  });

  it("are the only relays: the profile's relays setting does not replace them, and without a DHT they carry everything", async () => {
    const store = { down: false, packets: new Map<string, Uint8Array>() };
    const a = new RelaysAndDht(null, { relays: RELAYS, fetch: relays(store), log: () => {} }, true);
    a.configure({ relays: ["https://pkarr.example.org"], readRelays: false });
    expect(a.describe()).toEqual({ protocol: "Pkarr relays (HTTP)", relays: RELAYS });
    const me = createIdentity();
    await a.publish(me, [{ label: "_hello", value: "private" }]);
    expect(store.packets.size).toBe(1);
    expect((await a.resolve(me.pubKeyZ32))?.records[0].value).toBe("private");
    // Not pinned: the setting replaces them, as before.
    const b = new RelaysAndDht(null, { relays: RELAYS, fetch: relays(store), log: () => {} });
    b.configure({ relays: ["https://pkarr.example.org"], readRelays: false });
    expect(b.describe().relays).toEqual(["https://pkarr.example.org"]);
  });

  it("are what a profile uses from its first run, whatever its setting says; a bad one is a usage error", async () => {
    const dir = home("pinned-relays");
    const url = "http://127.0.0.1:49503";
    const as = (...args: string[]) => ghostly(["--home", dir, ...args], { env: { GHOSTLY_PKARR_RELAYS: url } });
    expect(ok(await as("status")).discovery).toEqual({ protocol: "Pkarr relays (HTTP)", relays: [url] });
    ok(await as("settings", "set", "relays", JSON.stringify(["http://127.0.0.1:49504"])));
    expect(ok(await as("status")).discovery).toEqual({ protocol: "Pkarr relays (HTTP)", relays: [url] });
    // Unset (empty), the profile's own setting is back.
    expect((ok(await ghostly(["--home", dir, "status"], { env: { GHOSTLY_PKARR_RELAYS: "" } })).discovery as { relays: string[] }).relays).toEqual(["http://127.0.0.1:49504"]);
    error(await ghostly(["--home", dir, "status"], { env: { GHOSTLY_PKARR_RELAYS: "relay.lan" } }), "usage", 2);
  });
});

/**
 * The daemons also get a HyperDHT of this test's own. An edge whose WebRTC attempt came to nothing goes on native only
 * for the rest of the run (node.ts `edgeWithoutRtc`), and with no STUN every such attempt reads as a network that blocks
 * direct connections. Here the native transport it then needs is on loopback; with none, as since the tests left the
 * public networks (#1389), the edge stayed down and the test timed out at "edge up" (CI, 2026-10-07).
 */
describe("two daemons whose only relay answers 500 to everything", { timeout: 300_000 }, () => {
  let relay: Server, url = "";
  let hyperdht: Awaited<ReturnType<typeof hyperdhtTestnet>> | undefined;
  const running: Running[] = [];
  beforeAll(async () => {
    relay = createServer((_request, response) => { response.statusCode = 500; response.end("internal error"); });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    hyperdht = await hyperdhtTestnet();
  }, 30_000);
  afterAll(async () => { await Promise.all(running.map((r) => r.stop())); relay?.close(); await hyperdht?.destroy(); }, 60_000);

  it("a private group is joined by its link and carries a message, all through the Mainline DHT", async () => {
    const env = { GHOSTLY_DHT: "1", GHOSTLY_DHT_BOOTSTRAP: bootstrap, GHOSTLY_PKARR_RELAYS: url, GHOSTLY_HYPERDHT_BOOTSTRAP: hyperdht!.bootstrap };
    const [admin, joiner] = [home("dht-admin"), home("dht-joiner")];
    const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
    for (const dir of [admin, joiner]) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify([url])));
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      await daemon.waitFor((l) => l.daemon === "ready");
    }
    const started = Date.now();
    const group = ok(await as(admin, "group", "create", "Relays down", "--mesh")).group as string;
    const link = ok(await as(admin, "group", "link", group)).link as string;
    ok(await as(joiner, "group", "join", link));
    const until = async (what: string, done: () => Promise<boolean>) => {
      const end = Date.now() + 180_000;
      while (!(await done())) { if (Date.now() > end) throw new Error(`${what}: not in 180 s`); await new Promise((r) => setTimeout(r, 1000)); }
    };
    await until("joined", async () => ok(await as(joiner, "group", "show", group)).status === "active");
    await until("edge up", async () => (ok(await as(joiner, "group", "show", group)).members as { online: boolean }[]).every((m) => m.online));
    ok(await as(admin, "group", "send", group, "--", "through the dht"));
    await until("delivered", async () => (ok(await as(joiner, "group", "history", group)).messages as { text: string }[]).some((m) => m.text === "through the dht"));
    console.log(`MAINLINE daemons: joined, edge up and a message delivered in ${Math.round((Date.now() - started) / 1000)} s with the relay answering 500`);
  });
});

let fingerprints = 0;
const byFingerprint = new Map<string, FakePeerConnection>();
function sdp(setup: string): { sdp: string; fingerprint: string } {
  const n = ++fingerprints;
  const fingerprint = n.toString(16).padStart(4, "0").repeat(16);
  const colons = fingerprint.toUpperCase().match(/.{2}/g)!.join(":");
  return { fingerprint, sdp: ["v=0", `a=ice-ufrag:u${n}`, "a=ice-pwd:passwordpasswordpassword", `a=fingerprint:sha-256 ${colons}`, `a=setup:${setup}`,
    "a=candidate:1 1 udp 2122260223 127.0.0.1 50000 typ host", ""].join("\r\n") };
}
const fingerprintOf = (text: string) => /a=fingerprint:sha-256 (\S+)/i.exec(text)![1].replace(/:/g, "").toLowerCase();
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  bufferedAmountLowThreshold = 0;
  peer: FakeChannel | null = null;
  send(data: string | ArrayBuffer) { const peer = this.peer; queueMicrotask(() => { if (peer?.readyState === "open") peer.dispatchEvent(Object.assign(new Event("message"), { data })); }); }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.dispatchEvent(new Event("close")); this.peer?.close(); }
}
class FakePeerConnection extends EventTarget {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  channel!: FakeChannel;
  closed = false;
  getConfiguration() { return { iceServers: [] }; }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as const, sdp: this.made("actpass") }; }
  async createAnswer() { return { type: "answer" as const, sdp: this.made("active") }; }
  private made(setup: string) { const made = sdp(setup); byFingerprint.set(made.fingerprint, this); return made.sdp; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type !== "answer") return;
    const answerer = byFingerprint.get(fingerprintOf(description.sdp!));
    if (!answerer || answerer.closed || fingerprintOf(answerer.remoteDescription!.sdp!) !== fingerprintOf(this.localDescription!.sdp!)) return;
    this.channel.peer = answerer.channel; answerer.channel.peer = this.channel;
    setTimeout(() => { if (this.closed || answerer.closed) return; for (const pc of [this, answerer]) { pc.connectionState = "connected"; pc.channel.open(); } }, 0);
  }
  close() { this.closed = true; this.connectionState = "closed"; this.channel?.close(); }
}
