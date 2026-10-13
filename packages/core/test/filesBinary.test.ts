import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, FILE_DATA_KIND, FILE_LIMITS, encodeFileData, type ChatFilesHost, type FileTransferRecord } from "../src/chatFiles";
import type { FrameChannel } from "../src/frames";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { FILES_BINARY_CAPABILITY, FILES_CAPABILITY, KNOWN_SESSION_CAPABILITIES } from "../src/pairedCapabilities";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import { toBase64Url } from "../src/bytes";
// covers: files.large.binary, files.large.integrity

// Two GhostLinks over an in-memory channel with a real PairedSession handshake (the harness of pairedApps.test.ts).
// Each end says whether it carries binary messages, as a WebRTC channel does and the native ones do not.

const hex = (c: string) => c.repeat(64);
type Data = string | Uint8Array;
type End = FrameChannel & { peer?: End; closed: boolean; receive(data: Data): void; sent: Data[] };

function channelPair(binary: { a: boolean; b: boolean }): [End, End] {
  const make = (carries: boolean): End => {
    let reader: FrameChannel["onMessage"] = null;
    const waiting: Data[] = [];
    return {
      closed: false, bufferedAmount: 0, onClose: null, drained: () => Promise.resolve(), sent: [],
      ...(carries && { binary: true }),
      get onMessage() { return reader; },
      set onMessage(value) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
      receive(data) { if (this.closed) return; if (reader) reader(data); else waiting.push(data); },
      send(data) {
        if (this.closed) throw new Error("Channel closed");
        if (typeof data !== "string" && !carries) throw new Error("Text only");
        this.sent.push(data);
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(binary.a), b = make(binary.b);
  a.peer = b; b.peer = a;
  return [a, b];
}

interface Side { link: GhostLink; frames: Record<string, unknown>[]; channel?: End }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

async function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; binary?: { a: boolean; b: boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const sides: Partial<Record<"a" | "b", Side>> = {};
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const frames: Record<string, unknown>[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { id: name.repeat(64), relay: null, addresses: ["127.0.0.1:1"] }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        // Only "a" dials.
        const [mine, theirs] = channelPair(options.binary ?? { a: true, b: true });
        sides.a!.channel = mine; sides.b!.channel = theirs;
        queueMicrotask(() => endpoints.b.onConnection?.({ channel: theirs, binding }));
        return { channel: mine, binding };
      },
    };
    endpoints[name] = endpoint;
    const link = new GhostLink({
      params: { ...params, profile: "paired-chat/1" },
      rtcAvailable: false,
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": { id: (name === "a" ? "b" : "a").repeat(64), relay: null, addresses: ["127.0.0.1:1"] } }, peerTransports: ["iroh/1"] },
      pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      createPeerConnection: () => { throw new Error("No WebRTC here"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      largeFilesSupport: true, binaryFilesSupport: true,
      ...extra,
      events: { onFilesFrame: frame => { frames.push(frame); }, ...extra.events },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, frames };
  };
  const a = sides.a = make("a", invitation.mine, ia, ib, options.a);
  const b = sides.b = make("b", invitation.invite, ib, ia, options.b);
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.supportsLargeFiles && b.link.supportsLargeFiles).toBe(true));
  return { a, b };
}

const ID = "AbCdEfGh_-0123456789xy";
const bytes = (length: number, seed = 3) => Uint8Array.from({ length }, (_, i) => (i * 131 + seed) & 0xff);
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const mine = (side: Side) => side.link.sessionOffers.mine;

describe("files/4 on a paired session", () => {
  it("is a session capability this app knows, beside files/3", () => {
    expect(FILES_BINARY_CAPABILITY).toBe("files/4");
    expect(KNOWN_SESSION_CAPABILITIES).toContain(FILES_BINARY_CAPABILITY);
  });

  it("both offer it on a channel that carries binary: a file's bytes sent as a binary message reach the owner as the pf-data frame they stand for", async () => {
    const { a, b } = await pair();
    expect(mine(a)).toEqual(expect.arrayContaining([FILES_CAPABILITY, FILES_BINARY_CAPABILITY]));
    expect(a.link.sessionOffers.peer).toContain(FILES_BINARY_CAPABILITY);
    expect(a.link.supportsBinaryFiles && b.link.supportsBinaryFiles).toBe(true);
    const chunk = bytes(FILE_LIMITS.chunkBytes);
    b.channel!.send(encodeFileData(ID, 5 * 2 ** 32 + 16_384, chunk));
    await vi.waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]).toEqual({ t: "pf-data", id: ID, offset: 5 * 2 ** 32 + 16_384, data: chunk });
    // The JSON frame still comes through, on the same session.
    b.link.sendFilesFrame({ t: "pf-data", id: ID, offset: 0, data: toBase64Url(bytes(10)) });
    await vi.waitFor(() => expect(a.frames).toHaveLength(2));
    expect(a.frames[1]).toEqual({ t: "pf-data", id: ID, offset: 0, data: toBase64Url(bytes(10)) });
  });

  it("a binary message that is not a file's data is dropped, and the session goes on", async () => {
    const { a, b } = await pair();
    const good = encodeFileData(ID, 0, bytes(100));
    const otherKind = good.slice(); otherKind[0] = 3;
    const badId = good.slice(); badId[5] = 0x20;
    for (const message of [new Uint8Array(0), Uint8Array.of(4), otherKind, badId, good.subarray(0, 2 + ID.length + 8), new Uint8Array(70 * 1024)]) {
      if (message.length <= 60 * 1024) b.channel!.send(message);
    }
    b.channel!.send(good);
    await vi.waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]).toMatchObject({ t: "pf-data", id: ID, offset: 0 });
    expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true);
  });

  it("is not offered on a channel that carries text only, and a binary message there is dropped", async () => {
    const { a, b } = await pair({ binary: { a: false, b: true } });
    await vi.waitFor(() => expect(b.link.sessionOffers.peer).not.toBeNull());
    expect(mine(a)).toContain(FILES_CAPABILITY);
    expect(mine(a)).not.toContain(FILES_BINARY_CAPABILITY);
    expect(mine(b)).toContain(FILES_BINARY_CAPABILITY);
    expect(a.link.supportsBinaryFiles || b.link.supportsBinaryFiles).toBe(false);
    b.channel!.send(encodeFileData(ID, 0, bytes(100)));
    await pause();
    expect(a.frames).toEqual([]);
    expect(a.link.isDataLinkOpen).toBe(true);
  });

  it("is not offered by an app that does not ask for it (a group's edge), and what comes as binary then is dropped", async () => {
    const { a, b } = await pair({ a: { binaryFilesSupport: false } });
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).toContain(FILES_BINARY_CAPABILITY));
    expect(mine(a)).not.toContain(FILES_BINARY_CAPABILITY);
    expect(a.link.supportsBinaryFiles || b.link.supportsBinaryFiles).toBe(false);
    b.channel!.send(encodeFileData(ID, 0, bytes(100)));
    await pause();
    expect(a.frames).toEqual([]);
  });
});

describe("files/4 in a transfer", () => {
  /** A receiver alone: what it is sent is handed to it, what it answers is kept. */
  function receiver() {
    const sent: Record<string, unknown>[] = [];
    const stored: number[] = [];
    const hash = createHash("sha256");
    const records = new Map<string, FileTransferRecord>();
    const host: ChatFilesHost = {
      send: (frame) => { sent.push(frame); return true; },
      decide: async () => "accept",
      openTarget: async () => ({
        offset: 0,
        append: async (chunk) => { hash.update(chunk); stored.push(...chunk); },
        flush: async () => {},
        verify: async (digest) => hash.copy().digest("base64url") === digest,
        discard: async () => { stored.length = 0; },
      }),
      openSource: async () => { throw new Error("nothing is sent here"); },
      changed: (record) => { records.set(record.id, record); },
      room: async () => 1024 ** 3,
    };
    const files = new ChatFiles(host);
    files.attach();
    return { files, sent, stored, records, last: (t: string) => sent.filter(frame => frame.t === t).at(-1) };
  }

  it("a receiver stores data that comes as bytes, as text, or as both in one transfer, and the digest holds", async () => {
    const size = 3 * FILE_LIMITS.chunkBytes + 777, file = bytes(size, 11);
    const r = receiver();
    await r.files.handle({ t: "pf-offer", id: ID, name: "a.bin", mime: "application/octet-stream", size, ts: 1 });
    await vi.waitFor(() => expect(r.last("pf-accept")).toEqual({ t: "pf-accept", id: ID, offset: 0 }));
    for (let offset = 0, n = 0; offset < size; offset += FILE_LIMITS.chunkBytes, n++) {
      const chunk = file.subarray(offset, offset + FILE_LIMITS.chunkBytes);
      // Every other chunk as text: a sender follows the session, and a transfer may cross from one form to the other.
      await r.files.handle({ t: "pf-data", id: ID, offset, data: n % 2 ? toBase64Url(chunk) : chunk });
    }
    await vi.waitFor(() => expect(r.last("pf-got")).toEqual({ t: "pf-got", id: ID, offset: size }));
    await r.files.handle({ t: "pf-sum", id: ID, size, digest: createHash("sha256").update(file).digest("base64url") });
    await vi.waitFor(() => expect(r.last("pf-done")).toEqual({ t: "pf-done", id: ID }));
    expect(Uint8Array.from(r.stored)).toEqual(file);
    expect(r.records.get(ID)?.state).toBe("done");
  });

  it("bytes past the file's end, more than a chunk of them, or none are not stored; a gap is answered as with text", async () => {
    const size = 1000;
    const r = receiver();
    await r.files.handle({ t: "pf-offer", id: ID, name: "a.bin", mime: "application/octet-stream", size, ts: 1 });
    await vi.waitFor(() => expect(r.last("pf-accept")).toBeDefined());
    await r.files.handle({ t: "pf-data", id: ID, offset: 0, data: new Uint8Array(0) });
    await r.files.handle({ t: "pf-data", id: ID, offset: 0, data: bytes(size + 1) });
    await r.files.handle({ t: "pf-data", id: ID, offset: 0, data: bytes(FILE_LIMITS.chunkBytes + 1) });
    await r.files.handle({ t: "pf-data", id: ID, offset: 0, data: [1, 2, 3] });
    await pause();
    expect(r.stored).toEqual([]);
    expect(r.last("pf-got")).toBeUndefined();
    await r.files.handle({ t: "pf-data", id: ID, offset: 500, data: bytes(100) });
    await vi.waitFor(() => expect(r.sent.filter(frame => frame.t === "pf-accept")).toHaveLength(2));
    expect(r.last("pf-accept")).toEqual({ t: "pf-accept", id: ID, offset: 0 });
    await r.files.handle({ t: "pf-data", id: ID, offset: 0, data: bytes(size) });
    await vi.waitFor(() => expect(r.last("pf-got")).toEqual({ t: "pf-got", id: ID, offset: size }));
    expect(r.stored).toHaveLength(size);
  });
});

describe("files/4 from one app to another", () => {
  /** A chat's files on a link, as the app wires them: frames and data go out through the link, frames come in from it. */
  function desk(side: Side, file?: Uint8Array) {
    const stored: number[] = [];
    const hash = createHash("sha256");
    const records = new Map<string, FileTransferRecord>();
    const files = new ChatFiles({
      send: frame => side.link.sendFilesFrame(frame),
      sendData: (id, offset, data) => side.link.sendFileData(id, offset, data),
      writable: () => side.link.filesWritable(),
      decide: async () => "accept",
      openTarget: async () => ({
        offset: 0,
        append: async (chunk) => { hash.update(chunk); stored.push(...chunk); },
        flush: async () => {},
        verify: async (digest) => hash.copy().digest("base64url") === digest,
        discard: async () => { stored.length = 0; },
      }),
      openSource: async () => ({ read: async (offset, length) => file!.subarray(offset, offset + length), digest: async () => createHash("sha256").update(file!).digest("base64url") }),
      changed: (record) => { records.set(record.id, record); },
      room: async () => 1024 ** 3,
    });
    return { files, stored, records };
  }

  async function transfer(options: Parameters<typeof pair>[0]) {
    const size = 20 * FILE_LIMITS.chunkBytes + 4321, file = bytes(size, 29);
    const queue = { a: [] as Record<string, unknown>[], b: [] as Record<string, unknown>[] };
    const desks = {} as Record<"a" | "b", ReturnType<typeof desk>>;
    // Frames are handed over in the order they came, one at a time, as the session's queue does.
    const events = (name: "a" | "b") => {
      let chain = Promise.resolve();
      return { onFilesFrame: (frame: Record<string, unknown>) => { queue[name].push(frame); chain = chain.then(() => desks[name].files.handle(frame)); } };
    };
    const { a, b } = await pair({ ...options, a: { ...options?.a, events: events("a") }, b: { ...options?.b, events: events("b") } });
    desks.a = desk(a, file); desks.b = desk(b);
    desks.a.files.attach(); desks.b.files.attach();
    await desks.a.files.offer({ id: ID, name: "a.bin", mime: "application/octet-stream", size, timestamp: 1 });
    await vi.waitFor(() => expect(desks.a.records.get(ID)?.state).toBe("done"), { timeout: 10_000 });
    expect(desks.b.records.get(ID)?.state).toBe("done");
    expect(Uint8Array.from(desks.b.stored)).toEqual(file);
    const binary = a.channel!.sent.filter((data): data is Uint8Array => typeof data !== "string");
    const text = a.channel!.sent.filter((data): data is string => typeof data === "string" && data.startsWith('{"t":"pf-data"'));
    const wire = [...binary, ...text].reduce((sum, data) => sum + data.length, 0);
    return { size, binary, text, wire, a, b };
  }

  it("while both agreed files/4, every chunk goes as a binary message: the file costs 0.2% more on the wire, not a third", async () => {
    const { size, binary, text, wire, b } = await transfer({});
    expect(text).toEqual([]);
    expect(binary).toHaveLength(21);
    expect(binary.every(message => message[0] === FILE_DATA_KIND)).toBe(true);
    expect(wire).toBe(size + 21 * (2 + ID.length + 8));
    expect(wire / size).toBeLessThan(1.003);
    // Nothing binary came the other way: answers stay frames.
    expect(b.channel!.sent.every(data => typeof data === "string")).toBe(true);
  });

  it("with a contact that does not offer files/4 (an older app), every chunk goes as a pf-data frame, as before", async () => {
    const { size, binary, text, wire } = await transfer({ b: { binaryFilesSupport: false } });
    expect(binary).toEqual([]);
    expect(text).toHaveLength(21);
    expect(wire / size).toBeGreaterThan(1.33);
  });

  it("on a session whose channel carries text only, every chunk goes as a pf-data frame", async () => {
    const { binary, text } = await transfer({ binary: { a: false, b: false } });
    expect(binary).toEqual([]);
    expect(text).toHaveLength(21);
  });
});
