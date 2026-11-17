import "fake-indexeddb/auto";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endOtherCalls } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { device, FakeTrack, installWebRTCFakes, type FakeMediaDevices } from "../../../../../packages/react/test/fakes";
import { GroupCallButton } from "../../components/GroupCallButton";
import type { LivekitModule } from "../../hooks/useGroupCall";
import { chooseDevice } from "../../lib/mediaDevices";
import type { GroupCallPass } from "../../lib/groupCallPass";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group, calls.devices

/**
 * A group call's devices, as a 1:1 call's (`useGroupCallDevices`), in the window `GroupCallButton` really mounts: the
 * others play on the speaker chosen in Settings, the Devices menu and the device notice are there, a choice made in
 * Settings during the call is followed, and an unplugged headset falls back to the default and says so. The room is a
 * fake LiveKit (no WebRTC in the test DOM); the microphone switches through its own track (`setDeviceId`).
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
const ANA = "an".padEnd(52, "a");
const community = () =>
  ({ ...groupView({ profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }, { key: ANA, role: "member", me: false, online: true, missing: 0 }] }), call: { sfu: "https://sfu.ghostly.test" } }) as GroupView;
const pass: GroupCallPass = { url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_group-1", identity: ME, expiresIn: 600 };

const Source = { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share" } as const;
type SourceName = (typeof Source)[keyof typeof Source];

let media: FakeMediaDevices;
let uninstall: () => void;

/** LiveKit's local track: `setDeviceId` stops the capture and opens the device asked for, exactly or ideally, as `restart` does. */
class FakeLocalTrack {
  /** Devices held by another app: opening one fails. */
  static held = new Set<string>();
  isMuted = false;
  constructor(public mediaStreamTrack: MediaStreamTrack) {}
  readonly stop = vi.fn(() => this.mediaStreamTrack.stop());
  readonly setDeviceId = vi.fn(async (constraint: ConstrainDOMString) => {
    const wanted = typeof constraint === "string" ? { ideal: constraint } : (constraint as ConstrainDOMStringParameters);
    const id = (wanted.exact ?? wanted.ideal) as string;
    this.mediaStreamTrack.stop();
    const listed = media.devices.find((d) => d.kind === "audioinput" && d.deviceId === id);
    if (wanted.exact && !listed) throw new DOMException("No such device", "OverconstrainedError");
    if (FakeLocalTrack.held.has(id)) throw new DOMException("Could not start audio source", "NotReadableError");
    this.mediaStreamTrack = new FakeTrack("audio", listed?.deviceId ?? "default", listed?.label ?? "Default") as unknown as MediaStreamTrack;
    return true;
  });
}

class FakePublication {
  isMuted = false;
  readonly isEncrypted = true;
  constructor(readonly source: SourceName, readonly track: FakeLocalTrack) {}
}

class FakeParticipant {
  readonly isSpeaking = false;
  readonly trackPublications = new Map<string, FakePublication>();
  constructor(readonly identity: string, readonly name: string) {}
  getTrackPublication(source: SourceName) { return this.trackPublications.get(source); }
  private on(source: SourceName) { const pub = this.trackPublications.get(source); return !!pub && !pub.isMuted; }
  get isMicrophoneEnabled() { return this.on(Source.Microphone); }
  get isCameraEnabled() { return this.on(Source.Camera); }
  get isScreenShareEnabled() { return this.on(Source.ScreenShare); }
}

class FakeLocalParticipant extends FakeParticipant {
  /** LiveKit's: the first time it opens the device asked for (`deviceId`, ideally); after, it only unmutes. */
  readonly setMicrophoneEnabled = vi.fn(async (on: boolean, options?: { deviceId?: ConstrainDOMString }) => {
    let pub = this.trackPublications.get(Source.Microphone);
    if (on && !pub) {
      const asked = options?.deviceId;
      const id = typeof asked === "string" ? asked : ((asked as ConstrainDOMStringParameters | undefined)?.ideal as string | undefined);
      const listed = media.devices.find((d) => d.kind === "audioinput" && d.deviceId === id);
      pub = new FakePublication(Source.Microphone, new FakeLocalTrack(new FakeTrack("audio", listed?.deviceId ?? "default", listed?.label ?? "Default") as unknown as MediaStreamTrack));
      this.trackPublications.set(Source.Microphone, pub);
    }
    if (pub) pub.isMuted = !on;
  });
}

class FakeRoom {
  static rooms: FakeRoom[] = [];
  readonly activeSpeakers = [];
  readonly localParticipant = new FakeLocalParticipant(ME, "Me");
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor() {
    FakeRoom.rooms.push(this);
    // Ana is in the room, heard.
    const ana = new FakeParticipant(ANA, "Ana");
    ana.trackPublications.set(Source.Microphone, new FakePublication(Source.Microphone, new FakeLocalTrack(new FakeTrack("audio") as unknown as MediaStreamTrack)));
    this.remoteParticipants.set(ANA, ana);
  }
  readonly connect = vi.fn(async () => {});
  readonly disconnect = vi.fn(async () => {});
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
}
const RoomEvent = new Proxy({}, { get: (_, name) => String(name) });
const loadLivekit = async () => ({ Room: FakeRoom, RoomEvent, Track: { Source } }) as unknown as LivekitModule;

/** The speakers each <audio> was sent to (`setSinkId`), in order. */
let sinks: [HTMLMediaElement, string][];

beforeEach(() => {
  ({ devices: media, uninstall } = installWebRTCFakes());
  media.devices = [
    device("audioinput", "m0", "MacBook Pro Microphone"), device("audioinput", "m1", "Headset Microphone"),
    device("audiooutput", "s0", "MacBook Pro Speakers"), device("audiooutput", "s1", "Headset"),
  ];
  sinks = [];
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn(async function (this: HTMLMediaElement, id: string) {
      sinks.push([this, id]);
      Object.defineProperty(this, "sinkId", { configurable: true, value: id });
    }),
  });
  // Chosen in Settings before the call: the headset, both ways.
  localStorage.setItem("ghostly_media_devices", JSON.stringify({ audiooutput: { id: "s1", label: "Headset" }, audioinput: { id: "m1", label: "Headset Microphone" } }));
});

afterEach(() => {
  uninstall();
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  FakeRoom.rooms = [];
  FakeLocalTrack.held.clear();
  endOtherCalls(Symbol("none"));
});

/** In the group's call, Ana heard, the microphone on the headset's. */
async function inCall() {
  (fakeEngine as unknown as { on(method: string, h: () => unknown): void }).on("groupCallToken", () => pass);
  const group = community();
  fakeEngine.update({ groups: [group] });
  const rendered = renderApp(<GroupCallButton group={group} loadLivekit={loadLivekit} />);
  await rendered.user.click(screen.getByTestId("group-call-join"));
  await screen.findByTestId("group-call");
  await waitFor(() => expect(screen.getByTestId("group-call-mic")).toHaveAttribute("title", "Mute"));
  const room = FakeRoom.rooms[0]!;
  const mic = () => room.localParticipant.getTrackPublication(Source.Microphone)!.track;
  expect(mic().mediaStreamTrack.getSettings().deviceId).toBe("m1");
  return { ...rendered, room, mic, audio: () => screen.getByTestId("group-call-audio") as HTMLAudioElement };
}

const sinkOf = (element: HTMLMediaElement) => sinks.filter(([el]) => el === element).map(([, id]) => id);

describe("a group call's devices", () => {
  it("plays the others on the speaker chosen in Settings", async () => {
    const { audio } = await inCall();
    await waitFor(() => expect(sinkOf(audio())).toEqual(["s1"]));
  });

  it("has the Devices menu, and a microphone picked there is switched in the call's own track", async () => {
    const { user, mic } = await inCall();
    await user.click(await screen.findByTestId("call-devices"));
    const menu = await screen.findByTestId("call-devices-menu");
    const builtIn = within(menu).getAllByTestId("call-device-audioinput").find((item) => item.getAttribute("data-device-id") === "m0")!;
    await user.click(builtIn);
    await waitFor(() => expect(mic().mediaStreamTrack.getSettings().deviceId).toBe("m0"));
    expect(mic().setDeviceId).toHaveBeenCalledWith({ exact: "m0" });
  });

  it("a microphone picked there that will not open says so, and the call goes on with the one it had", async () => {
    const { user, mic } = await inCall();
    FakeLocalTrack.held.add("m0");
    await user.click(await screen.findByTestId("call-devices"));
    const menu = await screen.findByTestId("call-devices-menu");
    await user.click(within(menu).getAllByTestId("call-device-audioinput").find((item) => item.getAttribute("data-device-id") === "m0")!);
    expect(await screen.findByTestId("call-device-notice")).toHaveAttribute("data-type", "failed");
    await waitFor(() => expect(mic().mediaStreamTrack.getSettings().deviceId).toBe("m1"));
    expect(mic().mediaStreamTrack.readyState).toBe("live");
  });

  it("follows a speaker and a microphone chosen in Settings during the call", async () => {
    const { audio, mic } = await inCall();
    await act(async () => {
      chooseDevice("audioinput", { id: "m0", label: "MacBook Pro Microphone" });
      chooseDevice("audiooutput", { id: "s0", label: "MacBook Pro Speakers" });
    });
    await waitFor(() => expect(mic().mediaStreamTrack.getSettings().deviceId).toBe("m0"));
    expect(mic().setDeviceId).toHaveBeenCalledWith({ exact: "m0" });
    await waitFor(() => expect(sinkOf(audio()).slice(-1)[0]).toBe("s0"));
  });

  it("falls back to the default when the headset is unplugged, and says so", async () => {
    const { audio, mic } = await inCall();
    await act(async () => {
      (mic().mediaStreamTrack as unknown as FakeTrack).unplug();
      media.devices = media.devices.filter((d) => d.deviceId !== "m1" && d.deviceId !== "s1");
      media.dispatchEvent(new Event("devicechange"));
    });
    const notice = await screen.findByTestId("call-device-notice");
    expect(notice).toHaveAttribute("data-type", "lost");
    await waitFor(() => expect(mic().mediaStreamTrack.getSettings().deviceId).toBe("default"));
    expect(mic().mediaStreamTrack.readyState).toBe("live");
    // Off the headset's speaker, onto the default.
    await waitFor(() => expect(sinkOf(audio()).slice(-1)[0]).toBe(""));
    expect(sinkOf(audio())).toContain("s1");
  });
});
