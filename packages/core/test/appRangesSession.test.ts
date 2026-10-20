import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "../src/bytes";
import type { FrameChannel } from "../src/frames";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { APP_RANGE_DATA_KIND, APP_RANGE_LIMITS, type AppRangeTask } from "../src/pairedAppRanges";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
// covers: apps.ranges.wire

// The read lane on a paired session (WISP 1200 § A read lane to the contact): two GhostLinks over an in-memory channel
// with a real PairedSession handshake (the harness of filesBinary.test.ts). Each end says whether it carries binary.

const hex = (c: string) => c.repeat(64);
type Data = string | Uint8Array;
type End = Omit<FrameChannel, "bufferedAmount"> & { bufferedAmount: number; peer?: End; closed: boolean; receive(data: Data): void; sent: Data[]; peak: number; refused: number };

/**
 * Two ends of a channel. With `budget`, each end is a native one (as the Desktop's and the web's iroh channels are): it
 * holds what it was given and writes one frame a millisecond, `drained` resolves once it holds under a quarter of the
 * budget, and `send` throws past the budget.
 */
function channelPair(binary: boolean, budget?: number): [End, End] {
  const make = (): End => {
    let reader: FrameChannel["onMessage"] = null;
    const waiting: Data[] = [];
    const queued: Data[] = [];
    const drains: (() => void)[] = [];
    const size = (data: Data) => data.length;
    const write = (end: End) => {
      const data = queued.shift()!;
      end.bufferedAmount -= size(data);
      end.peer?.receive(data);
      if (end.bufferedAmount < budget! / 4) for (const resolve of drains.splice(0)) resolve();
      if (queued.length) setTimeout(() => write(end), 1);
    };
    return {
      closed: false, bufferedAmount: 0, onClose: null, sent: [], peak: 0, refused: 0,
      drained() { return budget && this.bufferedAmount >= budget / 4 ? new Promise<void>(resolve => drains.push(resolve)) : Promise.resolve(); },
      ...(binary && { binary: true }),
      ...(budget && { sendBudget: budget }),
      get onMessage() { return reader; },
      set onMessage(value) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
      receive(data) { if (this.closed) return; if (reader) reader(data); else waiting.push(data); },
      send(data) {
        if (this.closed) throw new Error("Channel closed");
        if (typeof data !== "string" && !binary) throw new Error("Text only");
        if (budget) {
          if (this.bufferedAmount + size(data) > budget) { this.refused++; throw new Error("Send budget is full"); }
          this.sent.push(data);
          this.bufferedAmount += size(data);
          this.peak = Math.max(this.peak, this.bufferedAmount);
          queued.push(data);
          if (queued.length === 1) setTimeout(() => write(this), 1);
          return;
        }
        this.sent.push(data);
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(), b = make();
  a.peer = b; b.peer = a;
  return [a, b];
}

interface Side { link: GhostLink; tasks: AppRangeTask[]; channel?: End }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

const APP = toBase64Url(new Uint8Array(16).fill(5));
const FILM = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 131 + 3) & 0xff);

/** A serves FILM to B's app; its owner answers each task from it, unless `hold`. */
async function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; binary?: boolean; budget?: number; hold?: boolean; file?: Uint8Array } = {}) {
  const file = options.file ?? FILM;
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const sides: Partial<Record<"a" | "b", Side>> = {};
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const tasks: AppRangeTask[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { id: name.repeat(64), relay: null, addresses: ["127.0.0.1:1"] }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        const [mine, theirs] = channelPair(options.binary ?? true, options.budget);
        sides.a!.channel = mine; sides.b!.channel = theirs;
        queueMicrotask(() => endpoints.b.onConnection?.({ channel: theirs, binding }));
        return { channel: mine, binding };
      },
    };
    endpoints[name] = endpoint;
    const link: GhostLink = new GhostLink({
      params: { ...params, profile: "paired-chat/1" },
      rtcAvailable: false,
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": { id: (name === "a" ? "b" : "a").repeat(64), relay: null, addresses: ["127.0.0.1:1"] } }, peerTransports: ["iroh/1"] },
      pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      createPeerConnection: () => { throw new Error("No WebRTC here"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      largeFilesSupport: true, binaryFilesSupport: true, appsSupport: true, appRangesSupport: true,
      ...extra,
      events: {
        onAppRangeTask: task => {
          tasks.push(task);
          if (options.hold) return;
          if (task.file === "gone") return link.failAppRange(task, "gone");
          void link.sendAppRange(task, file.subarray(task.offset, task.offset + task.length), file.length);
        },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, tasks };
  };
  const a = sides.a = make("a", invitation.mine, ia, ib, options.a);
  const b = sides.b = make("b", invitation.invite, ib, ia, options.b);
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.supportsApps && b.link.supportsApps).toBe(true));
  return { a, b };
}

async function opened(a: Side, b: Side) {
  a.link.openApp(APP, "1.0.0"); b.link.openApp(APP, "1.0.0");
  await vi.waitFor(() => expect(a.link.peerApps.has(APP) && b.link.peerApps.has(APP)).toBe(true));
}

const settled = async <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: Error) => ({ error: error.message }));
const rangeFrames = (end: End) => end.sent.filter(data => typeof data === "string" && data.includes('"t":"ar-'));

describe("the read lane on a paired session (app-ranges/1)", () => {
  it("B's app reads a range A's app serves: binary chunks where files/4 is on, then the size", async () => {
    const { a, b } = await pair();
    expect(a.link.supportsAppRanges && b.link.supportsAppRanges).toBe(true);
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film");
    if (!("serve" in served)) throw new Error(served.error);
    expect(a.link.appServes(APP)).toEqual([served.serve]);
    const read = await b.link.readAppRange(APP, served.serve, 10_000, 100_000);
    expect(read.size).toBe(FILM.length);
    expect(read.bytes).toEqual(FILM.subarray(10_000, 110_000));
    const binary = a.channel!.sent.filter((data): data is Uint8Array => typeof data !== "string");
    expect(binary).toHaveLength(Math.ceil(100_000 / APP_RANGE_LIMITS.chunkBytes));
    expect(binary.every(message => message[0] === APP_RANGE_DATA_KIND)).toBe(true);
    expect(rangeFrames(a.channel!).filter(data => (data as string).includes('"ar-data"'))).toEqual([]);
  });

  it("goes as ar-data text on a channel without binary messages", async () => {
    const { a, b } = await pair({ binary: false });
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film") as { serve: string };
    const read = await b.link.readAppRange(APP, served.serve, FILM.length - 20_000, APP_RANGE_LIMITS.requestBytes);
    expect(read.bytes).toEqual(FILM.subarray(FILM.length - 20_000));
    expect(a.channel!.sent.every(data => typeof data === "string")).toBe(true);
    expect(rangeFrames(a.channel!).filter(data => (data as string).includes('"ar-data"'))).toHaveLength(2);
  });

  it("two apps' 4 reads each keep a native channel at files' line, a frame over it at most, and every one arrives", async () => {
    const budget = 120 * 1024, part = 64 * 1024;
    const other = toBase64Url(new Uint8Array(16).fill(6));
    const file = Uint8Array.from({ length: 4 * part }, (_, i) => (i * 7 + 1) & 0xff);
    const { a, b } = await pair({ binary: false, budget, file });
    await opened(a, b);
    a.link.openApp(other, "1.0.0"); b.link.openApp(other, "1.0.0");
    await vi.waitFor(() => expect(a.link.peerApps.has(other) && b.link.peerApps.has(other)).toBe(true));
    const serves = [APP, other].map(app => [app, (a.link.serveAppFile(app, "film") as { serve: string }).serve]);
    // Each waits for room; on dev 3 of them hit the budget and their reads never settled.
    const reads = await Promise.all(serves.flatMap(([app, serve]) => [0, 1, 2, 3].map(i => settled(b.link.readAppRange(app, serve, i * part, part)))));
    reads.forEach((read, n) => expect(read).toEqual({ value: { bytes: file.subarray((n % 4) * part, (n % 4 + 1) * part), size: file.length } }));
    expect(a.channel!.refused).toBe(0);
    // A ping, a message or another app's frame still fits beside the read lane, as beside a file.
    const frame = Math.max(...rangeFrames(a.channel!).map(data => data.length));
    expect(a.channel!.peak).toBeLessThanOrEqual(budget / 4 + frame);
  }, 10_000);

  it("a chunk the channel refuses (full beside a file) goes again later, and the read still arrives", async () => {
    const { a, b } = await pair();
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film") as { serve: string };
    const send = a.channel!.send.bind(a.channel!);
    let refusals = 0;
    a.channel!.send = data => {
      if (typeof data !== "string" && data[0] === APP_RANGE_DATA_KIND && refusals < 2) { refusals++; throw new Error("Send budget is full"); }
      send(data);
    };
    const read = await settled(b.link.readAppRange(APP, served.serve, 0, 40_000));
    expect(refusals).toBe(2);
    expect(read).toEqual({ value: { bytes: FILM.subarray(0, 40_000), size: FILM.length } });
  }, 10_000);

  it("serves only while the app is open on both sides, and says why not", async () => {
    const { a, b } = await pair();
    expect(a.link.serveAppFile(APP, "film")).toEqual({ error: "not-open" });
    a.link.openApp(APP, "1.0.0");
    await vi.waitFor(() => expect(b.link.peerApps.has(APP)).toBe(true));
    expect(a.link.serveAppFile(APP, "film")).toEqual({ error: "peer-closed" });
    expect(await settled(b.link.readAppRange(APP, toBase64Url(new Uint8Array(16)), 0, 1))).toEqual({ error: "not-open" });
    b.link.openApp(APP, "1.0.0");
    await vi.waitFor(() => expect(a.link.peerApps.has(APP)).toBe(true));
    expect(await settled(b.link.readAppRange(APP, toBase64Url(new Uint8Array(16)), 0, 1))).toEqual({ error: "not-served" });
    expect(await settled(b.link.readAppRange(APP, (a.link.serveAppFile(APP, "gone") as { serve: string }).serve, 0, 1))).toEqual({ error: "gone" });
  });

  it("the contact closing its app ends what was served, and reads in flight fail", async () => {
    const { a, b } = await pair({ hold: true });
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film") as { serve: string };
    const reading = b.link.readAppRange(APP, served.serve, 0, 1);
    await vi.waitFor(() => expect(a.tasks).toHaveLength(1));
    b.link.closeApp(APP);
    expect(await settled(reading)).toEqual({ error: "offline" });
    await vi.waitFor(() => expect(a.link.appServes(APP)).toEqual([]));
    expect(a.tasks[0].live).toBe(false);
  });

  it("a session that ends takes its serve ids with it", async () => {
    const { a, b } = await pair({ hold: true });
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film") as { serve: string };
    const reading = b.link.readAppRange(APP, served.serve, 0, 1);
    await vi.waitFor(() => expect(a.tasks).toHaveLength(1));
    a.channel!.close();
    expect(await settled(reading)).toEqual({ error: "offline" });
    await vi.waitFor(() => expect(a.link.isDataLinkOpen).toBe(false));
    expect(a.link.appServes(APP)).toEqual([]);
    expect(a.tasks[0].live).toBe(false);
  });

  it("a contact's get and cancel loop meets busy past 4 until this side settles what it was reading", async () => {
    const { a, b } = await pair({ hold: true });
    await opened(a, b);
    const served = a.link.serveAppFile(APP, "film") as { serve: string };
    const raw = (frame: object) => b.channel!.send(JSON.stringify(frame));
    for (let r = 0; r < 50; r++) {
      raw({ t: "ar-get", a: APP, s: served.serve, r, o: 0, n: APP_RANGE_LIMITS.requestBytes });
      raw({ t: "ar-cancel", a: APP, r });
    }
    const busy = () => rangeFrames(a.channel!).filter(data => (data as string).includes('"busy"')).length;
    await vi.waitFor(() => expect(busy()).toBe(50 - APP_RANGE_LIMITS.inFlight));
    expect(a.tasks).toHaveLength(APP_RANGE_LIMITS.inFlight);
    expect(a.tasks.every(task => !task.live)).toBe(true);
    // The owner settles two, as it must even when they are no longer live: two places free, and nothing goes for them.
    const sent = a.channel!.sent.length;
    a.link.failAppRange(a.tasks[0], "gone");
    await a.link.sendAppRange(a.tasks[1], FILM.subarray(0, 10), FILM.length);
    expect(a.channel!.sent.length).toBe(sent);
    for (const r of [50, 51, 52]) raw({ t: "ar-get", a: APP, s: served.serve, r, o: 0, n: 1 });
    await vi.waitFor(() => expect(busy()).toBe(50 - APP_RANGE_LIMITS.inFlight + 1));
    expect(a.tasks).toHaveLength(APP_RANGE_LIMITS.inFlight + 2);
  });

  it("is not offered without apps/1, nor by a side that does not ask for it, and its frames are dropped then", async () => {
    const { a, b } = await pair({ b: { appRangesSupport: false } });
    await opened(a, b);
    expect(a.link.supportsAppRanges || b.link.supportsAppRanges).toBe(false);
    expect(a.link.serveAppFile(APP, "film")).toEqual({ error: "peer-closed" });
    // An ar-get sent anyway is dropped unanswered.
    b.channel!.send(JSON.stringify({ t: "ar-get", a: APP, s: toBase64Url(new Uint8Array(16)), r: 1, o: 0, n: 1 }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rangeFrames(a.channel!)).toEqual([]);
    expect(a.tasks).toEqual([]);
  });
});
