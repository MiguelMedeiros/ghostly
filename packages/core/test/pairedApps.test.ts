import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concatBytes, toZ32, utf8Encode } from "../src/bytes";
import type { FrameChannel } from "../src/frames";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createIdentity, identityFromSeed } from "../src/identity";
import { createLink } from "../src/invite";
import { APPS_CAPABILITY, KNOWN_SESSION_CAPABILITIES } from "../src/pairedCapabilities";
import {
  APP_DATA_MAX_BYTES, APP_FRAME, APP_PEER_OPEN_MAX, APP_RATE_LIMIT, APP_RATE_WINDOW_MS, APP_SEND_LIMIT, AppSessions, appCloseFrame, appDataBytes,
  appDataFrame, appOpenFrame, chatAppId, isAppRef, isAppVersion, isChatAppId, parseAppFrame, readAppFrame, type AppFrameEvent,
} from "../src/pairedApps";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
// covers: apps.chat.wire

/**
 * Mini-apps in a chat (WISP 1200 § In a chat: `apps/1`): the chat app id, the `paired-app` frames and the limits a
 * receiver enforces. `vectors/app-chat.json` is what this file builds from fixed labels, checked in: write it again
 * with `APPS_VECTORS_WRITE=1 npx vitest run test/pairedApps.test.ts`. Every key here is a test value made from a label.
 */

const FILE = fileURLToPath(new URL("./vectors/app-chat.json", import.meta.url));
const seed = (label: string) => sha256(utf8Encode(`ghostly apps vectors: ${label}`));
const key = (label: string) => identityFromSeed(seed(label)).publicKey;
const hexOf = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
/** A string whose JSON is exactly `bytes` long: the quotes and that many minus two ASCII letters. */
const jsonOf = (bytes: number) => "x".repeat(bytes - 2);

function build() {
  const ana = key("ana participation"), bob = key("bob participation"), carol = key("carol participation");
  const publisher = toZ32(key("chess publisher"));
  const chess = `${publisher}/chess`, snake = `${publisher}/snake`;
  const [low, high] = [ana, bob].sort((x, y) => { for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  const id = chatAppId(ana, bob, chess);
  const frame = (fields: Record<string, unknown>) => ({ t: APP_FRAME, ...fields });
  return {
    about: {
      pins: "The chat app id and the paired-app frames of apps/1",
      wisp: "WISP 1200, In a chat: apps/1",
      test: "packages/core/test/pairedApps.test.ts (APPS_VECTORS_WRITE=1 writes it again)",
      encodings: "keys z-base32; hmacKey hex; chat app ids base64url without padding; dataBytes is d as compact UTF-8 JSON",
    },
    inputs: {
      labels: "every key is the Ed25519 public key of the seed SHA-256(\"ghostly apps vectors: <label>\")",
      ana: toZ32(ana), bob: toZ32(bob), carol: toZ32(carol), publisher,
      hmacKey: { keys: [toZ32(ana), toZ32(bob)], value: hexOf(sha256(concatBytes(utf8Encode("ghostly-apps/1"), new Uint8Array([0]), low, high))) },
    },
    ids: [
      { name: "chess, Ana and Bob", keys: [toZ32(ana), toZ32(bob)], ref: chess, id },
      { name: "chess, Bob and Ana (the same id)", keys: [toZ32(bob), toZ32(ana)], ref: chess, id: chatAppId(bob, ana, chess) },
      { name: "snake, Ana and Bob", keys: [toZ32(ana), toZ32(bob)], ref: snake, id: chatAppId(ana, bob, snake) },
      { name: "chess, Ana and Carol (another chat)", keys: [toZ32(ana), toZ32(carol)], ref: chess, id: chatAppId(ana, carol, chess) },
    ],
    valid: [
      { name: "open", frame: frame({ a: id, o: "open", v: "1.2.0" }), reads: { a: id, o: "open", v: "1.2.0" } },
      { name: "open, a prerelease with build metadata", frame: frame({ a: id, o: "open", v: "2.0.0-rc.1+build.5" }), reads: { a: id, o: "open", v: "2.0.0-rc.1+build.5" } },
      { name: "close", frame: frame({ a: id, o: "close" }), reads: { a: id, o: "close" } },
      // A data frame reads as its `a` and its `d`, unchanged; `dataBytes` is what the 32 KiB cap measures.
      { name: "data, small", frame: frame({ a: id, d: { move: "e2e4", n: 1 } }), dataBytes: 21 },
      { name: "data, null", frame: frame({ a: id, d: null }), dataBytes: 4 },
      { name: "data, exactly 32 KiB", frame: frame({ a: id, d: jsonOf(APP_DATA_MAX_BYTES) }), dataBytes: APP_DATA_MAX_BYTES },
      { name: "an unknown key is ignored", frame: frame({ a: id, o: "close", x: 1 }), reads: { a: id, o: "close" } },
    ],
    invalid: [
      { name: "d one byte past 32 KiB", refusal: "too-large", frame: frame({ a: id, d: jsonOf(APP_DATA_MAX_BYTES + 1) }) },
      { name: "an unknown o", refusal: "unknown-o", frame: frame({ a: id, o: "pause" }) },
      { name: "no a", refusal: "bad-a", frame: frame({ o: "close" }) },
      { name: "an a of 21 characters", refusal: "bad-a", frame: frame({ a: id.slice(1), o: "close" }) },
      { name: "an a of 23 characters", refusal: "bad-a", frame: frame({ a: `${id}A`, o: "close" }) },
      { name: "an a with padding", refusal: "bad-a", frame: frame({ a: `${id.slice(2)}==`, o: "close" }) },
      { name: "both o and d", refusal: "o-and-d", frame: frame({ a: id, o: "close", d: 1 }) },
      { name: "neither o nor d", refusal: "no-o-or-d", frame: frame({ a: id }) },
      { name: "open without v", refusal: "bad-v", frame: frame({ a: id, o: "open" }) },
      { name: "open with a v that is not semantic versioning", refusal: "bad-v", frame: frame({ a: id, o: "open", v: "1.2" }) },
      { name: "open with a v past 64 characters", refusal: "bad-v", frame: frame({ a: id, o: "open", v: `1.0.0-${"a".repeat(59)}` }) },
    ],
  };
}

type Vectors = ReturnType<typeof build>;

describe("app-chat vectors", () => {
  it("match the checked-in file", () => {
    const built = build();
    if (process.env.APPS_VECTORS_WRITE === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
    expect(built).toEqual(JSON.parse(readFileSync(FILE, "utf8")) as Vectors);
  });

  it("are read as the file says", () => {
    const file = JSON.parse(readFileSync(FILE, "utf8")) as Vectors;
    // One pair of keys in both orders gives one id; another app or another chat gives another.
    expect(file.ids[0].id).toBe(file.ids[1].id);
    expect(new Set(file.ids.map(v => v.id)).size).toBe(3);
    for (const v of file.ids) expect(isChatAppId(v.id)).toBe(true);
    for (const v of file.valid) {
      const { a, d } = v.frame as unknown as { a: string; d: unknown };
      const reads = "reads" in v ? v.reads : { a, d };
      expect(readAppFrame(v.frame), v.name).toEqual({ ok: true, frame: { t: APP_FRAME, ...reads } });
      if ("dataBytes" in v) expect(appDataBytes(d), v.name).toBe(v.dataBytes);
    }
    for (const v of file.invalid) expect(readAppFrame(v.frame), v.name).toEqual({ ok: false, refusal: v.refusal });
  });
});

describe("the chat app id", () => {
  const ana = createIdentity().publicKey, bob = createIdentity().publicKey;
  const ref = `${toZ32(createIdentity().publicKey)}/chess`;

  it("is 22 characters, the same from both sides, and differs per app and per chat", () => {
    const id = chatAppId(ana, bob, ref);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(chatAppId(bob, ana, ref)).toBe(id);
    expect(chatAppId(ana, bob, ref.replace("/chess", "/snake"))).not.toBe(id);
    expect(chatAppId(ana, createIdentity().publicKey, ref)).not.toBe(id);
  });

  it("takes only an app reference and 32-byte keys", () => {
    expect(() => chatAppId(ana, bob, "chess")).toThrow();
    expect(() => chatAppId(ana.slice(1), bob, ref)).toThrow();
    const publisher = ref.slice(0, 52);
    for (const good of [ref, `${publisher}/a`, `${publisher}/a-${"b".repeat(29)}`]) expect(isAppRef(good), good).toBe(true);
    for (const bad of [`${publisher}/Chess`, `${publisher}/1chess`, `${publisher}/`, `${publisher}/${"a".repeat(33)}`, `${publisher.slice(1)}/chess`,
      `${publisher}x/chess`, `${publisher}/chess/x`, `${"l".repeat(52)}/chess`, 7, null])
      expect(isAppRef(bad), String(bad)).toBe(false);
    // The last character of a 32-byte key carries 4 bits: a key with the other bit set is not canonical.
    const last = publisher.at(-1)!, alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
    const other = alphabet[alphabet.indexOf(last) ^ 1];
    expect(isAppRef(`${publisher.slice(0, 51)}${other}/chess`)).toBe(false);
  });

  it("versions are semantic versioning, at most 64 characters", () => {
    for (const good of ["0.0.1", "1.2.0", "10.20.30-alpha.1+exp.sha.5114f85"]) expect(isAppVersion(good), good).toBe(true);
    for (const bad of ["1.2", "v1.2.0", "01.2.0", "1.2.0 ", `1.0.0-${"a".repeat(59)}`, 1, undefined]) expect(isAppVersion(bad), String(bad)).toBe(false);
  });
});

describe("frames", () => {
  const id = chatAppId(createIdentity().publicKey, createIdentity().publicKey, `${toZ32(createIdentity().publicKey)}/chess`);

  it("are built as the WISP writes them, and read back", () => {
    expect(JSON.stringify(appOpenFrame(id, "1.0.0"))).toBe(`{"t":"paired-app","a":"${id}","o":"open","v":"1.0.0"}`);
    expect(JSON.stringify(appCloseFrame(id))).toBe(`{"t":"paired-app","a":"${id}","o":"close"}`);
    expect(JSON.stringify(appDataFrame(id, [1, "x"]))).toBe(`{"t":"paired-app","a":"${id}","d":[1,"x"]}`);
    for (const frame of [appOpenFrame(id, "1.0.0"), appCloseFrame(id), appDataFrame(id, { a: 1 })]) expect(parseAppFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("refuses to build what a reader would drop", () => {
    expect(() => appOpenFrame(id, "1.0")).toThrow();
    expect(() => appOpenFrame("short", "1.0.0")).toThrow();
    expect(() => appDataFrame(id, jsonOf(APP_DATA_MAX_BYTES + 1))).toThrow();
    expect(() => appDataFrame(id, undefined)).toThrow();
    expect(appDataFrame(id, jsonOf(APP_DATA_MAX_BYTES))).toBeTruthy();
  });

  it("measures data as UTF-8, and a full frame fits under the session's 60 KiB", () => {
    expect(appDataBytes("é")).toBe(4);
    expect(appDataBytes(undefined)).toBe(Infinity);
    expect(appDataBytes(10n)).toBe(Infinity);
    expect(JSON.stringify(appDataFrame(id, jsonOf(APP_DATA_MAX_BYTES))).length).toBeLessThan(60 * 1024);
  });
});

describe("the receiver's limits", () => {
  const ids = Array.from({ length: APP_PEER_OPEN_MAX + 2 }, () => chatAppId(createIdentity().publicKey, createIdentity().publicKey, `${toZ32(createIdentity().publicKey)}/chess`));
  const [id, other] = ids;
  const wire = (frame: object) => JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
  const sessions = (clock = { now: 1_000 }) => ({ clock, apps: new AppSessions(new Map(), () => clock.now) });

  it("takes data only for an app open on both sides", () => {
    const { apps } = sessions();
    expect(apps.receive(wire(appDataFrame(id, 1)))).toBeNull();
    expect(apps.receive(wire(appOpenFrame(id, "1.0.0")))).toEqual({ app: id, o: "open", v: "1.0.0" });
    // The peer is open, this side is not.
    expect(apps.receive(wire(appDataFrame(id, 1)))).toBeNull();
    apps.open.set(id, "1.0.0");
    expect(apps.receive(wire(appDataFrame(id, 1)))).toEqual({ app: id, d: 1 });
    expect(apps.receive(wire(appCloseFrame(id)))).toEqual({ app: id, o: "close" });
    expect(apps.receive(wire(appDataFrame(id, 2)))).toBeNull();
    // A close for an app the peer did not have open says nothing.
    expect(apps.receive(wire(appCloseFrame(id)))).toBeNull();
  });

  it("drops data past 32 KiB, and anything malformed", () => {
    const { apps } = sessions();
    apps.open.set(id, "1.0.0");
    apps.receive(wire(appOpenFrame(id, "1.0.0")));
    expect(apps.receive({ t: APP_FRAME, a: id, d: jsonOf(APP_DATA_MAX_BYTES + 1) })).toBeNull();
    expect(apps.receive({ t: APP_FRAME, a: id, d: jsonOf(APP_DATA_MAX_BYTES) })).toEqual({ app: id, d: jsonOf(APP_DATA_MAX_BYTES) });
    for (const bad of [{ t: APP_FRAME, a: id, o: "close", d: 1 }, { t: APP_FRAME, a: id, o: "open" }, { t: APP_FRAME, a: 7, d: 1 }, { t: APP_FRAME, a: id }])
      expect(apps.receive(bad)).toBeNull();
  });

  it("takes 50 frames a second per app, the next only once the window moves", () => {
    const { apps, clock } = sessions();
    apps.open.set(id, "1.0.0");
    apps.receive(wire(appOpenFrame(id, "1.0.0")));
    const taken = () => Array.from({ length: APP_RATE_LIMIT + 10 }, (_, n) => apps.receive(wire(appDataFrame(id, n)))).filter(Boolean).length;
    // The open counted too.
    expect(taken()).toBe(APP_RATE_LIMIT - 1);
    // Another app has its own budget.
    expect(apps.receive(wire(appOpenFrame(other, "1.0.0")))).not.toBeNull();
    clock.now += APP_RATE_WINDOW_MS - 1;
    expect(apps.receive(wire(appDataFrame(id, "late")))).toBeNull();
    clock.now += 1;
    expect(taken()).toBe(APP_RATE_LIMIT);
  });

  it("keeps at most 16 apps the peer has open", () => {
    const { apps } = sessions();
    for (const app of ids.slice(0, APP_PEER_OPEN_MAX)) expect(apps.receive(wire(appOpenFrame(app, "1.0.0")))).not.toBeNull();
    expect(apps.receive(wire(appOpenFrame(ids[APP_PEER_OPEN_MAX], "1.0.0")))).toBeNull();
    // A new version of one already open is taken.
    expect(apps.receive(wire(appOpenFrame(id, "1.0.1")))).toEqual({ app: id, o: "open", v: "1.0.1" });
    expect(apps.peerVersion(id)).toBe("1.0.1");
    // One closes: there is room again.
    apps.receive(wire(appCloseFrame(id)));
    expect(apps.receive(wire(appOpenFrame(ids[APP_PEER_OPEN_MAX], "1.0.0")))).not.toBeNull();
  });

  it("a session that ends closes what the peer had open, with offline; this side's apps stay", () => {
    const { apps } = sessions();
    apps.open.set(id, "1.0.0");
    apps.receive(wire(appOpenFrame(id, "1.0.0")));
    apps.receive(wire(appOpenFrame(other, "2.0.0")));
    expect(apps.sessionEnded()).toEqual([{ app: id, o: "close", offline: true }, { app: other, o: "close", offline: true }]);
    expect(apps.peerOpen.size).toBe(0);
    expect([...apps.open]).toEqual([[id, "1.0.0"]]);
    expect(apps.sessionEnded()).toEqual([]);
  });

  it("the sender says why a frame cannot go, and keeps under the receiver's rate", () => {
    const { apps, clock } = sessions();
    expect(apps.canSend(id, 1)).toBe("not-open");
    apps.open.set(id, "1.0.0");
    expect(apps.canSend(id, jsonOf(APP_DATA_MAX_BYTES + 1))).toBe("too-large");
    expect(apps.canSend(id, 1)).toBe("peer-closed");
    apps.receive(wire(appOpenFrame(id, "1.0.0")));
    const results = Array.from({ length: APP_RATE_LIMIT }, () => apps.canSend(id, 1));
    expect(results.filter(r => r === null)).toHaveLength(APP_SEND_LIMIT);
    expect(results.at(-1)).toBe("too-fast");
    clock.now += APP_RATE_WINDOW_MS;
    expect(apps.canSend(id, 1)).toBeNull();
  });
});

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake (the harness of
// pairedTyping.test.ts).

const hex = (c: string) => c.repeat(64);

function channelPair(drop: { a?: (data: string) => boolean; b?: (data: string) => boolean } = {}, sent?: string[]): [FrameChannel, FrameChannel] {
  type End = FrameChannel & { peer?: End; closed: boolean; receive(data: string): void };
  const make = (filter?: (data: string) => boolean, log?: string[]): End => {
    let reader: FrameChannel["onMessage"] = null;
    const waiting: string[] = [];
    return {
      closed: false, bufferedAmount: 0, onClose: null, drained: () => Promise.resolve(),
      get onMessage() { return reader; },
      set onMessage(value) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
      receive(data) { if (this.closed) return; if (reader) reader(data); else waiting.push(data); },
      send(data) {
        if (this.closed) throw new Error("Channel closed");
        if (typeof data !== "string") throw new Error("Text only");
        log?.push(data);
        if (filter?.(data)) return;
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(drop.a, sent), b = make(drop.b);
  a.peer = b; b.peer = a;
  return [a, b];
}

interface Side { link: GhostLink; endpoint: NativeEndpoint; events: AppFrameEvent[]; sent: string[]; mine: Uint8Array }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const sides: Partial<Record<"a" | "b", Side>> = {};
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const events: AppFrameEvent[] = [], sent: string[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { name }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        // Only "a" dials: what each side sends is logged on its own end.
        const [mine, theirs] = channelPair(options.drop, sent);
        const other = endpoints[name === "a" ? "b" : "a"];
        const theirsLogged = new Proxy(theirs, { get: (target, key) => key === "send"
          ? (data: string) => { sides[name === "a" ? "b" : "a"]?.sent.push(data); target.send(data); } : Reflect.get(target, key),
          set: (target, key, value) => Reflect.set(target, key, value) });
        queueMicrotask(() => other.onConnection?.({ channel: theirsLogged, binding }));
        return { channel: mine, binding };
      },
    };
    endpoints[name] = endpoint;
    const link = new GhostLink({
      params: { ...params, profile: "paired-chat/1" },
      rtcAvailable: false,
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": { name: name === "a" ? "b" : "a" } }, peerTransports: ["iroh/1"] },
      pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      createPeerConnection: () => { throw new Error("The chat runs on Iroh here: no WebRTC"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      appsSupport: true,
      ...extra,
      events: { onAppFrame: event => { events.push(event); }, ...extra.events },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, events, sent, mine: me.publicKey };
  };
  sides.a = make("a", invitation.mine, ia, ib, options.a);
  sides.b = make("b", invitation.invite, ib, ia, options.b);
  const ref = `${toZ32(createIdentity().publicKey)}/chess`;
  return { a: sides.a, b: sides.b, app: chatAppId(ia.publicKey, ib.publicKey, ref) };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

const appSent = (side: Side) => side.sent.filter(data => data.includes(`"t":"${APP_FRAME}"`));
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

describe("apps on a paired session (apps/1)", () => {
  it("is a session capability this app knows", () => {
    expect(KNOWN_SESSION_CAPABILITIES).toContain(APPS_CAPABILITY);
    expect(APPS_CAPABILITY).toBe("apps/1");
  });

  it("A opens, B opens, they talk; a close ends it; nothing went before both offered apps/1", async () => {
    const { a, b, app } = pair();
    // Not live: the open is kept, a send fails with offline and nothing is kept to send later.
    a.link.openApp(app, "1.0.0");
    expect(a.link.sendAppData(app, { move: "e2e4" })).toBe("offline");
    expect(a.link.sendAppData(app, jsonOf(APP_DATA_MAX_BYTES + 1))).toBe("too-large");
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsApps && b.link.supportsApps).toBe(true));
    // A's open went as soon as the session agreed apps/1.
    await vi.waitFor(() => expect(b.events).toEqual([{ app, o: "open", v: "1.0.0" }]));
    expect(b.link.peerApps.get(app)).toBe("1.0.0");
    // B has not opened it: A cannot send to it yet, and what B's side gets for it would be dropped.
    expect(a.link.sendAppData(app, 1)).toBe("peer-closed");
    expect(b.link.sendAppData(app, 1)).toBe("not-open");
    b.link.openApp(app, "1.1.0");
    await vi.waitFor(() => expect(a.events).toEqual([{ app, o: "open", v: "1.1.0" }]));
    expect(a.link.sendAppData(app, { move: "e2e4" })).toBeNull();
    expect(b.link.sendAppData(app, { move: "e7e5" })).toBeNull();
    await vi.waitFor(() => expect(b.events.at(-1)).toEqual({ app, d: { move: "e2e4" } }));
    await vi.waitFor(() => expect(a.events.at(-1)).toEqual({ app, d: { move: "e7e5" } }));
    b.link.closeApp(app);
    await vi.waitFor(() => expect(a.events.at(-1)).toEqual({ app, o: "close" }));
    expect(a.link.sendAppData(app, 1)).toBe("peer-closed");
  });

  it("a contact that leaves closes its apps here with offline", async () => {
    const { a, b, app } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsApps && b.link.supportsApps).toBe(true));
    a.link.openApp(app, "1.0.0"); b.link.openApp(app, "1.0.0");
    await vi.waitFor(() => expect(a.link.peerApps.has(app) && b.link.peerApps.has(app)).toBe(true));
    await b.link.stop(false);
    await vi.waitFor(() => expect(a.events.at(-1)).toEqual({ app, o: "close", offline: true }));
    expect(a.link.sendAppData(app, 1)).toBe("offline");
    expect(a.link.peerApps.size).toBe(0);
  });

  it("says open again when the session comes back over a new connection", async () => {
    const { a, b, app } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsApps && b.link.supportsApps).toBe(true));
    a.link.openApp(app, "1.0.0"); b.link.openApp(app, "1.0.0");
    await vi.waitFor(() => expect(a.link.peerApps.has(app) && b.link.peerApps.has(app)).toBe(true));
    // The connection drops under both: each side hears the other closed, offline.
    (a.link as unknown as { channel: FrameChannel }).channel.close();
    await vi.waitFor(() => expect(a.events).toContainEqual({ app, o: "close", offline: true }));
    await vi.waitFor(() => expect(b.events).toContainEqual({ app, o: "close", offline: true }));
    await live(a, b);
    // Both said open again, unprompted, and can talk.
    await vi.waitFor(() => expect(a.link.peerApps.get(app) && b.link.peerApps.get(app)).toBe("1.0.0"));
    expect(appSent(a).filter(data => data.includes('"o":"open"'))).toHaveLength(2);
    expect(a.link.sendAppData(app, "again")).toBeNull();
    await vi.waitFor(() => expect(b.events.at(-1)).toEqual({ app, d: "again" }));
  });

  it("drops a flood past 50 a second, and data past 32 KiB, from a peer that ignores its own limits", async () => {
    const { a, b, app } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsApps && b.link.supportsApps).toBe(true));
    a.link.openApp(app, "1.0.0"); b.link.openApp(app, "1.0.0");
    await vi.waitFor(() => expect(a.link.peerApps.has(app) && b.link.peerApps.has(app)).toBe(true));
    const channel = (a.link as unknown as { channel: FrameChannel }).channel;
    const before = b.events.length;
    // Sent straight on the channel, past the sender's own checks.
    channel.send(JSON.stringify({ t: APP_FRAME, a: app, d: jsonOf(APP_DATA_MAX_BYTES + 1) }));
    // 60 at once: past the 50 an app may send, under the 64 frames a session queues before it gives up on its peer.
    for (let n = 0; n < 60; n++) channel.send(JSON.stringify(appDataFrame(app, n)));
    await pause();
    const data = b.events.slice(before);
    // Counted before they are read: the open and the oversized frame took two of B's 50.
    expect(data).toEqual(Array.from({ length: APP_RATE_LIMIT - 2 }, (_, n) => ({ app, d: n })));
    expect(b.link.isDataLinkOpen).toBe(true);
  });

  it("an app that does not offer apps/1 gets no frame, and what it sends is dropped", async () => {
    const { a, b, app } = pair({ b: { appsSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsApps).toBe(false);
    expect(a.link.sessionOffers.mine).toContain(APPS_CAPABILITY);
    expect(b.link.sessionOffers.mine).not.toContain(APPS_CAPABILITY);
    a.link.openApp(app, "1.0.0");
    expect(a.link.sendAppData(app, 1)).toBe("peer-closed");
    a.link.closeApp(app);
    // B's side, as an attacker or a newer build without the flag: frames on the channel are dropped at A.
    b.link.openApp(app, "1.0.0");
    const channel = (b.link as unknown as { channel: FrameChannel }).channel;
    channel.send(JSON.stringify(appOpenFrame(app, "1.0.0")));
    await pause();
    expect(appSent(a)).toEqual([]);
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });

  it("an older app that never says its capabilities gets no frame", async () => {
    const { a, b, app } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsApps).toBe(true));
    expect(a.link.supportsApps).toBe(false);
    a.link.openApp(app, "1.0.0");
    expect(a.link.sendAppData(app, 1)).toBe("peer-closed");
    await pause();
    expect(appSent(a)).toEqual([]);
  });

  it("is off unless asked for: no capability offered, no frame taken", async () => {
    const { a, b, app } = pair({ a: { appsSupport: undefined }, b: { appsSupport: undefined } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.sessionOffers.mine).not.toContain(APPS_CAPABILITY);
    expect(a.link.sessionOffers.peer).not.toContain(APPS_CAPABILITY);
    (b.link as unknown as { channel: FrameChannel }).channel.send(JSON.stringify(appOpenFrame(app, "1.0.0")));
    await pause();
    expect(a.events).toEqual([]);
  });

  it("ignores frames from a connection that never authenticated as the pinned contact", async () => {
    const { a, app } = pair();
    const [mine, theirs] = channelPair();
    a.endpoint.onConnection?.({ channel: theirs, binding: { transport: "iroh/1", context: hex("d"), identities: [hex("a"), hex("d")] } });
    mine.send(JSON.stringify({ t: "paired-capabilities", c: [APPS_CAPABILITY] }));
    mine.send(JSON.stringify(appOpenFrame(app, "1.0.0")));
    await pause();
    expect(a.events).toEqual([]);
  });
});
