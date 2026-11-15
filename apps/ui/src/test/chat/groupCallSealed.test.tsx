import "fake-indexeddb/auto";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import type { GroupView } from "@ghostly/browser/shared/types";
import { GroupCallButton } from "../../components/GroupCallButton";
import type { LivekitModule } from "../../hooks/useGroupCall";
import { canSealCallMedia, type GroupCallPass } from "../../lib/groupCallPass";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group.e2ee

/**
 * Join call in a group whose call is sealed end to end (WISP 602 § End-to-end encryption, `call.e2ee: 1`): the room is
 * joined with LiveKit's E2EE keyed by the group's call key from the engine (`groupCallKey`), the next epoch's key goes
 * into the call when the group moves on, and nothing is joined unsealed: not in a browser that can't seal call media
 * (Join call off, the reason behind its ⓘ), and not while the key isn't here (another reason, and Try again).
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
const SEALED = { sfu: "https://sfu.ghostly.test", e2ee: 1 as const };
const community = (patch: Partial<GroupView> = {}) =>
  ({ ...groupView({ profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }] }), call: SEALED, ...patch }) as GroupView;
const pass = (): GroupCallPass => ({ url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_group-1", identity: ME, expiresIn: 600 });
const callKey = (epoch: number, fill: number) => ({ epoch, key: toBase64Url(new Uint8Array(32).fill(fill)) });
const asks = (method: string) => fakeEngine.calls.filter((c) => (c.method as string) === method).map((c) => c.params);

class FakeKeyProvider {
  static providers: FakeKeyProvider[] = [];
  readonly keys: number[][] = [];
  readonly setKey = vi.fn(async (key: ArrayBuffer) => { this.keys.push([...new Uint8Array(key)]); });
  constructor() { FakeKeyProvider.providers.push(this); }
}

class FakeRoom {
  static rooms: FakeRoom[] = [];
  /** The next room comes without LiveKit's E2EE manager: joined, it does not seal (`hasE2EESetup` false). */
  static noManager = false;
  readonly remoteParticipants = new Map();
  readonly activeSpeakers = [];
  private readonly listeners = new Map<string, () => void>();
  /** LiveKit's: E2EE set up on the room, and on once its worker says so (here, as E2EE is turned on). */
  private readonly manager = !FakeRoom.noManager;
  get hasE2EESetup() { return !!this.options.encryption && this.manager; }
  isE2EEEnabled = false;
  readonly localParticipant = {
    identity: ME, name: "Me", isMicrophoneEnabled: false, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false, isE2EEEnabled: false,
    trackPublications: new Map(), getTrackPublication: () => undefined,
    setMicrophoneEnabled: vi.fn(async () => undefined),
  };
  readonly connect = vi.fn(async (_url: string, _token: string, _options?: unknown) => {});
  readonly disconnect = vi.fn(async () => this.listeners.get("disconnected")?.());
  readonly setE2EEEnabled = vi.fn(async (on: boolean) => { this.isE2EEEnabled = on; this.localParticipant.isE2EEEnabled = on; });
  constructor(readonly options: { encryption?: { keyProvider: FakeKeyProvider; worker: unknown } }) { FakeRoom.rooms.push(this); }
  on(event: string, listener: () => void) { this.listeners.set(event, listener); return this; }
}
const RoomEvent = new Proxy({}, { get: (_, name) => (name === "Disconnected" ? "disconnected" : String(name)) });
const worker = { terminate: vi.fn() };
const loadLivekit = async () => ({
  Room: FakeRoom, RoomEvent, Track: { Source: {} }, ExternalE2EEKeyProvider: FakeKeyProvider, isE2EESupported: () => true, e2eeWorker: () => worker,
}) as unknown as LivekitModule;

function joinButton(group = community()) {
  fakeEngine.update({ groups: [group] });
  return renderApp(<GroupCallButton group={group} loadLivekit={loadLivekit} />);
}

/** A browser that can seal call media (RTCRtpScriptTransform); the test DOM has neither it nor Insertable Streams. */
const canSeal = () => Object.defineProperty(window, "RTCRtpScriptTransform", { configurable: true, value: class {} });

beforeEach(() => {
  fakeEngine.on("groupCallToken", () => pass());
});

afterEach(() => {
  vi.useRealTimers();
  FakeRoom.rooms = [];
  FakeRoom.noManager = false;
  FakeKeyProvider.providers = [];
  Reflect.deleteProperty(window, "RTCRtpScriptTransform");
});

describe("Join call in a group whose call is sealed end to end", () => {
  it("joins with the group's call key: LiveKit's E2EE on the room, the key's own bytes in its key provider", async () => {
    canSeal();
    fakeEngine.on("groupCallKey", () => callKey(1, 5));
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call")).toBeInTheDocument();
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", { autoSubscribe: false }));
    expect(asks("groupCallKey")[0]).toEqual({ groupId: "group-1" });
    const [provider] = FakeKeyProvider.providers;
    expect(FakeRoom.rooms[0].options.encryption).toEqual({ keyProvider: provider, worker });
    expect(FakeRoom.rooms[0].setE2EEEnabled).toHaveBeenCalledWith(true);
    expect(provider.keys).toEqual([Array(32).fill(5)]);
  });

  it("sets the next epoch's key in the call when the group moves on, and stays in the room", async () => {
    canSeal();
    let key = callKey(1, 5);
    fakeEngine.on("groupCallKey", () => key);
    const { user, rerender } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    const [provider] = FakeKeyProvider.providers;
    key = callKey(2, 6);
    const moved = community({ epoch: 2 });
    act(() => fakeEngine.update({ groups: [moved] }));
    rerender(<GroupCallButton group={moved} loadLivekit={loadLivekit} />);
    await waitFor(() => expect(provider.keys).toEqual([Array(32).fill(5), Array(32).fill(6)]));
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(FakeRoom.rooms[0].disconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
  });

  it("an epoch's secret that comes after the key's last ask still goes into the call, once the group's view says it is here", async () => {
    canSeal();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let key: ReturnType<typeof callKey> | null = callKey(1, 5);
    fakeEngine.on("groupCallKey", () => key);
    const { user, rerender } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    const [provider] = FakeKeyProvider.providers;
    // A member taken out: the commit is here (epoch 2), this member's own fresh secret not yet (no call key).
    key = null;
    const waiting = community({ epoch: 2, canSend: false });
    act(() => fakeEngine.update({ groups: [waiting] }));
    rerender(<GroupCallButton group={waiting} loadLivekit={loadLivekit} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    const asked = asks("groupCallKey").length;
    // The secret comes past every retry: the epoch is the same, the view now says the epoch can be read.
    key = callKey(2, 6);
    const keyed = community({ epoch: 2, canSend: true });
    act(() => fakeEngine.update({ groups: [keyed] }));
    rerender(<GroupCallButton group={keyed} loadLivekit={loadLivekit} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await waitFor(() => expect(provider.keys).toEqual([Array(32).fill(5), Array(32).fill(6)]));
    expect(asks("groupCallKey").length).toBe(asked + 1);
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(FakeRoom.rooms[0].disconnect).not.toHaveBeenCalled();
  });

  it("in a browser that can't seal call media, Join call is off with the reason behind its ⓘ, and nothing is asked or joined", async () => {
    expect(canSealCallMedia()).toBe(false);
    fakeEngine.on("groupCallKey", () => callKey(1, 5));
    const { user } = joinButton();
    const join = screen.getByTestId("group-call-join");
    expect(join).toHaveAttribute("aria-disabled", "true");
    await user.click(join);
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("Can't join this sealed call here");
    await user.click(screen.getByTestId("group-call-problem-notice-info"));
    expect(screen.getByTestId("group-call-problem-notice-why")).toHaveTextContent("This group's calls are sealed end to end, and this browser can't seal them.");
    expect(screen.queryByTestId("group-call-retry")).toBeNull();
    expect(asks("groupCallToken")).toHaveLength(0);
    expect(asks("groupCallKey")).toHaveLength(0);
    expect(FakeRoom.rooms).toHaveLength(0);
    expect(screen.queryByTestId("group-call")).toBeNull();
  });

  it("while the group's call key isn't here, joins nothing and says so with another reason; Try again joins once it is", async () => {
    canSeal();
    let key: ReturnType<typeof callKey> | null = null;
    fakeEngine.on("groupCallKey", () => key);
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("Can't join yet: the call's key isn't here");
    expect(asks("groupCallToken")).toHaveLength(0);
    expect(FakeRoom.rooms).toHaveLength(0);
    key = callKey(1, 5);
    await user.click(screen.getByTestId("group-call-retry"));
    expect(await screen.findByTestId("group-call")).toBeInTheDocument();
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    expect(FakeKeyProvider.providers[0].keys).toEqual([Array(32).fill(5)]);
  });

  it("a view whose call says e2ee: true (the flag form) is sealed as e2ee: 1 is: the key asked, LiveKit's E2EE on", async () => {
    canSeal();
    fakeEngine.on("groupCallKey", () => callKey(1, 5));
    const { user } = joinButton(community({ call: { sfu: SEALED.sfu, e2ee: true } as unknown as GroupView["call"] }));
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalledWith("wss://sfu.ghostly.test", "pass-1", { autoSubscribe: false }));
    expect(asks("groupCallKey")[0]).toEqual({ groupId: "group-1" });
    expect(FakeRoom.rooms[0].options.encryption).toEqual({ keyProvider: FakeKeyProvider.providers[0], worker });
    expect(FakeRoom.rooms[0].setE2EEEnabled).toHaveBeenCalledWith(true);
  });

  it("a sealed call whose room doesn't seal once joined is left: the window goes, and the notice says why", async () => {
    canSeal();
    FakeRoom.noManager = true;
    fakeEngine.on("groupCallKey", () => callKey(1, 5));
    const { user } = joinButton();
    await user.click(screen.getByTestId("group-call-join"));
    expect(await screen.findByTestId("group-call-problem-notice-title")).toHaveTextContent("This call couldn't be sealed, so you left it");
    const [room] = FakeRoom.rooms;
    expect(room.connect).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(screen.queryByTestId("group-call")).toBeNull();
    await user.click(screen.getByTestId("group-call-problem-notice-info"));
    expect(screen.getByTestId("group-call-problem-notice-why")).toHaveTextContent("so you left before anything went out unsealed.");
    expect(screen.getByTestId("group-call-problem-notice-details")).toHaveTextContent("no E2EE manager on the room");
  });

  it("a group whose call is not sealed joins as before: no key asked, no E2EE on the room", async () => {
    fakeEngine.on("groupCallKey", () => callKey(1, 5));
    const { user } = joinButton(community({ call: { sfu: SEALED.sfu } }));
    expect(screen.getByTestId("group-call-join")).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(FakeRoom.rooms[0]?.connect).toHaveBeenCalled());
    expect(asks("groupCallKey")).toHaveLength(0);
    expect(FakeRoom.rooms[0].options.encryption).toBeUndefined();
    expect(FakeRoom.rooms[0].setE2EEEnabled).not.toHaveBeenCalled();
  });
});
