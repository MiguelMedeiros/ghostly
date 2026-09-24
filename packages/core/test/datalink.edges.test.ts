import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataLink, type DataLinkOptions, type DataLinkState } from "../src/datalink";
import { DATA_CHANNEL_ID, DATA_CHANNEL_LABEL, RTC_SIGNAL_MAX_AGE_MS, parseRtcSignal, type RtcSignal } from "../src/signal";

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
function sdp(setup: string) {
  const fingerprint = (++fingerprintSeed).toString(16).padStart(2, "0").repeat(32).match(/.{2}/g)!.join(":").toUpperCase();
  return [
    "v=0",
    "a=ice-ufrag:ufrag" + fingerprintSeed,
    "a=ice-pwd:passwordpasswordpassword",
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    "a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host",
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
  getConfiguration() {
    return { iceServers: [] };
  }
  createDataChannel(label: string, init: RTCDataChannelInit) {
    this.channel = new FakeDataChannel(label, init);
    return this.channel as unknown as RTCDataChannel;
  }
  async createOffer() {
    if (this.failOffer) throw new Error("no offer");
    return { type: "offer" as const, sdp: sdp("actpass") };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: sdp("active") };
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

function link(me: string, peer: string, configure: (pc: FakePeerConnection) => void = () => {}) {
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
    expect(a.options.setFastPoll).toHaveBeenLastCalledWith(true);
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
