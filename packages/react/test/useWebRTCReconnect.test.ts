import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallMedia } from "@ghostly/core";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices, type FakeMediaStream } from "./fakes";
import { renderCall, settle } from "./harness";
import { ICE_DISCONNECT_GRACE_MS, ICE_RESTART_GATHER_MS, ICE_RESTART_RETRY_MS, RECONNECT_TIMEOUT_MS } from "../src/useWebRTC";

// covers: calls.reconnect

/**
 * Reconnecting (WISP 601): a call dropped when a participant's network changed (Wi-Fi to mobile data, a VPN going up),
 * a known issue of 1.0.1. A connected call whose path is lost now restarts ICE on its own connection: the side whose
 * offer was answered sends a restart offer (`r`), the other answers it, and the call window says "Reconnecting..."
 * meanwhile. With an older contact (no `x` on its offer or answer) the call ends as it did.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

type Call = ReturnType<typeof renderCall>;
type Signal = { t: string; ts: number; u?: string; c?: string[]; x?: number; re?: number };

const signals = (call: Call) => call.published.filter((s): s is string => s !== null).map((s) => JSON.parse(s) as Signal);
const restartOffers = (call: Call) => signals(call).filter((s) => s.t === "r");
const pc = () => FakePeerConnection.instances[FakePeerConnection.instances.length - 1];

async function pass(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

function up(connection: FakePeerConnection) {
  act(() => {
    connection.setIceState("connected");
    connection.setConnectionState("connected");
  });
}

/** A connected call this side placed. `restarts`: the contact's answer says it restarts ICE (an app since 1.0.2). */
async function placed(call: Call, restarts = true): Promise<FakeMediaStream> {
  act(() => { void call.result.current.startCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  const answer = remote.answer(Date.now() + 1);
  call.receive(restarts ? remote.restarting(answer) : answer);
  await settle();
  up(pc());
  return stream;
}

/** A connected call this side answered. */
async function answered(call: Call, restarts = true): Promise<FakeMediaStream> {
  const offer = remote.offer(Date.now());
  call.receive(restarts ? remote.restarting(offer) : offer);
  act(() => { void call.result.current.acceptCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  up(pc());
  return stream;
}

describe("a call says it restarts ICE", () => {
  it("on its offer and on its answer", async () => {
    const caller = renderCall();
    act(() => { void caller.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(signals(caller)[0]).toMatchObject({ t: "o", x: 1 });

    const answerer = renderCall();
    answerer.receive(remote.offer(Date.now()));
    act(() => { void answerer.result.current.acceptCall(false); });
    devices.userMedia[1].grant();
    await settle();
    expect(signals(answerer)[0]).toMatchObject({ t: "a", x: 1 });
  });

  it("not with media that cannot (a stand-in that does not say so)", async () => {
    const media: CallMedia = {
      createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    };
    const call = renderCall(media);
    await placed(call);
    expect(signals(call)[0].x).toBeUndefined();
    // And its call ends on a failed connection as before, whatever the contact said.
    act(() => pc().setIceState("failed"));
    expect(call.result.current.callState).toBe("idle");
    expect(restartOffers(call)).toEqual([]);
  });
});

describe("the side that placed the call", () => {
  it("restarts ICE on the same connection after the grace, and the call is back with its clock, tracks and mute", async () => {
    const call = renderCall();
    const stream = await placed(call);
    act(() => call.result.current.toggleMute());
    const startedAt = call.result.current.callStartedAt;
    const connection = pc();
    await pass(60_000);

    act(() => connection.setIceState("disconnected"));
    expect(call.result.current.reconnecting).toBe(true);
    expect(call.result.current.callState).toBe("connected");
    // ICE often comes back by itself: nothing is sent during the grace.
    await pass(ICE_DISCONNECT_GRACE_MS - 1);
    expect(restartOffers(call)).toEqual([]);
    await pass(1);

    const [offer] = restartOffers(call);
    expect(offer).toMatchObject({ t: "r", u: "fake1", x: 1 });
    expect(offer.c).toHaveLength(2);
    expect(connection.iceRestarts).toBe(1);
    expect(FakePeerConnection.instances).toHaveLength(1);

    call.receive(remote.restartAnswer(Date.now() + 1, offer.ts));
    await settle();
    expect(connection.remoteDescriptions.map((d) => d.type)).toEqual(["answer", "answer"]);
    expect(connection.remoteDescription?.sdp).toContain("a=ice-ufrag:peer1");
    // Still reconnecting until ICE says the path is there.
    expect(call.result.current.reconnecting).toBe(true);
    act(() => connection.setIceState("connected"));

    expect(call.result.current.reconnecting).toBe(false);
    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.callStartedAt).toBe(startedAt);
    expect(call.result.current.isMuted).toBe(true);
    expect(stream.getTracks().every((t) => t.readyState === "live")).toBe(true);
    expect(connection.closed).toBe(false);
    // One "call connected" line, no end line.
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type)).toEqual(["call_started", "call_connected"]);
    // Nothing more is sent once the path is back.
    await pass(RECONNECT_TIMEOUT_MS + ICE_RESTART_RETRY_MS);
    expect(restartOffers(call)).toHaveLength(1);
    expect(call.result.current.callState).toBe("connected");
  });

  it("sends nothing when ICE comes back by itself within the grace", async () => {
    const call = renderCall();
    await placed(call);
    act(() => pc().setIceState("disconnected"));
    await pass(ICE_DISCONNECT_GRACE_MS - 500);
    act(() => pc().setIceState("connected"));
    expect(call.result.current.reconnecting).toBe(false);
    await pass(RECONNECT_TIMEOUT_MS);
    expect(restartOffers(call)).toEqual([]);
    expect(pc().iceRestarts).toBe(0);
    expect(call.result.current.callState).toBe("connected");
  });

  it("restarts at once when ICE failed", async () => {
    const call = renderCall();
    await placed(call);
    act(() => pc().setIceState("failed"));
    await settle();
    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.reconnecting).toBe(true);
    expect(restartOffers(call)).toHaveLength(1);
    // The connection's own "failed" right after it starts nothing more.
    act(() => pc().setConnectionState("failed"));
    await settle();
    expect(restartOffers(call)).toHaveLength(1);
  });

  it("restarts at once when the browser has a network again, without waiting for the grace", async () => {
    const call = renderCall();
    await placed(call);
    act(() => pc().setIceState("disconnected"));
    act(() => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(restartOffers(call)).toHaveLength(1);
    // The grace's own restart does not follow it.
    await pass(ICE_DISCONNECT_GRACE_MS);
    expect(restartOffers(call)).toHaveLength(1);
  });

  it("offers again while the path is still lost, and takes only the answer to its latest offer", async () => {
    const call = renderCall();
    await placed(call);
    const connection = pc();
    act(() => connection.setIceState("failed"));
    await settle();
    await pass(ICE_RESTART_RETRY_MS);

    const [first, second] = restartOffers(call);
    expect(restartOffers(call)).toHaveLength(2);
    expect(second.ts).toBeGreaterThan(first.ts);
    expect(second.u).toBe("fake2");

    // The answer to the first offer comes late: its credentials are for an offer this side replaced.
    call.receive(remote.restartAnswer(Date.now() + 1, first.ts, 1));
    await settle();
    expect(connection.remoteDescriptions).toHaveLength(1);
    call.receive(remote.restartAnswer(Date.now() + 2, second.ts, 2));
    await settle();
    expect(connection.remoteDescriptions).toHaveLength(2);
    expect(connection.remoteDescription?.sdp).toContain("a=ice-ufrag:peer2");
  });

  it("drops the answer to its first offer that comes while the second is still gathering", async () => {
    const call = renderCall();
    await placed(call);
    const connection = pc();
    act(() => connection.setIceState("failed"));
    await settle();
    const [first] = restartOffers(call);

    // The second offer is made (the connection has its new credentials) but not sent yet: it gathers candidates.
    FakePeerConnection.holdGathering = true;
    await pass(ICE_RESTART_RETRY_MS);
    expect(connection.iceRestarts).toBe(2);
    expect(restartOffers(call)).toHaveLength(1);

    // The answer to the first offer comes now. Taken, it would settle the second offer with credentials the contact
    // made for the first, and the contact's answer to the second would then be refused: a restart lost for nothing.
    call.receive(remote.restartAnswer(Date.now() + 1, first.ts, 1));
    await settle();
    expect(connection.remoteDescriptions).toHaveLength(1);

    FakePeerConnection.holdGathering = false;
    act(() => connection.finishGathering());
    await settle();
    const [, second] = restartOffers(call);
    expect(second.u).toBe("fake2");
    call.receive(remote.restartAnswer(Date.now() + 2, second.ts, 2));
    await settle();
    expect(connection.remoteDescriptions).toHaveLength(2);
    expect(connection.remoteDescription?.sdp).toContain("a=ice-ufrag:peer2");
  });

  it("with no network sends no offer, and sends one when the network is back", async () => {
    const call = renderCall();
    await placed(call);
    FakePeerConnection.offline = true;
    act(() => pc().setIceState("failed"));
    await pass(ICE_RESTART_GATHER_MS);
    expect(restartOffers(call)).toEqual([]);
    expect(call.result.current.reconnecting).toBe(true);

    FakePeerConnection.offline = false;
    act(() => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(restartOffers(call)).toHaveLength(1);
    expect(restartOffers(call)[0].c).toHaveLength(2);
  });

  it("keeps the call when a restart offer cannot be made, and tries again", async () => {
    const call = renderCall();
    await placed(call);
    FakePeerConnection.failRestarts = true;
    act(() => pc().setIceState("failed"));
    await settle();
    expect(call.result.current.callState).toBe("connected");
    expect(restartOffers(call)).toEqual([]);
    FakePeerConnection.failRestarts = false;
    await pass(ICE_RESTART_RETRY_MS);
    expect(restartOffers(call)).toHaveLength(1);
  });

  it("ignores a restart offer from the side it called: only one side restarts", async () => {
    const call = renderCall();
    await placed(call);
    const connection = pc();
    call.receive(remote.restartOffer(Date.now() + 5));
    await settle();
    expect(connection.remoteDescriptions).toHaveLength(1);
    expect(signals(call).map((s) => s.t)).toEqual(["o"]);
    expect(call.result.current.callState).toBe("connected");
  });

  it("ends the call as before when the path is not back in time", async () => {
    const call = renderCall();
    const stream = await placed(call);
    const connection = pc();
    await pass(10_000);
    act(() => connection.setIceState("disconnected"));
    await pass(RECONNECT_TIMEOUT_MS - 1);
    expect(call.result.current.callState).toBe("connected");
    await pass(1);

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.reconnecting).toBe(false);
    expect(connection.closed).toBe(true);
    // The contact is told, as a hang-up tells it: its side would otherwise go on reconnecting a call that is over.
    expect(signals(call).slice(-1)[0]).toMatchObject({ t: "h" });
    expect(signals(call).slice(-1)[0]).not.toHaveProperty("r");
    expect(stream.getTracks().every((t) => t.readyState === "ended")).toBe(true);
    // The call's end line, with its length: the ten seconds it was up and the time it tried to come back.
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_ended", false, 10_000 + RECONNECT_TIMEOUT_MS);
    await pass(5000);
    expect(call.published[call.published.length - 1]).toBeNull();
    // Nothing is left to fire.
    const sent = call.published.length;
    await pass(ICE_RESTART_RETRY_MS * 2);
    expect(call.published).toHaveLength(sent);
  });

  it("stops restarting once the call is hung up", async () => {
    const call = renderCall();
    await placed(call);
    act(() => pc().setIceState("disconnected"));
    act(() => call.result.current.hangUp());
    expect(call.result.current.reconnecting).toBe(false);
    await pass(RECONNECT_TIMEOUT_MS);
    expect(restartOffers(call)).toEqual([]);
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_ended")).toHaveLength(1);
  });
});

describe("the side that answered the call", () => {
  it("says Reconnecting, sends no offer, and answers the caller's restart offer on the same connection", async () => {
    const call = renderCall();
    const stream = await answered(call);
    const connection = pc();
    const startedAt = call.result.current.callStartedAt;
    await pass(5000);

    act(() => connection.setIceState("disconnected"));
    expect(call.result.current.reconnecting).toBe(true);
    await pass(ICE_DISCONNECT_GRACE_MS + ICE_RESTART_RETRY_MS);
    act(() => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(signals(call).map((s) => s.t)).toEqual(["a"]);
    expect(connection.iceRestarts).toBe(0);

    const offerTs = Date.now() + 1;
    call.receive(remote.restartOffer(offerTs));
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(connection.remoteDescriptions.map((d) => d.type)).toEqual(["offer", "offer"]);
    expect(connection.remoteDescription?.sdp).toContain("a=ice-ufrag:peer1");
    const answer = signals(call)[1];
    expect(answer).toMatchObject({ t: "a", re: offerTs, u: "fake1", x: 1 });
    expect(answer.c).toHaveLength(2);

    act(() => connection.setIceState("connected"));
    expect(call.result.current.reconnecting).toBe(false);
    expect(call.result.current.callStartedAt).toBe(startedAt);
    expect(stream.getTracks().every((t) => t.readyState === "live")).toBe(true);
    await pass(RECONNECT_TIMEOUT_MS);
    expect(call.result.current.callState).toBe("connected");
  });

  it("answers a restart offer that comes while its own ICE still says connected", async () => {
    const call = renderCall();
    await answered(call);
    const offerTs = Date.now() + 1;
    call.receive(remote.restartOffer(offerTs));
    await settle();
    expect(signals(call)[1]).toMatchObject({ t: "a", re: offerTs });
    expect(call.result.current.reconnecting).toBe(false);
  });

  it("answers each restart offer, in order", async () => {
    const call = renderCall();
    await answered(call);
    const first = Date.now() + 1;
    call.receive(remote.restartOffer(first, 1));
    call.receive(remote.restartOffer(first + 1, 2));
    await settle();
    expect(signals(call).slice(1).map((s) => s.re)).toEqual([first, first + 1]);
    expect(pc().remoteDescription?.sdp).toContain("a=ice-ufrag:peer2");
  });

  it("drops a restart offer of another connection (another DTLS fingerprint)", async () => {
    const call = renderCall();
    await answered(call);
    const other = JSON.stringify({ ...JSON.parse(remote.restartOffer(Date.now() + 1)), f: "ef".repeat(32) });
    call.receive(other);
    await settle();
    expect(signals(call).map((s) => s.t)).toEqual(["a"]);
    expect(pc().remoteDescriptions).toHaveLength(1);
  });

  it("ends the call as before when no restart offer brings the path back in time", async () => {
    const call = renderCall();
    await answered(call);
    act(() => pc().setIceState("failed"));
    expect(call.result.current.callState).toBe("connected");
    await pass(RECONNECT_TIMEOUT_MS);
    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_ended", false, RECONNECT_TIMEOUT_MS);
    expect(pc().closed).toBe(true);
    // The caller is told: it would otherwise send restart offers to a call that is over here.
    expect(signals(call).slice(-1)[0]).toMatchObject({ t: "h" });
  });

  it("a contact that gave up reconnecting ends the call here at once, with its end line", async () => {
    const call = renderCall();
    await answered(call);
    act(() => pc().setIceState("disconnected"));
    expect(call.result.current.reconnecting).toBe(true);
    await pass(5000);
    call.receive(JSON.stringify({ t: "h", ts: Date.now() }));
    await settle();
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.reconnecting).toBe(false);
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_ended")).toHaveLength(1);
  });
});

describe("a restart offer with no call on", () => {
  it("rings nobody", async () => {
    const call = renderCall();
    call.receive(remote.restartOffer(Date.now()));
    await settle();
    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it("is not an answer to a call that still rings", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    call.receive(remote.restartAnswer(Date.now() + 1, signals(call)[0].ts));
    await settle();
    expect(call.result.current.callState).toBe("offering");
    expect(pc().remoteDescription).toBeNull();
  });
});

describe("with a contact on an older app (no `x`)", () => {
  it("the caller's call ends on a failed connection as before, and no restart offer is sent", async () => {
    const call = renderCall();
    await placed(call, false);
    act(() => pc().setIceState("disconnected"));
    expect(call.result.current.reconnecting).toBe(false);
    await pass(ICE_DISCONNECT_GRACE_MS + ICE_RESTART_RETRY_MS);
    act(() => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(restartOffers(call)).toEqual([]);
    expect(call.result.current.callState).toBe("connected");

    act(() => pc().setIceState("failed"));
    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage.mock.lastCall?.[0]).toBe("call_ended");
    expect(restartOffers(call)).toEqual([]);
  });

  it("the answerer's call ends on a failed connection as before", async () => {
    const call = renderCall();
    await answered(call, false);
    act(() => pc().setIceState("failed"));
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.reconnecting).toBe(false);
  });
});

describe("with a contact whose clock is off", () => {
  /** A contact's signal as the engine hands it on from a live session: with when it was heard here. */
  const heard = (signal: string) => JSON.stringify({ ...JSON.parse(signal), at: Date.now() });

  it.each([["two minutes behind", -2 * 60_000 - 500], ["two minutes ahead", 2 * 60_000 + 500], ["an hour behind", -60 * 60_000]])("the caller takes the answer to its restart offer from a callee whose clock is %s: it names that offer (`re`)", async (_, skew) => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    const mine = signals(call)[0];
    // The call's own answer names the call's offer (`o`); the restart's answer names the restart offer (`re`).
    call.receive(heard(JSON.stringify({ ...JSON.parse(remote.restarting(remote.answer(Date.now() + skew))), o: mine.ts })));
    await settle();
    up(pc());
    expect(call.result.current.callState).toBe("connected");
    act(() => pc().setIceState("failed"));
    await settle();
    const [offer] = restartOffers(call);
    call.receive(heard(remote.restartAnswer(Date.now() + skew + 1_000, offer.ts)));
    await settle();
    expect(pc().remoteDescriptions.map((d) => d.type)).toEqual(["answer", "answer"]);
    act(() => pc().setIceState("connected"));
    expect(call.result.current.reconnecting).toBe(false);
  });

  it.each([["two minutes behind", -2 * 60_000 - 500], ["two minutes ahead", 2 * 60_000 + 500]])("the callee answers the restart offer of a caller whose clock is %s, naming it with `re` and never with `o`", async (_, skew) => {
    const call = renderCall();
    const theirs = Date.now() + skew;
    call.receive(heard(remote.restarting(remote.offer(theirs))));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    up(pc());
    expect(signals(call)[0]).toMatchObject({ t: "a", o: theirs, x: 1 });
    expect(signals(call)[0].re).toBeUndefined();
    await pass(5000);
    call.receive(heard(remote.restartOffer(theirs + 6_000)));
    await settle();
    expect(pc().remoteDescriptions.map((d) => d.type)).toEqual(["offer", "offer"]);
    const sent = signals(call);
    const answer = sent[sent.length - 1] as Signal & { o?: number };
    expect(answer).toMatchObject({ t: "a", re: theirs + 6_000 });
    expect(answer.o).toBeUndefined();
  });
});
