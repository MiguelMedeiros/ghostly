// covers: calls.group.volume
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<object>(), invoke: vi.fn(async () => undefined) }));

import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
import { forgetVolumes } from "../../lib/groupCallVolume";
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

function view(state = call()) {
  const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
  return renderApp(<GroupCallView call={state} groupName="Club" {...handlers} />);
}
const tileOf = (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
const volumeButton = (identity: string) => within(tileOf(identity)).getByTestId("group-call-volume");
/** The <audio> of each other person, in the order they are in the call. */
const players = () => screen.getAllByTestId("group-call-audio") as HTMLAudioElement[];
const slide = (percent: number) => fireEvent.change(screen.getByTestId("group-call-volume-slider"), { target: { value: String(percent) } });

/** A Web Audio stand-in: each context's gain, and whether it was closed. */
class FakeAudioContext {
  static made: FakeAudioContext[] = [];
  gain = { gain: { value: 1 }, connect: vi.fn((to: unknown) => to) };
  closed = false;
  destination = {};
  constructor() { FakeAudioContext.made.push(this); }
  createGain() { return this.gain; }
  createMediaStreamSource() { return { connect: (to: unknown) => to }; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.closed = true; });
}

afterEach(() => {
  forgetVolumes();
  FakeAudioContext.made = [];
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
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaStream", class { constructor(readonly tracks: MediaStreamTrack[]) {} });
    const { user } = view();
    await user.click(volumeButton(ANA));
    slide(150);
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(FakeAudioContext.made[0]!.gain.gain.value).toBe(1.5);
    expect(players()[0]!.muted).toBe(true);

    slide(200);
    // The same gain, turned up.
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(FakeAudioContext.made[0]!.gain.gain.value).toBe(2);

    slide(100);
    expect(FakeAudioContext.made[0]!.closed).toBe(true);
    expect(players()[0]!.muted).toBe(false);
    expect(players()[0]!.volume).toBe(1);
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
