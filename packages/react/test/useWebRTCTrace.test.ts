import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.audio

/**
 * A call that ends by itself says why in the diagnostic log (the Desktop's log file, or the console with link traces
 * on): a hang-up here or from the contact, a failed connection with its states, or its chat unloaded mid-call. A
 * Linux Desktop call ended at 1m16s with its ICE connected and nothing in the log to say which of these it was.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;
let traced: Record<string, unknown>[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
  traced = [];
  (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true;
  vi.spyOn(console, "debug").mockImplementation((line: unknown) => {
    const text = String(line);
    if (text.startsWith("[ghostly:link] ")) traced.push(JSON.parse(text.slice("[ghostly:link] ".length)) as Record<string, unknown>);
  });
});

afterEach(() => {
  delete (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace;
  vi.restoreAllMocks();
  uninstall();
  vi.useRealTimers();
});

const ends = () => traced.filter((line) => line.step === "call-end").map(({ why, state, ice, connection, connected }) =>
  JSON.parse(JSON.stringify({ why, state, ice, connection, connected })) as Record<string, unknown>);

/** A call we placed, answered and connected. */
async function connected() {
  const call = renderCall();
  act(() => { void call.result.current.startCall(false); });
  devices.userMedia[0].grant();
  await settle();
  const pc = FakePeerConnection.instances[0];
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  act(() => pc.setIceState("connected"));
  return { call, pc };
}

describe("why a call ended, in the log", () => {
  it("the contact hung up", async () => {
    const { call } = await connected();
    call.receive(remote.hangUp(Date.now() + 2));
    expect(ends()[0]).toEqual({ why: "contact-hang-up", state: "connected" });
  });

  it("hung up here", async () => {
    const { call } = await connected();
    act(() => call.result.current.hangUp());
    expect(ends()).toEqual([{ why: "hang-up", state: "connected", connected: true }]);
  });

  it("the connection failed, with its states", async () => {
    const { pc } = await connected();
    act(() => pc.setIceState("failed"));
    expect(ends()).toHaveLength(1);
    expect(ends()[0]).toMatchObject({ why: "connection", ice: "failed", connected: true });
    expect(ends()[0]).toHaveProperty("connection");
  });

  it("the chat holding it was unloaded", async () => {
    const { call } = await connected();
    call.unmount();
    expect(ends()).toEqual([{ why: "unloaded", state: "connected" }]);
  });
});
