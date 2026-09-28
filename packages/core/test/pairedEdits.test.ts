import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { EDIT_CAPABILITY, SessionCapabilities } from "../src/pairedCapabilities";
import {
  EDIT_FRAME, EDIT_RATE_WINDOW_MS, EDIT_RECEIVE_LIMIT, MAX_EDITS_PER_MESSAGE, RateWindow,
  dhtEditId, editFrame, editedFrame, parseEditFrame, parseEditedFrame, validEditMessage, validEditNumber, type WireEdit,
} from "../src/pairedEdits";
import { LIMITS } from "../src/frames";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import type { PairingCredentials } from "../src/pairedSession";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.edit.wire

afterEach(() => { vi.useRealTimers(); });

const ID = "A".repeat(21) + "b";
const edit = (fields: Partial<WireEdit> = {}): WireEdit => ({ id: ID, e: 1, ts: 1_790_000_000_000, m: "Done: 3 of 3", ...fields });
const parse = (value: unknown) => parseEditFrame(JSON.parse(typeof value === "string" ? value : JSON.stringify(value)));

describe("paired-edit frames", () => {
  it("encode the whole new text with its number, and read back", () => {
    expect(editFrame(edit())).toBe(`{"t":"paired-edit","id":"${ID}","e":1,"ts":1790000000000,"m":"Done: 3 of 3"}`);
    expect(parse(editFrame(edit({ e: 7 })))).toEqual(edit({ e: 7 }));
    expect(editedFrame(ID, 7)).toBe(`{"t":"paired-edited","id":"${ID}","e":7}`);
    expect(parseEditedFrame(JSON.parse(editedFrame(ID, 7)))).toEqual({ id: ID, e: 7 });
  });

  it("refuse a malformed edit: its id, its number, its time, its text", () => {
    const base = JSON.parse(editFrame(edit()));
    const bad = [
      { ...base, t: "paired-message" }, { ...base, id: "short" }, { ...base, id: ID + "x" }, { ...base, id: 7 },
      { ...base, e: 0 }, { ...base, e: MAX_EDITS_PER_MESSAGE + 1 }, { ...base, e: 1.5 }, { ...base, e: "2" },
      { ...base, ts: 0 }, { ...base, ts: -5 }, { ...base, ts: 1.5 }, { ...base, ts: "now" },
      { ...base, m: "" }, { ...base, m: "   " }, { ...base, m: " padded " }, { ...base, m: 5 },
      { ...base, m: "x".repeat(LIMITS.maxChatMessageBytes + 1) }, { ...base, m: "é".repeat(LIMITS.maxChatMessageBytes / 2 + 1) },
    ];
    for (const frame of bad) expect(parseEditFrame(frame)).toBeNull();
    expect(parseEditFrame({ ...base, m: "x".repeat(LIMITS.maxChatMessageBytes) })).not.toBeNull();
    expect(validEditNumber(MAX_EDITS_PER_MESSAGE)).toBe(true);
    for (const frame of [{ t: "paired-edited", id: ID, e: 0 }, { t: "paired-edited", id: "x", e: 1 }, { t: "paired-received", id: ID, e: 1 }])
      expect(parseEditedFrame(frame)).toBeNull();
  });

  it("keep a preview only for a link in the new text; a bad one drops, never the edit", () => {
    const pv = { u: "https://ghostly.tools/", t: "Ghostly" };
    expect(parse(editFrame(edit({ m: "see https://ghostly.tools/", pv })))?.pv).toEqual(pv);
    const stale = parse(editFrame(edit({ m: "no link any more", pv })));
    expect(stale).toEqual(edit({ m: "no link any more" }));
    // Too large with it: the preview is left out, the text goes.
    const huge = editFrame(edit({ m: "see https://ghostly.tools/ " + "x".repeat(15_000), pv: { ...pv, i: "data:image/png;base64," + "A".repeat(50_000) } as never }));
    expect(JSON.parse(huge).pv).toBeUndefined();
  });

  it("is a session capability both sides must list", () => {
    const caps = new SessionCapabilities(() => [EDIT_CAPABILITY]);
    expect(caps.receive({ c: ["typing/1"] })).toEqual([]);
    expect(caps.agreed(EDIT_CAPABILITY)).toBe(false);
    expect(caps.receive({ c: ["typing/1", "edit/1"] })).toEqual([EDIT_CAPABILITY]);
  });
});

describe("RateWindow", () => {
  it("lets `limit` through per window and says how long until the next", () => {
    let now = 0;
    const window = new RateWindow(3, 1_000, () => now);
    expect([window.take(), window.take(), window.take(), window.take()]).toEqual([true, true, true, false]);
    now = 400;
    expect(window.wait()).toBe(600);
    now = 1_000;
    expect(window.wait()).toBe(0);
    expect(window.take()).toBe(true);
    window.reset();
    expect(window.wait()).toBe(0);
  });
});

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake
// (the harness of pairedCallsServices.test.ts).

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

interface Side { link: GhostLink; endpoint: NativeEndpoint; edits: WireEdit[]; receipts: [string, number][]; support: boolean[]; messages: string[]; sent: string[] }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const edits: WireEdit[] = [], receipts: [string, number][] = [], support: boolean[] = [], messages: string[] = [], sent: string[] = [];
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
      editSupport: true,
      ...extra,
      events: {
        onMessageEdit: edit => { edits.push(edit); return true; },
        onEditReceipt: (id, e) => { receipts.push([id, e]); },
        onEditSupport: on => { support.push(on); },
        onMessage: message => { messages.push(message.text); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, edits, receipts, support, messages, sent };
  };
  const sides: Partial<Record<"a" | "b", Side>> = {};
  sides.a = make("a", invitation.mine, ia, ib, options.a);
  sides.b = make("b", invitation.invite, ib, ia, options.b);
  return { a: sides.a, b: sides.b };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

const editsSent = (side: Side) => side.sent.filter(data => data.includes(`"t":"${EDIT_FRAME}"`));
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("an edit's text", () => {
  it("is never blank or padded, on a session or on the DHT", () => {
    expect(validEditMessage("new text")).toBe(true);
    for (const m of ["", "   ", " padded", "padded\n", 5, null]) expect(validEditMessage(m)).toBe(false);
    expect(validEditMessage("x".repeat(LIMITS.maxChatMessageBytes + 1))).toBe(false);
  });
});

describe("edits on a paired session (edit/1)", () => {
  it("A edits, B is told the new text, and B's confirmation reaches A", async () => {
    const { a, b } = pair();
    expect(await a.link.sendEdit(edit())).toMatch(/live/);
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsEdits && b.link.supportsEdits).toBe(true));
    expect(a.support).toContain(true);
    expect(a.link.sessionOffers.peer).toContain("edit/1");
    expect(await a.link.sendMessage("Working…", Date.now(), ID)).toBeNull();
    await vi.waitFor(() => expect(b.messages).toEqual(["Working…"]));
    for (const e of [1, 2, 3]) expect(await a.link.sendEdit(edit({ e, m: `Step ${e}` }))).toBeNull();
    await vi.waitFor(() => expect(a.receipts).toEqual([[ID, 1], [ID, 2], [ID, 3]]));
    expect(b.edits.map(x => [x.e, x.m])).toEqual([[1, "Step 1"], [2, "Step 2"], [3, "Step 3"]]);
    // Nothing of it is a message.
    expect(b.messages).toEqual(["Working…"]);
  });

  it("confirms only when the receiver says so; a waiting edit is confirmed later", async () => {
    let answer = false;
    const { a, b } = pair({ b: { events: { onMessageEdit: () => answer } } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsEdits && b.link.supportsEdits).toBe(true));
    expect(await a.link.sendEdit(edit({ e: 4 }))).toBeNull();
    await settle();
    expect(a.receipts).toEqual([]);
    b.link.confirmEdit(ID, 4);
    await vi.waitFor(() => expect(a.receipts).toEqual([[ID, 4]]));
    answer = true;
  });

  it("an app that does not offer edit/1 gets nothing, and what it sends is not read", async () => {
    const { a, b } = pair({ b: { editSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsEdits).toBe(false);
    expect(await a.link.sendEdit(edit())).toMatch(/does not show edits/);
    expect(editsSent(a)).toEqual([]);
    // Nor can B say one.
    expect(await b.link.sendEdit(edit())).not.toBeNull();
    await settle();
    expect(a.edits).toEqual([]);
  });

  it("an older app that never says its capabilities gets nothing", async () => {
    const { a, b } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsEdits).toBe(true));
    expect(a.link.supportsEdits).toBe(false);
    expect(await a.link.sendEdit(edit())).not.toBeNull();
    expect(editsSent(a)).toEqual([]);
  });

  it("takes at most the receive limit per window; the rest go unconfirmed", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsEdits && b.link.supportsEdits).toBe(true));
    for (let e = 1; e <= EDIT_RECEIVE_LIMIT + 5; e++) await a.link.sendEdit(edit({ e: Math.min(e, MAX_EDITS_PER_MESSAGE) }));
    await vi.waitFor(() => expect(a.receipts).toHaveLength(EDIT_RECEIVE_LIMIT));
    await settle();
    expect(b.edits).toHaveLength(EDIT_RECEIVE_LIMIT);
    expect(EDIT_RATE_WINDOW_MS).toBeGreaterThan(0);
  });

  it("ignores edits from a connection that never authenticated as the pinned contact", async () => {
    const { a } = pair();
    const [mine, theirs] = channelPair();
    a.endpoint.onConnection?.({ channel: theirs, binding: { transport: "iroh/1", context: hex("d"), identities: [hex("a"), hex("d")] } });
    for (let e = 1; e <= 3; e++) mine.send(editFrame(edit({ e })));
    await settle();
    expect(a.edits).toEqual([]);
  });
});

// Fake time runs the relays' pace; a slow runner needs more than the default 5 s of real time for it.
describe("an edit over the DHT floor", { timeout: 30_000 }, () => {
  type Got = { id: string; text: string; edit?: { i: string; e: number } };
  function setup() {
    const invitation = createLink(), params = [invitation.mine, invitation.invite];
    const packets = new Map<string, SignedPacket>();
    const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
    const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
    const got: Got[][] = [[], []];
    const publish = vi.fn(async (identity, records) => {
      const wire = createRelayPayload(identity, records);
      expect(wire.length).toBeLessThanOrEqual(1072);
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, wire));
    });
    const make = (i: number) => new DhtDelivery({ params: params[i], mode: "dht", state: saved[i], credentials: credentials[i],
      transport: { publish, resolve: vi.fn(async key => packets.get(key) ?? null), describe: () => ({ protocol: "signed-packet fixture", relays: [] }) },
      save: async state => { saved[i] = structuredClone(state); }, pin: async key => { credentials[i].peerKey = key; },
      message: async m => { got[i].push({ id: m.id, text: m.text, ...(m.edit && { edit: m.edit }) }); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    return { make, got, saved };
  }

  it("goes as a text of its own id with the edited message's id and number beside it", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    const id = dhtEditId(ID, 2);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(dhtEditId(ID, 2)).toBe(id);
    expect(dhtEditId(ID, 3)).not.toBe(id);
    expect(await a.send("Done: 3 of 3", Date.now(), id, undefined, [ID, 2])).toBeNull();
    expect(h.saved[0].pending?.edit).toEqual([ID, 2]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.got[1]).toEqual([{ id, text: "Done: 3 of 3", edit: { i: ID, e: 2 } }]);
    // A text that edits nothing says nothing of the kind.
    expect(await b.send("ok", Date.now(), "bcdefghijklmnopqrstuvw")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.got[0]).toEqual([{ id: "bcdefghijklmnopqrstuvw", text: "ok" }]);
    await a.stop(); await b.stop();
  });

  it("rides in the same envelope as reactions: the edit twelfth, the reactions after it", async () => {
    vi.useFakeTimers();
    const invitation = createLink(), params = [invitation.mine, invitation.invite];
    const packets = new Map<string, SignedPacket>();
    const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
    const got: { id: string; edit?: { i: string; e: number } }[] = [], reactions: { id: string; e: string; n: number }[] = [];
    const transport = { publish: vi.fn(async (identity, records) => { packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records))); }),
      resolve: vi.fn(async (key: string) => packets.get(key) ?? null), describe: () => ({ protocol: "signed-packet fixture", relays: [] }) };
    const make = (i: number, extra = {}) => new DhtDelivery({ params: params[i], mode: "dht", state: emptyDhtDeliveryState(), credentials: credentials[i], transport,
      save: async () => {}, pin: async key => { credentials[i].peerKey = key; }, message: async m => { got.push({ id: m.id, ...(m.edit && { edit: m.edit }) }); },
      receipt: async () => {}, changed: () => {}, pollMs: 100, ...extra });
    const a = make(0, { reactions: () => [{ id: "R".repeat(22), e: "👍", n: 7 }] }), b = make(1, { reaction: async (r: { id: string; e: string; n: number }) => { reactions.push(r); } });
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    expect(await a.send("Done", Date.now(), dhtEditId(ID, 1), undefined, [ID, 1])).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([{ id: dhtEditId(ID, 1), edit: { i: ID, e: 1 } }]);
    expect(reactions).toContainEqual({ id: "R".repeat(22), e: "👍", n: 7 });
    await a.stop(); await b.stop();
  });

  it("refuses a malformed edit, and one that does not fit is refused, never sent as a plain text", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    const id = dhtEditId(ID, 1);
    expect(a.validate("x", Date.now(), id, undefined, ["short", 1])).toBe("Invalid message.");
    expect(a.validate("x", Date.now(), id, undefined, [ID, 0])).toBe("Invalid message.");
    expect(a.validate("x", Date.now(), id, "C".repeat(22), [ID, 1])).toBe("Invalid message.");
    expect(a.validate("x".repeat(257), Date.now(), id, undefined, [ID, 1])).toMatch(/256/);
    // Near the bound, the text and its element do not both fit: refused (it waits for a live session), not cut down.
    expect(a.validate("x".repeat(250), Date.now(), id, undefined, [ID, 1])).toMatch(/packet budget/);
    expect(a.validate("x".repeat(250), Date.now(), id)).toBeNull();
    expect(a.validate("x".repeat(200), Date.now(), id, undefined, [ID, 1])).toBeNull();
    await a.stop(); await b.stop();
  });
});
