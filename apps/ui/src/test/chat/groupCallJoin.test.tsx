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
 * Try again, the pass asked again before it runs out without leaving the room, one call at a time with a 1:1 call, and
 * off where this app cannot join one (the Linux Desktop).
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The Android app's `call_service` (CallService.kt) and its notification's Hang up (`call-hang-up`). */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => (command === "call_service" ? true : command === "native_notification_permission" ? "granted" : undefined)),
  hangUp: undefined as (() => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  listen: async (name: string, handler: () => void) => {
    if (name !== "call-hang-up") return () => {};
    tauri.hangUp = handler;
    return () => { if (tauri.hangUp === handler) tauri.hangUp = undefined; };
  },
  getVersion: async () => "0.4.0",
}));
const serviceTold = () => tauri.invoke.mock.calls.filter(([command]) => command === "call_service").map(([, args]) => (args as { call: unknown }).call);

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

/** Someone else in the room, as LiveKit hands them over: the name is the node's. */
const remote = (identity: string, name: string) => ({
  identity, name, isMicrophoneEnabled: true, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false, getTrackPublication: () => undefined,
});

class FakeRoom {
  static rooms: FakeRoom[] = [];
  /** Who is already in the next room joined. */
  static others: ReturnType<typeof remote>[] = [];
  readonly remoteParticipants = new Map(FakeRoom.others.map((p) => [p.identity, p]));
  readonly activeSpeakers = [];
  private readonly listeners = new Map<string, () => void>();
  readonly localParticipant = {
    identity: ME, name: "Me", isMicrophoneEnabled: false, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false,
    trackPublications: new Map(), getTrackPublication: () => undefined,
    setMicrophoneEnabled: vi.fn(async function (this: { isMicrophoneEnabled: boolean }, on: boolean) { this.isMicrophoneEnabled = on; }),
  };
  readonly connect = vi.fn(async (_url: string, _token: string, _options?: unknown) => {});
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
  FakeRoom.others = [];
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

  it("after the admin names another node, Join call asks it for a pass, not the old node's still held", async () => {
    answerPass(() => pass());
    const group = community();
    const { user, rerender } = joinButton(group);
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", undefined));
    await user.click(screen.getByTestId("group-call-leave"));
    const moved = community({ call: { sfu: "https://call.example.com" } } as Partial<GroupView>);
    answerPass(() => pass({ url: "wss://call.example.com", token: "pass-2" }));
    fakeEngine.update({ groups: [moved] });
    rerender(<GroupCallButton group={moved} loadLivekit={loadLivekit} />);
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[1]?.connect).toHaveBeenCalledWith("wss://call.example.com", "pass-2", undefined));
    expect(passAsks()).toHaveLength(2);
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

  it("the engine's own refusals, not let in by the node or not a member, say the refused line too", async () => {
    for (const refusal of [
      "sfu.ghostly.test did not let you into the group's call. Try again in a minute.",
      "You are not in this group, so you can't join its call",
    ]) {
      answerPass(() => { throw new Error(refusal); });
      const { user, unmount } = joinButton();
      await user.click(screen.getByTestId("group-call-join"));
      expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("You're not let into this call yet");
      unmount();
    }
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

  it("Join call pressed while in the call opens its window whole again, and stays in the room it joined", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    answerPass(() => pass({ token: `pass-${++n}` }));
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    // The next pass, asked before this one runs out, is held for a join after a drop.
    await act(async () => { await vi.advanceTimersByTimeAsync(541_000); });
    expect(passAsks()).toHaveLength(2);
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "true");
    // From the small window, the header's Join call is in reach.
    await user.click(screen.getByTestId("group-call-join"));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    // Not joined again with the newer pass held: everyone saw this member leave and come back.
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(FakeRoom.rooms[0].disconnect).not.toHaveBeenCalled();
    expect(passAsks()).toHaveLength(2);
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "false");
    localStorage.removeItem("ghostly_group_call_mini");
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

  it("a 1:1 call answered while the pass is asked for: Join call asks to end it before joining, with the pass it got", async () => {
    let give!: (p: GroupCallPass) => void;
    answerPass(() => new Promise<GroupCallPass>((resolve) => { give = resolve; }));
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(passAsks()).toHaveLength(1));
    // Answered in a chat meanwhile, with no group call on yet to end.
    const other = Symbol("1:1 call"), hangUp = vi.fn();
    setCallOn(other, hangUp);
    await act(async () => { give(pass()); });
    expect(await screen.findByTestId("group-call-end-other")).toBeInTheDocument();
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(FakeRoom.rooms).toHaveLength(0);
    expect(hangUp).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("group-call-end-other-confirm"));
    expect(hangUp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", undefined));
    expect(passAsks()).toHaveLength(1);
  });

  it("names each tile by the group's own names, whatever name the node gave, and says who is not in the group", async () => {
    const ana = "ana".padEnd(46, "a") + "ana111", other = "ana".padEnd(46, "b") + "ana222", stranger = "zz".padEnd(46, "z") + "zzz333";
    const members = [{ key: ME, role: "member", me: true, online: true, missing: 0 }, ...[ana, other].map((key) => ({ key, role: "member", me: false, online: true, missing: 0, nick: "Ana" }))];
    // The node calls the second Ana "Miguel", and someone outside the roster "Ana".
    FakeRoom.others = [remote(ana, "Ana"), remote(other, "Miguel"), remote(stranger, "Ana")];
    answerPass(() => pass());
    const { user } = joinButton(community({ members } as Partial<GroupView>));
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(screen.getAllByTestId("group-call-tile")).toHaveLength(4));
    const tileOf = (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
    expect(tileOf(ME)).toHaveTextContent("You");
    expect(tileOf(ana)).toHaveTextContent("Ana ⁦(…ana111)⁩");
    expect(tileOf(other)).toHaveTextContent("Ana ⁦(…ana222)⁩");
    expect(tileOf(other)).not.toHaveTextContent("Miguel");
    expect(tileOf(stranger)).toHaveTextContent("Not in this group (…zzz333)");
  });
});

describe("a group call in the Android app", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    tauri.invoke.mockClear();
    tauri.hangUp = undefined;
  });

  // Out of sight (Home, the screen off) Android silences the microphone of an app with no call service: the others in
  // the room stopped hearing the phone within seconds, as in a 1:1 call before lib/callService.ts.
  it("holds the call service from the microphone on to Leave call, and the notification's Hang up leaves the room", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    answerPass(() => pass());
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(serviceTold()).toEqual([{ name: "Club", video: false }]));
    // Muted, it holds on: from the background Android would refuse to start it again.
    await user.click(screen.getByTestId("group-call-mic"));
    expect(serviceTold()).toEqual([{ name: "Club", video: false }]);
    await user.click(screen.getByTestId("group-call-leave"));
    await waitFor(() => expect(serviceTold()).toEqual([{ name: "Club", video: false }, null]));

    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(tauri.hangUp).toBeDefined());
    act(() => tauri.hangUp!());
    await waitFor(() => expect(screen.queryByTestId("group-call")).toBeNull());
    expect(FakeRoom.rooms[1].disconnect).toHaveBeenCalled();
    expect(serviceTold()[serviceTold().length - 1]).toBeNull();
  });

  it("holds nothing outside the Android app", async () => {
    answerPass(() => pass());
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.localParticipant.setMicrophoneEnabled).toHaveBeenCalled());
    expect(serviceTold()).toEqual([]);
  });
});

describe("Join call with Hide my IP from contacts on", () => {
  const TURN = { urls: "turn:turn.sfu.ghostly.test:3478", username: "u", credential: "c" };
  const hideIp = (group: GroupView) => {
    fakeEngine.update({ settings: { ...fakeEngine.state.settings, relayOnly: true } });
    return joinButton(group);
  };

  it("asks once before the node sees this device's IP, then joins through the node's relay alone", async () => {
    answerPass(() => pass({ iceServers: [{ urls: "stun:sfu.ghostly.test:3478" }, TURN] }));
    const { user } = hideIp(community({ id: "group-hide-ip" }));
    await user.click(screen.getByTestId("group-call-join"));
    expect(screen.getByTestId("group-call-hide-ip")).toHaveTextContent("Join with Hide my IP on?");
    await user.click(screen.getByTestId("group-call-hide-ip-info"));
    expect(screen.getByTestId("group-call-hide-ip-info-text")).toHaveTextContent("see this device's IP");
    await user.click(screen.getByTestId("group-call-hide-ip-cancel"));
    expect(screen.queryByTestId("group-call-hide-ip")).toBeNull();
    expect(passAsks()).toHaveLength(0);

    await user.click(screen.getByTestId("group-call-join"));
    await user.click(screen.getByTestId("group-call-hide-ip-confirm"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", {
      rtcConfig: { iceServers: [{ urls: ["turn:turn.sfu.ghostly.test:3478"], username: "u", credential: "c" }], iceTransportPolicy: "relay" },
    }));
    expect(passAsks()).toEqual([{ groupId: "group-hide-ip" }]);

    // Asked once: joining again goes straight in.
    await user.click(screen.getByTestId("group-call-leave"));
    await user.click(screen.getByTestId("group-call-join"));
    expect(screen.queryByTestId("group-call-hide-ip")).toBeNull();
    await waitFor(() => expect(FakeRoom.rooms[1]?.connect).toHaveBeenCalled());
  });

  it("asks again when the admin names another call node: the yes was for the node it was given for", async () => {
    answerPass(() => pass({ iceServers: [TURN] }));
    const group = community({ id: "group-new-node" });
    const { user, rerender } = hideIp(group);
    await user.click(screen.getByTestId("group-call-join"));
    await user.click(screen.getByTestId("group-call-hide-ip-confirm"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    await user.click(screen.getByTestId("group-call-leave"));

    const moved = { ...group, call: { sfu: "https://call.example.com" } };
    act(() => fakeEngine.update({ groups: [moved] }));
    rerender(<GroupCallButton group={moved} loadLivekit={loadLivekit} />);
    await user.click(screen.getByTestId("group-call-join"));
    expect(screen.getByTestId("group-call-hide-ip")).toBeInTheDocument();
    expect(FakeRoom.rooms).toHaveLength(1);
  });

  it("stays off, saying why, when the node gives no relay to go through", async () => {
    answerPass(() => pass({ iceServers: [{ urls: "stun:sfu.ghostly.test:3478" }] }));
    const { user } = hideIp(community({ id: "group-no-relay" }));
    await user.click(screen.getByTestId("group-call-join"));
    await user.click(screen.getByTestId("group-call-hide-ip-confirm"));
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("Can't join while Hide my IP is on");
    await user.click(screen.getByTestId("group-call-problem-notice-info"));
    expect(screen.getByTestId("group-call-problem-notice-why")).toHaveTextContent("Turn Hide my IP off to join");
    expect(screen.queryByTestId("group-call-retry")).toBeNull();
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(FakeRoom.rooms).toHaveLength(0);

    await user.click(screen.getByTestId("group-call-join"));
    expect(passAsks()).toHaveLength(1);
    expect(screen.queryByTestId("group-call-hide-ip")).toBeNull();
    expect(screen.getByTestId("group-call-problem-notice-title")).toHaveTextContent("Can't join while Hide my IP is on");

    // Hide my IP off: Join call is back.
    act(() => fakeEngine.update({ settings: { ...fakeEngine.state.settings, relayOnly: false } }));
    expect(screen.getByTestId("group-call-join")).not.toHaveAttribute("aria-disabled");
  });
});

describe("Join call where this app cannot join a group call", () => {
  const LINUX_DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const tauri = window as unknown as { __TAURI_INTERNALS__?: object };
  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
    Reflect.deleteProperty(navigator, "userAgent");
  });

  it("is off on the Linux Desktop, its ⓘ sending to the web app in a browser, and asks the node for nothing", async () => {
    Object.defineProperty(navigator, "userAgent", { value: LINUX_DESKTOP, configurable: true });
    tauri.__TAURI_INTERNALS__ = {};
    const asked = vi.fn(() => pass());
    answerPass(asked);
    const { user } = joinButton();
    const join = screen.getByTestId("group-call-join");
    expect(join).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("group-call-problem")).toBeNull();

    await user.click(screen.getByTestId("group-call-unsupported-info"));
    expect(screen.getByTestId("group-call-unsupported-info")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("group-call-problem-notice-title")).toHaveTextContent("Group calls aren't on Linux yet: join from app.ghostly.tools in a browser");
    expect(screen.queryByTestId("group-call-retry")).toBeNull();
    await user.click(screen.getByTestId("group-call-unsupported-info"));
    expect(screen.queryByTestId("group-call-problem")).toBeNull();

    await user.click(join);
    expect(screen.getByTestId("group-call-problem-notice-title")).toHaveTextContent("aren't on Linux yet");
    expect(asked).not.toHaveBeenCalled();
    expect(passAsks()).toHaveLength(0);
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(FakeRoom.rooms).toHaveLength(0);
  });

  it("is on in a browser on Linux, with no ⓘ", () => {
    Object.defineProperty(navigator, "userAgent", { value: LINUX_DESKTOP, configurable: true });
    joinButton();
    expect(screen.getByTestId("group-call-join")).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByTestId("group-call-unsupported-info")).toBeNull();
  });
});
