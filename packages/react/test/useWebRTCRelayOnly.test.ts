import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallMedia } from "@ghostly/core";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { CallRelayError, ICE_DISCONNECT_GRACE_MS, mediaProblem } from "../src/useWebRTC";

// covers: settings.network.relay-only

/** "Hide my IP from contacts": a call goes through the profile's TURN server only, and fails rather than go direct. */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

const TURN = { urls: "turn:turn.example.org:3478", username: "u", credential: "p" };
const relayOnly = { iceServers: [TURN], relayOnly: true };
const candidates = (signal: string | null) => (JSON.parse(signal!) as { c: string[] }).c;

async function calling(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.startCall(false); });
  devices.userMedia[0].grant();
  await settle();
}

async function answering(call: ReturnType<typeof renderCall>) {
  call.receive(remote.offer(Date.now()));
  act(() => { void call.result.current.acceptCall(false); });
  devices.userMedia[0]?.grant();
  await settle();
}

describe("a call while Hide my IP from contacts is on", () => {
  it("the caller's connection keeps to the TURN server, and its offer carries the relay candidate only, without the related address", async () => {
    const call = renderCall(undefined, undefined, relayOnly);
    await calling(call);
    const [pc] = FakePeerConnection.instances;
    expect(pc.config.iceTransportPolicy).toBe("relay");
    expect(pc.config.iceServers).toEqual([{ urls: ["turn:turn.example.org:3478"], username: "u", credential: "p" }]);
    expect(call.publishedKinds()).toEqual(["o"]);
    expect(candidates(call.published[0])).toEqual(["3 1 udp 41885439 198.51.100.7 50000 typ relay generation 0"]);
  });

  it("the side it rang answers the same way", async () => {
    const call = renderCall(undefined, undefined, relayOnly);
    await answering(call);
    expect(FakePeerConnection.instances[0].config.iceTransportPolicy).toBe("relay");
    expect(call.publishedKinds()).toEqual(["a"]);
    expect(candidates(call.published[0]).every((c) => / typ relay /.test(` ${c} `) && !c.includes("raddr"))).toBe(true);
  });

  it("a TURN server that does not answer fails the call with \"Your relay did not answer\": nothing goes out, no direct try", async () => {
    FakePeerConnection.turnDown = true;
    const call = renderCall(undefined, undefined, relayOnly);
    await calling(call);
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      await settle();
    }
    expect(call.onError).toHaveBeenCalledWith(expect.any(CallRelayError));
    expect(call.result.current.mediaProblem).toBe("relay");
    expect(call.result.current.callState).toBe("idle");
    expect(call.published).toEqual([]);
    expect(FakePeerConnection.instances.every((pc) => pc.config.iceTransportPolicy === "relay")).toBe(true);
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type)).toEqual(["call_started", "call_failed"]);
  });

  it("call media that cannot keep to a relay (the Linux Desktop's) places no call: no microphone asked, nothing rings, it says why", async () => {
    const linux: CallMedia = { createPeerConnection: (config) => new FakePeerConnection(config) as never, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) };
    const call = renderCall(linux, undefined, relayOnly);
    act(() => { void call.result.current.startCall(false); });
    await settle();
    expect(devices.userMedia).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.published).toEqual([]);
    expect(call.addCallEventMessage).not.toHaveBeenCalled();
    expect(call.result.current.mediaProblem).toBe("relayOnly");
  });

  it("nor answers one: the caller is told at once it could not connect", async () => {
    const linux: CallMedia = { createPeerConnection: (config) => new FakePeerConnection(config) as never, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) };
    const call = renderCall(linux, undefined, relayOnly);
    await answering(call);
    expect(devices.userMedia).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.result.current.mediaProblem).toBe("relayOnly");
    expect(call.published.map((s) => s && JSON.parse(s))).toContainEqual(expect.objectContaining({ t: "h", r: "u" }));
  });

  it("off, the same media calls as before", async () => {
    const call = renderCall(undefined, undefined, { iceServers: [TURN] });
    await calling(call);
    expect(FakePeerConnection.instances[0].config.iceTransportPolicy).toBeUndefined();
    expect(candidates(call.published[0]).map((c) => / typ (\S+)/.exec(c)?.[1])).toEqual(["host", "srflx"]);
  });

  it("names its two reasons apart from a microphone's", () => {
    expect(mediaProblem(new CallRelayError("relay"))).toBe("relay");
    expect(mediaProblem(new CallRelayError("relayOnly"))).toBe("relayOnly");
    expect(new CallRelayError("relay").message).toBe("Your relay did not answer");
  });
});

// agents#1601: the setting turned on during a call left the call's connection as it was made (STUN, policy "all"),
// its ICE restarts on it, so a new network address still reached the contact.
describe("Hide my IP from contacts turned on during a call", () => {
  const up = (pc: FakePeerConnection) => act(() => { pc.setIceState("connected"); pc.setConnectionState("connected"); });
  const kinds = (call: ReturnType<typeof renderCall>) => call.published.filter((s): s is string => s !== null).map((s) => (JSON.parse(s) as { t: string }).t);

  for (const side of ["placed", "answered"] as const) it(`ends a call it ${side} on a direct path, tells the contact, and says why`, async () => {
    const network: { iceServers: typeof TURN[]; relayOnly?: boolean } = { iceServers: [TURN] };
    const call = renderCall(undefined, undefined, network);
    if (side === "placed") {
      await calling(call);
      call.receive(remote.restarting(remote.answer(Date.now() + 1)));
    } else {
      call.receive(remote.restarting(remote.offer(Date.now())));
      act(() => { void call.result.current.acceptCall(false); });
      devices.userMedia[0].grant();
    }
    await settle();
    const [pc] = FakePeerConnection.instances;
    up(pc);
    expect(call.result.current.callState).toBe("connected");
    expect(pc.config.iceTransportPolicy).toBeUndefined();
    // The engine's setting turns on (Settings, Network): the chat renders again with it.
    network.relayOnly = true;
    call.rerender({ signal: null });
    await settle();
    expect(call.result.current.callState).toBe("idle");
    expect(kinds(call).slice(-1), "the contact is told the call ended").toEqual(["h"]);
    expect(call.result.current.mediaProblem).toBe("relayOnlyNow");
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type).slice(-1)).toEqual(["call_ended"]);
    // Nothing more goes out on that connection: no restart over the direct path.
    act(() => pc.setIceState("disconnected"));
    await act(async () => { await vi.advanceTimersByTimeAsync(ICE_DISCONNECT_GRACE_MS + 1_000); });
    await settle();
    expect(kinds(call).filter((k) => k === "r")).toEqual([]);
  });

  it("leaves a call already on the relay as it is", async () => {
    const network = { iceServers: [TURN], relayOnly: true };
    const call = renderCall(undefined, undefined, network);
    await calling(call);
    call.receive(remote.restarting(remote.answer(Date.now() + 1)));
    await settle();
    up(FakePeerConnection.instances[0]);
    call.rerender({ signal: null });
    await settle();
    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.mediaProblem).toBeNull();
  });
});
