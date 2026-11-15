import "fake-indexeddb/auto";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endOtherCalls } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { GroupCallButton } from "../../components/GroupCallButton";
import type { LivekitModule } from "../../hooks/useGroupCall";
import type { GroupCallPass } from "../../lib/groupCallPass";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * Hide my IP from contacts turned on while in a group call (WISP 602): the room joined direct is joined again through
 * the node's TURN alone, the call window staying open; a pass without TURN ends the call with the Hide my IP line.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
const TURN = { urls: "turn:turn.sfu.ghostly.test:3478", username: "u", credential: "c" };
const STUN = { urls: "stun:sfu.ghostly.test:3478" };
const community = (id: string) =>
  ({ ...groupView({ id, profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }] }), call: { sfu: "https://sfu.ghostly.test" } }) as GroupView;
const pass = (iceServers: RTCIceServer[]): GroupCallPass =>
  ({ url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_group", identity: ME, expiresIn: 600, iceServers });
const answerPass = (handler: () => unknown) =>
  (fakeEngine as unknown as { on(method: string, h: typeof handler): void }).on("groupCallToken", handler);
const hideIp = (on: boolean) => act(() => fakeEngine.update({ settings: { ...fakeEngine.state.settings, relayOnly: on } }));

class FakeRoom {
  static rooms: FakeRoom[] = [];
  readonly remoteParticipants = new Map();
  readonly activeSpeakers = [];
  private readonly listeners = new Map<string, () => void>();
  readonly localParticipant = {
    identity: ME, name: "Me", isMicrophoneEnabled: false, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false,
    trackPublications: new Map(), getTrackPublication: () => undefined,
    setMicrophoneEnabled: vi.fn(async () => undefined),
  };
  readonly connect = vi.fn(async (_url: string, _token: string, _options?: unknown) => {});
  readonly disconnect = vi.fn(async () => this.listeners.get("disconnected")?.());
  constructor() { FakeRoom.rooms.push(this); }
  on(event: string, listener: () => void) { this.listeners.set(event, listener); return this; }
}
const RoomEvent = new Proxy({}, { get: (_, name) => (name === "Disconnected" ? "disconnected" : String(name)) });
const loadLivekit = async () => ({ Room: FakeRoom, RoomEvent, Track: { Source: {} } }) as unknown as LivekitModule;

async function inCall(id: string, iceServers: RTCIceServer[]) {
  hideIp(false);
  answerPass(() => pass(iceServers));
  const group = community(id);
  fakeEngine.update({ groups: [group] });
  const view = renderApp(<GroupCallButton group={group} loadLivekit={loadLivekit} />);
  await view.user.click(screen.getByTestId("group-call-join"));
  await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", { rtcConfig: { iceServers } }));
  expect(screen.getByTestId("group-call")).toBeInTheDocument();
  return view;
}

afterEach(() => {
  hideIp(false);
  FakeRoom.rooms = [];
  endOtherCalls(Symbol("none"));
});

describe("Hide my IP from contacts turned on during a group call", () => {
  it("leaves the direct room and joins again through the node's relay alone, the call window open", async () => {
    await inCall("group-mid-call", [STUN, TURN]);
    hideIp(true);
    await waitFor(() => expect(FakeRoom.rooms).toHaveLength(2));
    expect(FakeRoom.rooms[0].disconnect).toHaveBeenCalled();
    await waitFor(() => expect(FakeRoom.rooms[1].connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", {
      rtcConfig: { iceServers: [{ ...TURN, urls: [TURN.urls] }], iceTransportPolicy: "relay" },
    }));
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
    expect(screen.queryByTestId("group-call-problem")).toBeNull();
  });

  it("ends the call with the Hide my IP line when the node's pass has no relay", async () => {
    await inCall("group-mid-call-no-relay", [STUN]);
    hideIp(true);
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("Can't join while Hide my IP is on");
    expect(FakeRoom.rooms[0].disconnect).toHaveBeenCalled();
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(screen.queryByTestId("group-call")).toBeNull();
  });
});
