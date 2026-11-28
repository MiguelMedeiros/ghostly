// covers: calls.group.volume
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<object>(), invoke: vi.fn(async () => undefined) }));

import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
import type { CallDevices } from "../../hooks/useCallDevices";
import { forgetVolumes, setVolumeOf } from "../../lib/groupCallVolume";
import { EMPTY_DEVICES } from "../../lib/mediaDevices";
import { FakeTrack } from "../../../../../packages/react/test/fakes";
import { axeViolations } from "../axe";
import { renderApp } from "../render";

/**
 * Each other person's volume in a group call, on this device alone: a slider from 0 to 200% on their tile, which their
 * <audio> follows (past 100% through a Web Audio gain), 0 muting them for you, and kept for them into the next call.
 */

const audio = () => new FakeTrack("audio") as unknown as MediaStreamTrack;
const ANA = "ana".padEnd(52, "a"), BO = "bo".padEnd(52, "b");

function person(identity: string, name: string): GroupCallParticipant {
  return { identity, name, mic: true, camera: false, screen: false, speaking: false, tracks: { audio: audio() } };
}
const call = (): GroupCallState => ({ local: person("me".padEnd(52, "m"), "Me"), participants: [person(ANA, "Ana"), person(BO, "Bo")], activeSpeaker: null });

function view(state = call(), devices: CallDevices | null = null) {
  const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
  return renderApp(<GroupCallView call={state} groupName="Club" {...handlers} devices={devices} />);
}
const tileOf = (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
const volumeButton = (identity: string) => within(tileOf(identity)).getByTestId("group-call-volume");
/** The <audio> of each other person, in the order they are in the call. */
const players = () => screen.getAllByTestId("group-call-audio") as HTMLAudioElement[];
const slide = (percent: number) => fireEvent.change(screen.getByTestId("group-call-volume-slider"), { target: { value: String(percent) } });

/**
 * A Web Audio stand-in: each context's gains (`gain`: the last one made), whether it was closed, and its state
 * (`starts`: what `resume()` gives, as a gesture would; `held`: each `resume()` waits for its context's `release()`).
 */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  static starts: AudioContextState = "running";
  static held = false;
  gains: { gain: { value: number }; connect: (to: unknown) => unknown; disconnect: () => void }[] = [];
  get gain() { return this.gains[this.gains.length - 1]!; }
  closed = false;
  destination = {};
  state: AudioContextState = "suspended";
  onstatechange: (() => void) | null = null;
  listeners = new Set<() => void>();
  /** Settles every `resume()` still held. */
  release = () => {};
  constructor() { FakeAudioContext.made.push(this); }
  createGain() {
    const gain = { gain: { value: 1 }, connect: vi.fn((to: unknown) => to), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }
  createMediaStreamSource() { return { connect: (to: unknown) => to, disconnect: vi.fn() }; }
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener); }
  resume = vi.fn(async () => {
    if (FakeAudioContext.held) {
      const before = this.release;
      await new Promise<void>((done) => { this.release = () => { before(); done(); }; });
    }
    if (!this.closed) this.state = FakeAudioContext.starts;
  });
  close = vi.fn(async () => { this.closed = true; this.state = "closed"; });
  /** The engine starts or stops it on its own (a gesture, an interruption). */
  becomes(state: AudioContextState) {
    this.state = state;
    this.onstatechange?.();
    for (const listener of [...this.listeners]) listener();
  }
}
const withWebAudio = () => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: MediaStreamTrack[]) {} });
};
/** iOS ignores `volume` written from script: it reads back 1. */
const onIos = () => {
  const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
  Object.defineProperty(HTMLMediaElement.prototype, "volume", { configurable: true, get: () => 1, set: () => {} });
  onTestFinished(() => { Object.defineProperty(HTMLMediaElement.prototype, "volume", real); });
};
/** A speaker picked in the call's device menu. */
const onSpeaker = (speaker: string): CallDevices => ({
  list: EMPTY_DEVICES, current: { audioinput: "", videoinput: "", audiooutput: speaker }, speaker, speakers: true,
  choose: vi.fn(), notice: null, dismiss: vi.fn(), switchBack: vi.fn(), hold: vi.fn(),
});

afterEach(() => {
  forgetVolumes();
  FakeAudioContext.made = [];
  FakeAudioContext.starts = "running";
  FakeAudioContext.held = false;
  vi.unstubAllGlobals();
  localStorage.removeItem("ghostly_group_call_mini");
});

describe("each person's volume in a group call", () => {
  it("is on each other person's tile, named for them, and not on yours", () => {
    view();
    expect(volumeButton(ANA)).toHaveAccessibleName("⁨Ana⁩'s volume");
    expect(volumeButton(BO)).toHaveAccessibleName("⁨Bo⁩'s volume");
    expect(within(tileOf("me".padEnd(52, "m"))).queryByTestId("group-call-volume")).toBeNull();
  });

  it("turns one person down for you alone, and at 0 mutes them for you", async () => {
    const { user } = view();
    await user.click(volumeButton(ANA));
    const slider = screen.getByTestId("group-call-volume-slider");
    expect(slider).toHaveFocus();
    expect(slider).toHaveValue("100");
    slide(40);
    expect(players()[0]!.volume).toBeCloseTo(0.4);
    expect(players()[0]!.muted).toBe(false);
    expect(screen.getByTestId("group-call-volume-value")).toHaveTextContent("40%");
    // Bo is as loud as before.
    expect(players()[1]!.volume).toBe(1);

    slide(0);
    expect(players()[0]!.muted).toBe(true);
    expect(volumeButton(ANA)).toHaveAccessibleName("⁨Ana⁩ is muted for you");
    expect(players()[1]!.muted).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("plays someone past 100% through a gain, the element muted so they're not heard twice, and back at 100% without it", async () => {
    withWebAudio();
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(150);
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(FakeAudioContext.made[0]!.gain.gain.value).toBe(1.5);
    await waitFor(() => expect(players()[0]!.muted).toBe(true));

    slide(200);
    // The same gain, turned up.
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(FakeAudioContext.made[0]!.gain.gain.value).toBe(2);

    slide(100);
    await act(async () => {});
    expect(FakeAudioContext.made[0]!.closed).toBe(true);
    expect(players()[0]!.muted).toBe(false);
    expect(players()[0]!.volume).toBe(1);
  });

  it("plays everyone turned up through one Web Audio context, closed once the call no longer needs it", async () => {
    // Each context is a sound path of its own, ~1% of a core in Chromium: 24 people turned up took 6.5 s of CPU every
    // 10 s with one each, 4.5 s with one for all.
    withWebAudio();
    setVolumeOf(ANA, 1.5);
    setVolumeOf(BO, 2);
    const state = call();
    state.participants[0]!.screen = true;
    state.participants[0]!.tracks.screenAudio = audio();
    const { unmount } = view(state);
    await act(async () => {});
    expect(FakeAudioContext.made).toHaveLength(1);
    const [context] = FakeAudioContext.made;
    // Ana's voice, Bo's, then Ana's screen's sound, each at its own level.
    expect(context!.gains.map((gain) => gain.gain.value)).toEqual([1.5, 2, 1.5]);
    await waitFor(() => expect([...players(), screen.getByTestId("group-call-screen-audio")].map((p) => (p as HTMLAudioElement).muted)).toEqual([true, true, true]));

    unmount();
    await act(async () => {});
    expect(context!.closed).toBe(true);
  });

  it("keeps someone heard past 100% while Web Audio doesn't run, and moves them to the gain once it does", async () => {
    withWebAudio();
    // WebKit starts no context outside a gesture; iOS puts one in "interrupted" during a phone call.
    FakeAudioContext.starts = "suspended";
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(150);
    await act(async () => {});
    const context = FakeAudioContext.made[0]!;
    expect(context.resume).toHaveBeenCalled();
    expect(players()[0]!.muted).toBe(false);

    act(() => context.becomes("running"));
    expect(players()[0]!.muted).toBe(true);
    act(() => context.becomes("interrupted" as AudioContextState));
    expect(players()[0]!.muted).toBe(false);
  });

  it("turns someone down through the gain where the element's volume can't be set (iOS)", async () => {
    withWebAudio();
    onIos();
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(40);
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(FakeAudioContext.made[0]!.gain.gain.value).toBeCloseTo(0.4);
    await waitFor(() => expect(players()[0]!.muted).toBe(true));
    // Bo, at 100%, needs no gain.
    expect(players()[1]!.muted).toBe(false);
  });

  it("starts a gain made outside a gesture from the slider, for a level kept from an earlier call", async () => {
    withWebAudio();
    setVolumeOf(ANA, 1.5);
    // The call starts outside a gesture: WebKit leaves the context suspended, and Ana plays at 1 meanwhile.
    FakeAudioContext.starts = "suspended";
    const { user } = view();
    await act(async () => {});
    const context = FakeAudioContext.made[0]!;
    expect(context.state).toBe("suspended");
    expect(players()[0]!.muted).toBe(false);

    // The slider is a gesture: there the context can start.
    FakeAudioContext.starts = "running";
    await user.click(volumeButton(ANA));
    slide(160);
    await act(async () => {});
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(context.state).toBe("running");
    expect(players()[0]!.muted).toBe(true);
  });

  it("plays someone as close to their level as the element can while the gain doesn't run", async () => {
    withWebAudio();
    FakeAudioContext.starts = "suspended";
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(40);
    // Straight from 40% to 150%: the element alone plays them, at 1.
    slide(150);
    await act(async () => {});
    expect(FakeAudioContext.made[0]!.state).toBe("suspended");
    expect({ muted: players()[0]!.muted, volume: players()[0]!.volume }).toEqual({ muted: false, volume: 1 });
  });

  it("mutes someone at 0 on iOS while the gain doesn't run", async () => {
    withWebAudio();
    onIos();
    // Interrupted (a phone call): no resume() settles.
    FakeAudioContext.held = true;
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(40);
    await act(async () => {});
    expect(players()[0]!.muted).toBe(false);
    slide(0);
    await act(async () => {});
    expect(players()[0]!.muted).toBe(true);
  });

  it("plays a replaced track through a new gain in the same context, the old one let go", async () => {
    withWebAudio();
    setVolumeOf(ANA, 1.5);
    FakeAudioContext.held = true;
    const state = call();
    const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
    const { rerender } = renderApp(<GroupCallView call={state} groupName="Club" {...handlers} />);
    const context = FakeAudioContext.made[0]!;
    const [first] = context.gains;
    // Ana's track is replaced (a new microphone): a new gain, while the first one's resume is still on its way.
    const next = { ...state, participants: [{ ...state.participants[0]!, tracks: { audio: audio() } }, state.participants[1]!] };
    rerender(<GroupCallView call={next} groupName="Club" {...handlers} />);
    await act(async () => {});
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(context.closed).toBe(false);
    expect(first!.disconnect).toHaveBeenCalled();
    expect(context.gains).toHaveLength(2);
    await act(async () => { context.release(); });
    // Muted under the running gain: she'd be heard twice.
    expect(players()[0]!.muted).toBe(true);
  });

  it("goes only up to 100% on a chosen speaker that Web Audio can't play on", async () => {
    // Firefox and Safari: an AudioContext, but no `setSinkId` on it.
    withWebAudio();
    const { user } = view(call(), onSpeaker("headset"));
    await user.click(volumeButton(ANA));
    expect(screen.getByTestId("group-call-volume-slider")).toHaveAttribute("max", "100");
    slide(150);
    expect(FakeAudioContext.made).toHaveLength(0);
    expect(screen.getByTestId("group-call-volume-value")).toHaveTextContent("100%");
  });

  it("goes up to 200% on a chosen speaker where Web Audio picks it", async () => {
    vi.stubGlobal("AudioContext", class extends FakeAudioContext { async setSinkId() {} });
    vi.stubGlobal("MediaStream", class { constructor(readonly tracks: MediaStreamTrack[]) {} });
    const { user } = view(call(), onSpeaker("headset"));
    await user.click(volumeButton(ANA));
    expect(screen.getByTestId("group-call-volume-slider")).toHaveAttribute("max", "200");
  });

  it("sets the sound of the screen someone shares as loud as their voice", async () => {
    const state = call();
    state.participants[0]!.screen = true;
    state.participants[0]!.tracks.screenAudio = audio();
    const { user } = view(state);
    const screenSound = () => screen.getByTestId("group-call-screen-audio") as HTMLAudioElement;
    await user.click(volumeButton(ANA));
    slide(40);
    expect(screenSound().volume).toBeCloseTo(0.4);
    slide(0);
    expect(screenSound().muted).toBe(true);
  });

  it("keeps the volume set for that person in the next call", async () => {
    const { user, unmount } = view();
    await user.click(volumeButton(BO));
    slide(25);
    unmount();

    view();
    expect(players()[1]!.volume).toBeCloseTo(0.25);
    expect(players()[0]!.volume).toBe(1);
    expect(volumeButton(BO)).toHaveAttribute("data-volume", "0.25");
  });

  it("has no volume button in the small window", () => {
    localStorage.setItem("ghostly_group_call_mini", "1");
    view();
    expect(screen.queryByTestId("group-call-volume")).toBeNull();
  });

  it("closes with Escape, the focus back on its button", async () => {
    const { user } = view();
    await user.click(volumeButton(ANA));
    await act(async () => { await user.keyboard("{Escape}"); });
    expect(screen.queryByTestId("group-call-volume-menu")).toBeNull();
    expect(volumeButton(ANA)).toHaveFocus();
  });
});
