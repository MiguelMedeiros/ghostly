import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, MESSAGE_PACED, MESSAGE_RECEIVE_LIMITS, pairedMessageFrame, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.paired.send, chat.paired.receipts

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake (pairedEdits.test.ts).
// B's own channel end is kept, so the test can say frames B's app would never send.

const hex = (c: string) => c.repeat(64);
const links: GhostLink[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(links.splice(0).map(link => link.stop(false))); });

function channelPair(sent: string[]): [FrameChannel, FrameChannel] {
  type End = FrameChannel & { peer?: End; closed: boolean; receive(data: string): void };
  const make = (log?: string[]): End => {
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
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(sent), b = make();
  a.peer = b; b.peer = a;
  return [a, b];
}

/** A dials B; `a.sent` is what A says on the session, `a.messages` the texts A was handed. */
function pair() {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const sent: string[] = [], messages: string[] = [];
  let theirs: FrameChannel | null = null;
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}) => {
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { id: name.repeat(64), relay: null, addresses: ["127.0.0.1:1"] }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        const [mine, other] = channelPair(sent);
        theirs = other;
        queueMicrotask(() => endpoints.b.onConnection?.({ channel: other, binding }));
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
      createPeerConnection: () => { throw new Error("The chat runs on Iroh here: no WebRTC"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      ...extra,
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return link;
  };
  const a = make("a", invitation.mine, ia, ib, { events: { onMessage: message => { messages.push(message.text); } } });
  const b = make("b", invitation.invite, ib, ia);
  return { a, b, sent, messages, theirs: () => theirs! };
}

const id = (n: number) => n.toString().padStart(22, "0");
const receipts = (sent: string[]) => sent.filter(data => data.includes('"t":"paired-received"')).length;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("texts a contact sends on a paired session", () => {
  it("are taken up to a burst per window and a total per hour; the rest go unconfirmed, and come again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b, sent, messages, theirs } = pair();
    await a.connect(10_000);
    await vi.waitFor(() => expect(a.isDataLinkOpen && b.isDataLinkOpen).toBe(true));
    const { burst, burstWindowMs, hourly, hourWindowMs } = MESSAGE_RECEIVE_LIMITS;
    let n = 0;
    // B's app paces itself to these windows: a modified one, said straight on B's end of the session, floods A's chat.
    const flood = async (count: number) => {
      for (let i = 0; i < count; i++, n++) theirs().send(pairedMessageFrame(id(n), 1_790_000_000_000 + n, `text ${n}`));
      await settle();
    };
    await flood(burst + 20);
    expect(messages).toHaveLength(burst);
    expect(receipts(sent)).toBe(burst);
    // The next window takes the next burst.
    vi.setSystemTime(Date.now() + burstWindowMs);
    await flood(burst);
    expect(messages).toHaveLength(2 * burst);
    // Window after window, up to the hour's total: past it, a fresh short window does not help.
    while (messages.length < hourly) { vi.setSystemTime(Date.now() + burstWindowMs); await flood(burst); }
    expect(messages).toHaveLength(hourly);
    vi.setSystemTime(Date.now() + burstWindowMs);
    await flood(5);
    expect(messages).toHaveLength(hourly);
    expect(receipts(sent)).toBe(hourly);
    // An hour on, a text is taken again; the session stayed open all along.
    vi.setSystemTime(Date.now() + hourWindowMs);
    await flood(1);
    expect(messages).toHaveLength(hourly + 1);
    expect(a.isDataLinkOpen && b.isDataLinkOpen).toBe(true);
  }, 60_000);

  it("the sender keeps within the contact's windows: a text with no room does not go until there is, so none is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b, sent, messages } = pair();
    await a.connect(10_000);
    await vi.waitFor(() => expect(a.isDataLinkOpen && b.isDataLinkOpen).toBe(true));
    const { burst, burstWindowMs, hourly, hourWindowMs } = MESSAGE_RECEIVE_LIMITS;
    let n = 0, went = 0;
    // B's own app, as a bot flushing a backlog: whatever does not go now says so, and stays on B's side.
    const send = async (count: number) => {
      const answers: (string | null)[] = [];
      for (let i = 0; i < count; i++, n++) {
        const answer = await b.sendMessage(`text ${n}`, 1_790_000_000_000 + n, id(n));
        answers.push(answer);
        if (answer === null) went++;
      }
      await settle();
      return answers;
    };
    const answers = await send(burst + 20);
    expect(answers.slice(0, burst).every(answer => answer === null)).toBe(true);
    expect(answers.slice(burst).every(answer => answer === MESSAGE_PACED)).toBe(true);
    expect(b.textRoom).toBe(false);
    // Everything that went was taken and confirmed: nothing went to be refused and come again after later texts.
    expect(messages).toHaveLength(went);
    expect(receipts(sent)).toBe(went);
    // The window counts from the receipts: once it is over, there is room again.
    vi.setSystemTime(Date.now() + burstWindowMs);
    expect(b.textRoom).toBe(true);
    // Window after window up to the hour's total, never past it: past it a fresh short window does not open room.
    while (went < hourly) { await send(burst); vi.setSystemTime(Date.now() + burstWindowMs); }
    expect(went).toBe(hourly);
    expect(b.textRoom).toBe(false);
    expect(await send(1)).toEqual([MESSAGE_PACED]);
    expect(messages).toHaveLength(hourly);
    expect(receipts(sent)).toBe(hourly);
    // An hour on, the next one goes and is taken.
    vi.setSystemTime(Date.now() + hourWindowMs);
    expect(b.textRoom).toBe(true);
    expect(await send(1)).toEqual([null]);
    expect(messages).toHaveLength(hourly + 1);
    expect(receipts(sent)).toBe(hourly + 1);
  }, 60_000);

  it("a refused text is counted, not read: a flood of malformed ones does not reach the app either", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { a, b, messages, theirs } = pair();
    await a.connect(10_000);
    await vi.waitFor(() => expect(a.isDataLinkOpen && b.isDataLinkOpen).toBe(true));
    // Said straight on B's end of the session: a frame of a text with no time fills the window and is dropped.
    for (let i = 0; i < MESSAGE_RECEIVE_LIMITS.burst; i++) theirs().send(JSON.stringify({ t: "paired-message", id: id(i), m: "x" }));
    theirs().send(pairedMessageFrame(id(999), 1_790_000_000_000, "a real one"));
    await settle();
    expect(messages).toEqual([]);
  });
});
