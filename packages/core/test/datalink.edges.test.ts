import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataLink, GATHER_ATTEMPTS, GATHER_STALL_MS, REANSWERS, type DataLinkOptions, type DataLinkState } from "../src/datalink";
import { DATA_CHANNEL_ID, DATA_CHANNEL_LABEL, RTC_SIGNAL_MAX_AGE_MS, parseRtcSignal, type RtcSignal } from "../src/signal";

// covers: transport.webrtc, core.frames

const NOW = 1_800_000_000_000;
const CONNECT_TIMEOUT_MS = 90_000;
const DISCONNECT_GRACE_MS = 12_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

let fingerprintSeed = 0;
/** A local SDP that `extractRtcParams` understands, with a fingerprint unique to each connection. */
function sdp(setup: string, candidates = true) {
  const fingerprint = (++fingerprintSeed).toString(16).padStart(2, "0").repeat(32).match(/.{2}/g)!.join(":").toUpperCase();
  return [
    "v=0",
    "a=ice-ufrag:ufrag" + fingerprintSeed,
    "a=ice-pwd:passwordpasswordpassword",
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    ...(candidates ? ["a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host"] : []),
    "",
  ].join("\r\n");
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  binaryType = "blob";
  bufferedAmountLowThreshold = 0;
  constructor(readonly label: string, readonly init: RTCDataChannelInit) {
    super();
  }
  send() {}
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}

class FakePeerConnection extends EventTarget {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  closed = false;
  channel!: FakeDataChannel;
  failRemote = false;
  failOffer = false;
  /** Gathers nothing, ever: Chromium's rare stall under load. */
  stalls = false;
  getConfiguration() {
    return { iceServers: [] };
  }
  createDataChannel(label: string, init: RTCDataChannelInit) {
    this.channel = new FakeDataChannel(label, init);
    return this.channel as unknown as RTCDataChannel;
  }
  async createOffer() {
    if (this.failOffer) throw new Error("no offer");
    return { type: "offer" as const, sdp: sdp("actpass", !this.stalls) };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: sdp("active", !this.stalls) };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.failRemote) throw new Error("bad sdp");
    this.remoteDescription = description;
  }
  close() {
    this.closed = true;
  }
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function link(me: string, peer: string, configure: (pc: FakePeerConnection) => void = () => {}, extra: Partial<DataLinkOptions> = {}) {
  const pcs: FakePeerConnection[] = [];
  const states: DataLinkState[] = [];
  const options = {
    myPubKeyZ32: me,
    peerPubKeyZ32: peer,
    createPeerConnection: () => {
      const pc = new FakePeerConnection();
      configure(pc);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    publishSignal: vi.fn<(signal: string | null) => void>(),
    setFastPoll: vi.fn<(fast: boolean) => void>(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onState: (state: DataLinkState) => void states.push(state),
    ...extra,
  } satisfies DataLinkOptions;
  const dl = new DataLink(options);
  const lastSignal = () => {
    const published = options.publishSignal.mock.calls.map(([s]) => s).filter((s): s is string => s !== null);
    return published.at(-1)!;
  };
  return { dl, pcs, states, options, lastSignal, pc: () => pcs.at(-1)! };
}

const offerFrom = (patch: Partial<RtcSignal> = {}): RtcSignal => ({
  t: "o", ts: NOW, u: "peerufrag", p: "peerpasswordpasswordxx", f: "ab".repeat(32), s: "actpass", c: ["h,10.0.0.2,40000"], ...patch,
});

describe("DataLink handshake", () => {
  it("offers, answers and opens on both sides, publishing and clearing the signals", async () => {
    const a = link("aaaa", "bbbb");
    const b = link("bbbb", "aaaa");

    await a.dl.connect();
    expect(a.dl.state).toBe("offering");
    expect(a.options.setFastPoll).toHaveBeenLastCalledWith(true, true);
    const offer = parseRtcSignal(a.lastSignal())!;
    expect(offer).toMatchObject({ t: "o", ts: NOW, s: "actpass", c: ["h,192.168.1.2,50000"] });
    expect(a.pc().channel.label).toBe(DATA_CHANNEL_LABEL);
    expect(a.pc().channel.init).toEqual({ negotiated: true, id: DATA_CHANNEL_ID, ordered: true });

    vi.advanceTimersByTime(1);
    await b.dl.handleSignal(a.lastSignal());
    expect(b.dl.state).toBe("connecting");
    const answer = parseRtcSignal(b.lastSignal())!;
    expect(answer).toMatchObject({ t: "a", o: offer.ts, s: "active" });
    expect(b.pc().remoteDescription?.type).toBe("offer");

    await a.dl.handleSignal(b.lastSignal());
    expect(a.dl.state).toBe("connecting");
    expect(a.pc().remoteDescription?.type).toBe("answer");

    a.pc().channel.open();
    b.pc().channel.open();
    for (const side of [a, b]) {
      expect(side.dl.state).toBe("open");
      expect(side.options.onOpen).toHaveBeenCalledOnce();
      expect(side.options.publishSignal).toHaveBeenLastCalledWith(null);
      expect(side.options.setFastPoll).toHaveBeenLastCalledWith(false);
    }
    expect(a.states).toEqual(["offering", "connecting", "open"]);
    expect(b.states).toEqual(["answering", "connecting", "open"]);

    const [local, remote] = a.dl.fingerprints!;
    expect(local).toMatch(/^[0-9a-f]{64}$/);
    expect(b.dl.fingerprints).toEqual([remote, local]);
  });

  it("an offerer whose channel opens while it applies the answer stays open", async () => {
    const a = link("aaaa", "bbbb", pc => {
      const apply = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = async description => { await apply(description); pc.channel.open(); };
    });
    const b = link("bbbb", "aaaa");
    await a.dl.connect();
    vi.advanceTimersByTime(1);
    await b.dl.handleSignal(a.lastSignal());
    await a.dl.handleSignal(b.lastSignal());
    expect(a.dl.state).toBe("open");
    expect(a.states).toEqual(["offering", "open"]);
  });

  // Chrome shows the answer as `remoteDescription` only once setRemoteDescription resolves, and on a quick local path the
  // channel's open event can come first. The paired handshake binds to both fingerprints: without the remote one there,
  // the channel was closed as it opened, and a join through a link waited 20 s for the next dial (2026-09-29).
  it("an offerer whose channel opens before the answer shows as applied has both fingerprints", async () => {
    const a = link("aaaa", "bbbb", pc => {
      const apply = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = async description => { pc.channel.open(); await apply(description); };
    });
    const b = link("bbbb", "aaaa");
    const atOpen: ([string, string] | null)[] = [];
    a.options.onOpen.mockImplementation(() => void atOpen.push(a.dl.fingerprints));
    await a.dl.connect();
    vi.advanceTimersByTime(1);
    await b.dl.handleSignal(a.lastSignal());
    await a.dl.handleSignal(b.lastSignal());
    expect(a.dl.state).toBe("open");
    expect(atOpen).toEqual([a.dl.fingerprints]);
    expect(b.dl.fingerprints).toEqual([...a.dl.fingerprints!].reverse());
  });

  it("does not offer again while already busy", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    await a.dl.connect();
    expect(a.pcs).toHaveLength(1);
  });

  it("has no fingerprints before both descriptions are known", async () => {
    const a = link("aaaa", "bbbb");
    expect(a.dl.fingerprints).toBeNull();
    await a.dl.connect();
    expect(a.dl.fingerprints).toBeNull();
  });
});

describe("DataLink refuses signals it must not act on", () => {
  it.each([
    ["malformed JSON", "{"],
    ["an invalid signal", JSON.stringify({ ...offerFrom(), f: "zz" })],
    ["a stale offer", JSON.stringify(offerFrom({ ts: NOW - RTC_SIGNAL_MAX_AGE_MS - 1 }))],
    ["an offer from the future", JSON.stringify(offerFrom({ ts: NOW + RTC_SIGNAL_MAX_AGE_MS + 1 }))],
  ])("ignores %s", async (_, json) => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(json);
    expect(b.dl.state).toBe("idle");
    expect(b.pcs).toHaveLength(0);
  });

  it("accepts an offer right at the age limit", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW - RTC_SIGNAL_MAX_AGE_MS })));
    expect(b.dl.state).toBe("connecting");
  });

  it("ignores a replayed or older offer once one was taken", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    b.pc().channel.open();
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW - 1 })));
    expect(b.pcs).toHaveLength(1);
    expect(b.dl.state).toBe("open");
    expect(b.options.onClose).not.toHaveBeenCalled();
  });

  it("ignores an answer to an offer it did not make, or when it is not offering", async () => {
    const a = link("aaaa", "bbbb");
    const answer = (o: number, ts = NOW + 5) => JSON.stringify({ ...offerFrom({ t: "a", ts, s: "active" }), o });
    await a.dl.handleSignal(answer(NOW));
    expect(a.dl.state).toBe("idle");

    await a.dl.connect();
    await a.dl.handleSignal(answer(NOW - 1));
    expect(a.dl.state).toBe("offering");
    expect(a.pc().remoteDescription).toBeNull();
    await a.dl.handleSignal(answer(NOW, NOW + 6));
    expect(a.dl.state).toBe("connecting");
  });

  it("ignores an offer while it is still answering another", async () => {
    const b = link("bbbb", "aaaa", (pc) => (pc.iceGatheringState = "gathering"));
    const answering = b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.dl.state).toBe("answering");
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 1 })));
    expect(b.pcs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await answering;
    expect(b.dl.state).toBe("connecting");
  });
});

describe("DataLink glare", () => {
  it("keeps its own offer when its key is the lower one", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    await a.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 1 })));
    expect(a.dl.state).toBe("offering");
    expect(a.pcs).toHaveLength(1);
    expect(a.pc().closed).toBe(false);
  });

  it("drops its own offer and answers the peer's when its key is the higher one", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.connect();
    const own = b.pc();
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 1 })));
    expect(own.closed).toBe(true);
    expect(b.pcs).toHaveLength(2);
    expect(b.dl.state).toBe("connecting");
    expect(parseRtcSignal(b.lastSignal())).toMatchObject({ t: "a", o: NOW + 1 });
    // The dropped connection's events no longer count.
    own.channel.open();
    own.setConnectionState("failed");
    expect(b.dl.state).toBe("connecting");
    expect(b.options.onOpen).not.toHaveBeenCalled();
  });
});

describe("DataLink failures and teardown", () => {
  it("returns to idle when creating the offer fails", async () => {
    const a = link("aaaa", "bbbb", (pc) => (pc.failOffer = true));
    await a.dl.connect();
    expect(a.dl.state).toBe("idle");
    expect(a.pc().closed).toBe(true);
    expect(a.options.publishSignal).toHaveBeenLastCalledWith(null);
    expect(a.options.setFastPoll).toHaveBeenLastCalledWith(false);
  });

  it("returns to idle when the peer's offer cannot be applied", async () => {
    const b = link("bbbb", "aaaa", (pc) => (pc.failRemote = true));
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    expect(b.dl.state).toBe("idle");
    expect(b.options.publishSignal.mock.calls.filter(([s]) => s !== null)).toEqual([]);
  });

  it("returns to idle when the peer's answer cannot be applied", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    a.pc().failRemote = true;
    await a.dl.handleSignal(JSON.stringify({ ...offerFrom({ t: "a", ts: NOW + 1, s: "active" }), o: NOW }));
    expect(a.dl.state).toBe("idle");
    expect(a.pc().closed).toBe(true);
  });

  it("gives up on a connection that does not open in time", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
    expect(a.dl.state).toBe("offering");
    vi.advanceTimersByTime(1);
    expect(a.dl.state).toBe("idle");
    expect(a.options.onClose).not.toHaveBeenCalled();
  });

  it("gives an offer the relays held back its whole attempt from when it went out", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    // The relays were down: the offer reached them 60 s after it was made.
    vi.advanceTimersByTime(60_000);
    a.dl.signalWentOut();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
    expect(a.dl.state).toBe("offering");
    vi.advanceTimersByTime(1);
    expect(a.dl.state).toBe("idle");
    // Nothing to extend once the attempt is over, or before one began.
    a.dl.signalWentOut();
    expect(a.dl.state).toBe("idle");
  });

  it("does not time out a connection that opened", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    b.pc().channel.open();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2);
    expect(b.dl.state).toBe("open");
  });

  it("closes an open link when the connection fails or closes", async () => {
    for (const state of ["failed", "closed"] as const) {
      const b = link("bbbb", "aaaa");
      await b.dl.handleSignal(JSON.stringify(offerFrom()));
      b.pc().channel.open();
      b.pc().setConnectionState(state);
      expect(b.dl.state).toBe("idle");
      expect(b.options.onClose).toHaveBeenCalledOnce();
    }
  });

  it("waits out a short disconnection and gives up on a long one", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    b.pc().channel.open();
    b.pc().setConnectionState("disconnected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - 1);
    b.pc().setConnectionState("connected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(b.dl.state).toBe("open");

    b.pc().setConnectionState("disconnected");
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS);
    expect(b.dl.state).toBe("idle");
    expect(b.options.onClose).toHaveBeenCalledOnce();
  });

  it("closes when the data channel closes", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    b.pc().channel.open();
    b.pc().channel.dispatchEvent(new Event("close"));
    expect(b.dl.state).toBe("idle");
    expect(b.options.onClose).toHaveBeenCalledOnce();
  });

  it("treats a fresh offer on an open link as the peer reconnecting", async () => {
    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    const first = b.pc();
    first.channel.open();
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 1 })));
    expect(first.closed).toBe(true);
    expect(b.options.onClose).toHaveBeenCalledOnce();
    expect(b.dl.state).toBe("connecting");
    expect(b.pcs).toHaveLength(2);
  });

  it("does nothing when closed while idle, and says nothing twice", async () => {
    const a = link("aaaa", "bbbb");
    a.dl.close();
    expect(a.options.publishSignal).not.toHaveBeenCalled();
    expect(a.states).toEqual([]);

    await a.dl.connect();
    a.dl.close();
    a.dl.close();
    expect(a.states).toEqual(["offering", "idle"]);
    expect(a.options.publishSignal.mock.calls.filter(([s]) => s === null)).toHaveLength(1);
  });

  it("publishes nothing when closed while still gathering candidates", async () => {
    const a = link("aaaa", "bbbb", (pc) => (pc.iceGatheringState = "gathering"));
    const connecting = a.dl.connect();
    await vi.advanceTimersByTimeAsync(0);
    a.dl.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await connecting;
    expect(a.options.publishSignal.mock.calls.filter(([s]) => s !== null)).toEqual([]);
    expect(a.dl.state).toBe("idle");
  });

  it("publishes no answer when closed while still gathering candidates", async () => {
    const b = link("bbbb", "aaaa", (pc) => (pc.iceGatheringState = "gathering"));
    const answering = b.dl.handleSignal(JSON.stringify(offerFrom()));
    await vi.advanceTimersByTimeAsync(0);
    b.dl.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await answering;
    expect(b.options.publishSignal.mock.calls.filter(([s]) => s !== null)).toEqual([]);
  });
});

describe("DataLink connections that gather no candidate", () => {
  /** The first `n` connections made gather nothing (and stay `gathering`); the ones after gather as usual. */
  const stallingFirst = (n: number) => {
    let made = 0;
    return (pc: FakePeerConnection) => {
      if (++made > n) return;
      pc.stalls = true;
      pc.iceGatheringState = "gathering";
    };
  };
  const published = (side: ReturnType<typeof link>) => side.options.publishSignal.mock.calls.map(([s]) => s).filter((s): s is string => s !== null);

  it("an offerer makes a new connection in place of one that found no candidate, and offers that one", async () => {
    const a = link("aaaa", "bbbb", stallingFirst(1));
    const connecting = a.dl.connect();
    await vi.advanceTimersByTimeAsync(GATHER_STALL_MS - 1);
    expect(a.pcs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await connecting;
    expect(a.pcs).toHaveLength(2);
    expect(a.pcs[0].closed).toBe(true);
    expect(a.pcs[1].closed).toBe(false);
    const offers = published(a);
    expect(offers).toHaveLength(1);
    expect(parseRtcSignal(offers[0])).toMatchObject({ t: "o", c: ["h,192.168.1.2,50000"] });
    // The old connection closing reset nothing: the link is still offering, and says nothing of it.
    expect(a.states).toEqual(["offering"]);

    const b = link("bbbb", "aaaa");
    await b.dl.handleSignal(offers[0]);
    await a.dl.handleSignal(b.lastSignal());
    a.pc().channel.open();
    expect(a.dl.state).toBe("open");
    expect(a.pcs[1].remoteDescription?.type).toBe("answer");
  });

  it("an answerer makes a new connection for the same offer in place of one that found no candidate", async () => {
    const b = link("bbbb", "aaaa", stallingFirst(2));
    const answering = b.dl.handleSignal(JSON.stringify(offerFrom()));
    await vi.advanceTimersByTimeAsync(2 * GATHER_STALL_MS);
    await answering;
    expect(b.pcs).toHaveLength(3);
    expect(b.pcs.map((pc) => pc.closed)).toEqual([true, true, false]);
    for (const pc of b.pcs) expect(pc.remoteDescription?.type).toBe("offer");
    const answers = published(b);
    expect(answers).toHaveLength(1);
    expect(parseRtcSignal(answers[0])).toMatchObject({ t: "a", o: NOW, c: ["h,192.168.1.2,50000"] });
    expect(b.states).toEqual(["answering", "connecting"]);
  });

  it("gives up at once when no connection finds a candidate, instead of holding the attempt for its whole timeout", async () => {
    const a = link("aaaa", "bbbb", stallingFirst(GATHER_ATTEMPTS));
    const connecting = a.dl.connect();
    await vi.advanceTimersByTimeAsync(GATHER_ATTEMPTS * GATHER_STALL_MS);
    await connecting;
    expect(a.pcs).toHaveLength(GATHER_ATTEMPTS);
    expect(a.pcs.every((pc) => pc.closed)).toBe(true);
    expect(published(a)).toEqual([]);
    expect(a.dl.state).toBe("idle");
    expect(a.states).toEqual(["offering", "idle"]);
    // Idle again, it can be dialled at once.
    await a.dl.connect();
    expect(a.pcs).toHaveLength(GATHER_ATTEMPTS + 1);
    expect(published(a)).toHaveLength(1);
  });

  it("an answerer that finds no candidate answers nothing and is free for the next offer", async () => {
    const b = link("bbbb", "aaaa", stallingFirst(GATHER_ATTEMPTS));
    const answering = b.dl.handleSignal(JSON.stringify(offerFrom()));
    await vi.advanceTimersByTimeAsync(GATHER_ATTEMPTS * GATHER_STALL_MS);
    await answering;
    expect(published(b)).toEqual([]);
    expect(b.dl.state).toBe("idle");
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 1 })));
    expect(parseRtcSignal(b.lastSignal())).toMatchObject({ t: "a", o: NOW + 1 });
  });

  it("makes no new connection when closed while one is stalled", async () => {
    const a = link("aaaa", "bbbb", stallingFirst(GATHER_ATTEMPTS));
    const connecting = a.dl.connect();
    await vi.advanceTimersByTimeAsync(GATHER_STALL_MS / 2);
    a.dl.close();
    await vi.advanceTimersByTimeAsync(GATHER_ATTEMPTS * GATHER_STALL_MS);
    await connecting;
    expect(a.pcs).toHaveLength(1);
    expect(published(a)).toEqual([]);
    expect(a.states).toEqual(["offering", "idle"]);
  });

  it("keeps a connection that found candidates, however long its gathering takes", async () => {
    const a = link("aaaa", "bbbb", (pc) => (pc.iceGatheringState = "gathering"));
    const connecting = a.dl.connect();
    await vi.advanceTimersByTimeAsync(5_000);
    await connecting;
    expect(a.pcs).toHaveLength(1);
    expect(published(a)).toHaveLength(1);
  });
});

// A member's app back after a restart answers the hub's offer in a second; the hub's read of that answer can wait half a
// minute for its relays' budget, and by then the answerer's ICE has given up. Going idle left a standing offer this side
// had answered once and would not answer again: the edge waited for the offerer's 90 s attempt (110 s in all, 2026-09-30).
describe("DataLink answers a standing offer again when its answer did not connect", () => {
  const answers = (side: ReturnType<typeof link>) =>
    side.options.publishSignal.mock.calls.map(([s]) => s).filter((s): s is string => s !== null).map((s) => parseRtcSignal(s)!);

  it("answers the same offer again, and connects once the offerer reads the new answer", async () => {
    const a = link("aaaa", "bbbb");
    await a.dl.connect();
    const offer = parseRtcSignal(a.lastSignal())!;
    const b = link("bbbb", "aaaa", () => {}, { offerStanding: (ts) => ts === offer.ts });
    vi.advanceTimersByTime(1);
    await b.dl.handleSignal(a.lastSignal());
    // The offerer does not read that answer (its relays' budget); the answerer's ICE gives up half a minute on.
    vi.advanceTimersByTime(30_000);
    b.pcs[0].setConnectionState("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.dl.state).toBe("connecting");
    expect(b.pcs).toHaveLength(2);
    expect(b.pcs[0].closed).toBe(true);
    expect(answers(b).map((s) => [s.t, s.o])).toEqual([["a", offer.ts], ["a", offer.ts]]);
    // The answer is replaced, never cleared in between: the offerer reads one or the other.
    expect(b.options.publishSignal.mock.calls.filter(([s]) => s === null)).toEqual([]);
    expect(b.states).toEqual(["answering", "connecting", "answering", "connecting"]);

    await a.dl.handleSignal(b.lastSignal());
    expect(a.dl.state).toBe("connecting");
    a.pc().channel.open();
    b.pc().channel.open();
    expect([a.dl.state, b.dl.state]).toEqual(["open", "open"]);
  });

  it(`answers again at most ${REANSWERS} times, then goes idle`, async () => {
    const b = link("bbbb", "aaaa", () => {}, { offerStanding: () => true });
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    for (let i = 0; i < REANSWERS; i++) {
      vi.advanceTimersByTime(20_000);
      b.pc().setConnectionState("failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(b.dl.state).toBe("connecting");
    }
    b.pc().setConnectionState("failed");
    expect(b.dl.state).toBe("idle");
    expect(answers(b)).toHaveLength(1 + REANSWERS);
    expect(b.options.publishSignal).toHaveBeenLastCalledWith(null);
  });

  it("goes idle when the offer no longer stands, the offerer's attempt is nearly over, or nothing says", async () => {
    const cases: [string, Partial<DataLinkOptions>, number][] = [
      ["no longer offered", { offerStanding: () => false }, 30_000],
      ["too late for the offerer", { offerStanding: () => true }, 80_000],
      ["no offerStanding", {}, 30_000],
    ];
    for (const [, extra, after] of cases) {
      vi.setSystemTime(NOW);
      const b = link("bbbb", "aaaa", () => {}, extra);
      await b.dl.handleSignal(JSON.stringify(offerFrom()));
      vi.advanceTimersByTime(after);
      b.pc().setConnectionState("failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(b.dl.state).toBe("idle");
      expect(b.pcs).toHaveLength(1);
    }
  });

  it("does not answer again once the attempt timer ends it: too late for the offerer", async () => {
    const b = link("bbbb", "aaaa", () => {}, { offerStanding: () => true });
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    // A connection that neither fails nor opens: its attempt timer ends it, far too late to answer again.
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.dl.state).toBe("idle");
    expect(b.pcs).toHaveLength(1);
  });

  it("never answers again after close(), nor when its own offer fails", async () => {
    const b = link("bbbb", "aaaa", () => {}, { offerStanding: () => true });
    await b.dl.handleSignal(JSON.stringify(offerFrom()));
    b.dl.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.dl.state).toBe("idle");
    expect(b.pcs).toHaveLength(1);

    const a = link("aaaa", "bbbb", () => {}, { offerStanding: () => true });
    await a.dl.connect();
    a.pc().setConnectionState("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.dl.state).toBe("idle");
    expect(a.pcs).toHaveLength(1);
  });

  it("takes a newer offer while it waits on an answer made again", async () => {
    const b = link("bbbb", "aaaa", () => {}, { offerStanding: () => true });
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW })));
    vi.advanceTimersByTime(30_000);
    b.pc().setConnectionState("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.dl.state).toBe("connecting");
    // The offerer gave up and offers anew (or its app restarted): that offer is answered.
    await b.dl.handleSignal(JSON.stringify(offerFrom({ ts: NOW + 31_000 })));
    expect(b.pcs).toHaveLength(3);
    expect(answers(b).at(-1)).toMatchObject({ t: "a", o: NOW + 31_000 });
  });
});
