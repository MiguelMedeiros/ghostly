import "fake-indexeddb/auto";
import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anyCallOn, endOtherCalls, setCallOn } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { GroupCallButton } from "../../components/GroupCallButton";
import type { LivekitModule } from "../../hooks/useGroupCall";
import { passRefreshInMs, type GroupCallPass } from "../../lib/groupCallPass";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * Join call in a group's header (WISP 602): only in a group with a call node, the pass asked of the engine
 * (`groupCallToken`), the room joined on a fake LiveKit (no WebRTC in the test DOM), the two refusals said apart with
 * Try again, the pass asked again before it runs out without leaving the room, and one call at a time with a 1:1 call.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
const CALL = { sfu: "https://sfu.ghostly.test" };
const community = (patch: Partial<GroupView> = {}) =>
  ({ ...groupView({ profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }] }), call: CALL, ...patch }) as GroupView;
const pass = (over: Partial<GroupCallPass> = {}): GroupCallPass =>
  ({ url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_group-1", identity: ME, expiresIn: 600, ...over });

/** The engine's `groupCallToken`, not in `EngineApi` until the engine's slice lands. */
const answerPass = (handler: (params: { groupId: string }) => unknown) =>
  (fakeEngine as unknown as { on(method: string, h: typeof handler): void }).on("groupCallToken", handler);
const passAsks = () => fakeEngine.calls.filter((c) => (c.method as string) === "groupCallToken").map((c) => c.params);

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
  readonly connect = vi.fn(async (_url: string, _token: string) => {});
  readonly disconnect = vi.fn(async () => this.listeners.get("disconnected")?.());
  constructor() { FakeRoom.rooms.push(this); }
  on(event: string, listener: () => void) { this.listeners.set(event, listener); return this; }
}
const RoomEvent = new Proxy({}, { get: (_, name) => (name === "Disconnected" ? "disconnected" : String(name)) });
const loadLivekit = async () => ({ Room: FakeRoom, RoomEvent, Track: { Source: {} } }) as unknown as LivekitModule;

function joinButton(group = community()) {
  fakeEngine.update({ groups: [group] });
  return renderApp(<GroupCallButton group={group} loadLivekit={loadLivekit} />);
}

afterEach(() => {
  FakeRoom.rooms = [];
  endOtherCalls(Symbol("none"));
  vi.useRealTimers();
});

describe("Join call in a group's header", () => {
  it("shows in a group with a call node and in no other", () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [community({ call: undefined } as Partial<GroupView>)] });
    const { rerender } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(screen.getByTestId("group-name")).toHaveTextContent("Club");
    expect(screen.queryByTestId("group-call-join")).toBeNull();
    act(() => fakeEngine.update({ groups: [community()] }));
    rerender(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Join call");
  });

  it("asks the node for a pass, joins its room with it and opens the call; Leave call closes it", async () => {
    answerPass(() => pass());
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call")).toBeInTheDocument();
    expect(passAsks()).toEqual([{ groupId: "group-1" }]);
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", undefined));
    await waitFor(() => expect(anyCallOn()).toBe(true));
    await user.click(screen.getByTestId("group-call-leave"));
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(FakeRoom.rooms[0].disconnect).toHaveBeenCalled();
    expect(anyCallOn()).toBe(false);
    // Joined again while the pass holds: no new ask of the node.
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[1]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", undefined));
    expect(passAsks()).toHaveLength(1);
  });

  it("a refused pass says so in one line, Try again asks again and joins", async () => {
    answerPass(() => { throw new Error("The call node refused the pass (403)"); });
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("You're not let into this call yet");
    expect(screen.queryByTestId("group-call")).toBeNull();
    answerPass(() => pass());
    await user.click(screen.getByTestId("group-call-retry"));
    expect(await screen.findByTestId("group-call")).toBeInTheDocument();
    expect(screen.queryByTestId("group-call-problem")).toBeNull();
    expect(passAsks()).toHaveLength(2);
  });

  it("a node it cannot reach says another line, its English behind the ⓘ", async () => {
    answerPass(() => { throw new Error("fetch failed"); });
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("Couldn't reach the group's call");
    await user.click(screen.getByTestId("group-call-problem-notice-info"));
    expect(screen.getByTestId("group-call-problem-notice-details")).toHaveTextContent("fetch failed");
    expect(screen.getByTestId("group-call-retry")).toBeInTheDocument();
  });

  it("asks for the next pass before this one runs out, and stays in the room it joined", async () => {
    expect(passRefreshInMs(600)).toBe(540_000);
    expect(passRefreshInMs(60)).toBe(48_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    answerPass(() => pass({ token: `pass-${++n}` }));
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    await act(async () => { await vi.advanceTimersByTimeAsync(539_000); });
    expect(passAsks()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(passAsks()).toHaveLength(2);
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(FakeRoom.rooms[0].disconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
  });

  it("on a 1:1 call, Join call asks to end it first; a 1:1 call answered later ends the group's", async () => {
    answerPass(() => pass());
    const other = Symbol("1:1 call"), hangUp = vi.fn();
    setCallOn(other, hangUp);
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(screen.getByTestId("group-call-end-other")).toBeInTheDocument();
    expect(passAsks()).toHaveLength(0);
    await user.click(screen.getByTestId("group-call-end-other-confirm"));
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("group-call")).toBeInTheDocument();
    await waitFor(() => expect(anyCallOn()).toBe(true));
    // "End and answer" in a chat
    act(() => { endOtherCalls(other); });
    await waitFor(() => expect(screen.queryByTestId("group-call")).toBeNull());
    expect(FakeRoom.rooms[0].disconnect).toHaveBeenCalled();
  });
});
