import "fake-indexeddb/auto";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endOtherCalls } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import type { GroupCallOccupancyResult } from "@ghostly/browser/engine/groupCall";
import { GroupCallButton } from "../../components/GroupCallButton";
import type { LivekitModule } from "../../hooks/useGroupCall";
import { OCCUPANCY_BACKOFF_MAX_MS, OCCUPANCY_FLOOR_MS, occupancyBackoffMs } from "../../hooks/useGroupCallOccupancy";
import type { GroupCallPass } from "../../lib/groupCallPass";
import { refreshWindowAway } from "../../lib/windowAway";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * Whether a group's call is on, before joining it (WISP 602 § Occupancy): the header asks the engine
 * (`groupCallOccupancy`) when the group opens and every 15 s while it is in sight, never while the page is hidden or
 * its window in the background, nor more often than that. What else comes back sets the next ask, per call node: a
 * 403, or a reply that is no occupancy, the same 15 s; a 404 or 405 none until the group's call changes; a 429 its
 * Retry-After (60 s without one it can read); no answer less and less often (up to 10 min); and coming back to the
 * group cuts none of these short. With "Hide my IP" on the engine sends nothing (`hidden`): nothing is asked again
 * until that setting changes.
 * Join call, labelled in the call's colour, only while someone is in the call; Start call, a plain phone, while nobody
 * is; Join call as before while that is not known; and in the call, the call's own button, with nothing asked.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
let groups = 0;
/**
 * A community under an id of its own, with a call node of its own unless `sfu` is given: neither the group nor its
 * node was asked about on this page before.
 */
const community = (sfu?: string) => {
  const n = ++groups;
  return { ...groupView({ id: `occupancy-${n}`, profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }] }), call: { sfu: sfu ?? `https://sfu-${n}.ghostly.test` } } as GroupView;
};

class FakeRoom {
  readonly remoteParticipants = new Map();
  readonly activeSpeakers = [];
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();
  readonly localParticipant = {
    identity: ME, name: "Me", isMicrophoneEnabled: false, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false,
    trackPublications: new Map(), getTrackPublication: () => undefined, setMicrophoneEnabled: vi.fn(async () => {}),
  };
  readonly connect = vi.fn(async () => {});
  readonly disconnect = vi.fn(async () => this.listeners.get("disconnected")?.());
  on(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener); return this; }
}
const RoomEvent = new Proxy({}, { get: (_, name) => (name === "Disconnected" ? "disconnected" : String(name)) });
const loadLivekit = async () => ({ Room: FakeRoom, RoomEvent, Track: { Source: {} } }) as unknown as LivekitModule;
const pass = (): GroupCallPass => ({ url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_x", identity: ME, expiresIn: 600 });

/** The node's answer from now on, through the engine. */
const answer = (handler: () => GroupCallOccupancyResult | Promise<GroupCallOccupancyResult>) => fakeEngine.on("groupCallOccupancy", handler);
const asks = () => fakeEngine.callsTo("groupCallOccupancy").length;
/** The node's answer, `ms` after it was asked. */
const late = (ms: number, result: GroupCallOccupancyResult) => () => new Promise<GroupCallOccupancyResult>((resolve) => { setTimeout(() => resolve(result), ms); });

let visibility: DocumentVisibilityState = "visible";
const setShown = (shown: boolean) => act(() => {
  visibility = shown ? "visible" : "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
});
let focused = true;
/** The window comes to the front, or goes behind another app's. */
const setFocused = (front: boolean) => act(() => {
  focused = front;
  window.dispatchEvent(new Event(front ? "focus" : "blur"));
});
/** Time goes on by `ms`, with every answer that comes meanwhile taken in. */
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function open(group = community()) {
  fakeEngine.update({ groups: [group] });
  return { group, ...renderApp(<GroupCallButton group={group} loadLivekit={loadLivekit} />) };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  refreshWindowAway();
});

afterEach(() => {
  endOtherCalls(Symbol("none"));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("asking whether a group's call is on", () => {
  it("asks once when the group opens, then every 15 s while the page is shown", async () => {
    answer(() => ({ ok: true, count: 0 }));
    const { group } = open();
    await elapse(0);
    expect(fakeEngine.callsTo("groupCallOccupancy")).toEqual([{ groupId: group.id }]);
    await elapse(OCCUPANCY_FLOOR_MS - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(3);
  });

  it("asks nothing while the page is hidden, and when it shows again asks at once, but never within 15 s of the last", async () => {
    answer(() => ({ ok: true, count: 0 }));
    open();
    await elapse(5_000);
    expect(asks()).toBe(1);
    setShown(false);
    await elapse(60_000);
    expect(asks()).toBe(1);
    // Shown again 65 s after the first ask: at once.
    setShown(true);
    await elapse(0);
    expect(asks()).toBe(2);
    // Hidden and shown again 7 s later: the next waits out the floor from the last ask.
    await elapse(5_000);
    setShown(false);
    await elapse(2_000);
    setShown(true);
    await elapse(OCCUPANCY_FLOOR_MS - 7_000 - 1);
    expect(asks()).toBe(2);
    await elapse(1);
    expect(asks()).toBe(3);
  });

  it("opened again within 15 s, asks no sooner, and shows the last answer at once", async () => {
    answer(() => ({ ok: true, count: 0 }));
    const group = community();
    const first = open(group);
    await elapse(0);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Start call");
    first.unmount();
    await elapse(4_000);
    open(group);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Start call");
    await elapse(OCCUPANCY_FLOOR_MS - 4_000 - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
  });

  it("with no answer, waits twice as long each time from 15 s up to 10 min, and back to 15 s once one comes", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 40].map(occupancyBackoffMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    expect(OCCUPANCY_BACKOFF_MAX_MS).toBe(600_000);
    // The node never answers (a node older than the route: its refused preflight reads as no answer at all).
    answer(() => ({ ok: false, code: "no_answer" }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    for (const [n, wait] of [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000].entries()) {
      await elapse(wait - 1);
      expect(asks(), `ask ${n + 2} not before ${wait} ms`).toBe(n + 1);
      await elapse(1);
      expect(asks(), `ask ${n + 2} after ${wait} ms`).toBe(n + 2);
    }
    // It answers at last: every 15 s again.
    answer(() => ({ ok: true, count: 2, since: 1_794_700_800 }));
    await elapse(600_000);
    expect(asks()).toBe(10);
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(11);
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(12);
    // No answer again: the backoff starts over at 15 s, then 30 s, not where it stood before the 200s.
    answer(() => ({ ok: false, code: "no_answer" }));
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(13);
    await elapse(15_000 - 1);
    expect(asks(), "the first no-answer after a 200 waits 15 s").toBe(13);
    await elapse(1);
    expect(asks()).toBe(14);
    await elapse(30_000 - 1);
    expect(asks(), "the second waits 30 s").toBe(14);
    await elapse(1);
    expect(asks()).toBe(15);
  });

  it("counts an engine that can't ask (an error) as no answer too", async () => {
    // Nothing answers `groupCallOccupancy`: the fake engine fails the call, as an engine error would.
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    await elapse(15_000);
    expect(asks()).toBe(2);
    await elapse(30_000 - 1);
    expect(asks()).toBe(2);
    await elapse(1);
    expect(asks()).toBe(3);
  });

  it("asks nothing while its window is in the background, and asks at once when it comes to the front", async () => {
    answer(() => ({ ok: true, count: 0 }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    setFocused(false);
    await elapse(60_000);
    expect(asks()).toBe(1);
    setFocused(true);
    await elapse(0);
    expect(asks()).toBe(2);
  });
});

describe("what the node's answer says of the next ask", () => {
  it("a 403 (a key banned from the call too): not known, and asked again every 15 s, never slower", async () => {
    answer(() => ({ ok: false, code: "refused" }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    for (const n of [2, 3, 4, 5, 6]) {
      await elapse(OCCUPANCY_FLOOR_MS - 1);
      expect(asks(), `ask ${n} not before 15 s`).toBe(n - 1);
      await elapse(1);
      expect(asks(), `ask ${n} after 15 s`).toBe(n);
    }
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("a reply that is no occupancy (a 500, a 200 of something else): the node answered, so every 15 s, never slower", async () => {
    answer(() => ({ ok: false, code: "bad_reply" }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    for (const n of [2, 3, 4, 5, 6]) {
      await elapse(OCCUPANCY_FLOOR_MS - 1);
      expect(asks(), `ask ${n} not before 15 s`).toBe(n - 1);
      await elapse(1);
      expect(asks(), `ask ${n} after 15 s`).toBe(n);
    }
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("a 404 or 405: the group's call changing on the same node (sealed now) asks again, as the engine forgets it too", async () => {
    answer(() => ({ ok: false, code: "unsupported" }));
    const group = community();
    const view = open(group);
    await elapse(0);
    await elapse(5 * 60_000);
    expect(asks()).toBe(1);
    answer(() => ({ ok: true, count: 0 }));
    const sealed = { ...group, call: { sfu: group.call!.sfu, e2ee: 1 } } as GroupView;
    view.rerender(<GroupCallButton group={sealed} loadLivekit={loadLivekit} />);
    await elapse(0);
    expect(asks()).toBe(2);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "off");
  });

  it("a 404 or 405: that node is not asked again, by any group, opened again or not, until the group's call names another node", async () => {
    answer(() => ({ ok: false, code: "unsupported" }));
    const group = community();
    const first = open(group);
    await elapse(0);
    expect(asks()).toBe(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    await elapse(30 * 60_000);
    expect(asks()).toBe(1);
    // Hidden and shown, closed and opened again: still nothing asked.
    setShown(false);
    setShown(true);
    first.unmount();
    await elapse(60_000);
    const again = open(group);
    await elapse(5 * 60_000);
    expect(asks()).toBe(1);
    // Another group on the same node: that node is not asked either.
    const other = open(community(group.call!.sfu));
    await elapse(60_000);
    expect(asks()).toBe(1);
    other.unmount();
    // The group's call names another node: asked at once, and every 15 s again.
    answer(() => ({ ok: true, count: 2, since: 1_794_700_800 }));
    const moved = { ...group, call: { sfu: "https://moved.ghostly.test" } } as GroupView;
    again.rerender(<GroupCallButton group={moved} loadLivekit={loadLivekit} />);
    await elapse(0);
    expect(fakeEngine.callsTo("groupCallOccupancy")).toEqual([{ groupId: group.id }, { groupId: group.id }]);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "on");
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(3);
  });

  it("a 429: waits 60 s when it says no Retry-After it can read (null), and its Retry-After when it does (15 s at least), however many came before", async () => {
    answer(() => ({ ok: false, code: "rate_limited", retryAfter: null }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    await elapse(60_000 - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
    answer(() => ({ ok: false, code: "rate_limited", retryAfter: 20 }));
    await elapse(60_000);
    expect(asks()).toBe(3);
    // Each one waits its own 20 s, not longer and longer.
    await elapse(20_000 - 1);
    expect(asks()).toBe(3);
    await elapse(1);
    expect(asks()).toBe(4);
    answer(() => ({ ok: false, code: "rate_limited", retryAfter: 5 }));
    await elapse(20_000);
    expect(asks()).toBe(5);
    await elapse(OCCUPANCY_FLOOR_MS - 1);
    expect(asks()).toBe(5);
    await elapse(1);
    expect(asks()).toBe(6);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("no answer: coming back to the group does not cut the wait short", async () => {
    answer(() => ({ ok: false, code: "no_answer" }));
    const group = community();
    const first = open(group);
    await elapse(0);
    await elapse(15_000);
    await elapse(30_000);
    expect(asks()).toBe(3);
    // The next is due 60 s after the third, at 105 s. Closed at 50 s, opened again at 70 s: it still waits.
    await elapse(5_000);
    first.unmount();
    await elapse(20_000);
    open(group);
    await elapse(0);
    expect(asks()).toBe(3);
    await elapse(35_000 - 1);
    expect(asks()).toBe(3);
    await elapse(1);
    expect(asks()).toBe(4);
  });

  it("a 429: coming back to the group, or the page shown again, does not cut its Retry-After short", async () => {
    answer(() => ({ ok: false, code: "rate_limited", retryAfter: 120 }));
    const group = community();
    const first = open(group);
    await elapse(10_000);
    first.unmount();
    await elapse(20_000);
    open(group);
    await elapse(0);
    expect(asks()).toBe(1);
    setShown(false);
    setShown(true);
    await elapse(0);
    expect(asks()).toBe(1);
    await elapse(90_000 - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
  });

  it("not a member (the engine says so and sends nothing): not known, and not asked again while the group is open", async () => {
    answer(() => ({ ok: false, code: "not_member" }));
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    await elapse(10 * 60_000);
    setShown(false);
    setShown(true);
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(1);
  });

  it("\"Hide my IP\" on (the engine says hidden and sends nothing): not known, and no group asked again until it is turned off", async () => {
    fakeEngine.update({ settings: { relayOnly: true } });
    answer(() => ({ ok: false, code: "hidden" }));
    const group = community();
    const first = open(group);
    await elapse(0);
    expect(asks()).toBe(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    await elapse(10 * 60_000);
    expect(asks()).toBe(1);
    // Hidden and shown, closed and opened again, another group: still nothing asked.
    setShown(false);
    setShown(true);
    first.unmount();
    const again = open(group);
    const other = open(community());
    await elapse(5 * 60_000);
    expect(asks()).toBe(1);
    other.unmount();
    // Turned off: asked at once, and every 15 s again.
    answer(() => ({ ok: true, count: 2, since: 1_794_700_800 }));
    act(() => fakeEngine.update({ settings: { relayOnly: false } }));
    await elapse(0);
    expect(asks()).toBe(2);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "on");
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(asks()).toBe(3);
    again.unmount();
  });
});

describe("an answer that comes while the group's window went away and back, or its call or \"Hide my IP\" changed", () => {
  it("the window went behind another and came back while asking: shown once it comes, not 15 s later", async () => {
    answer(late(2_000, { ok: true, count: 2, since: 1_794_700_800 }));
    open();
    await elapse(500);
    setFocused(false);
    await elapse(200);
    setFocused(true);
    await elapse(1_300 - 1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    await elapse(1);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "on");
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleDescription("2 in the call");
    // And asked no sooner for it: 15 s after that ask.
    expect(asks()).toBe(1);
    await elapse(OCCUPANCY_FLOOR_MS - 2_000 - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
  });

  it("\"Hide my IP\" turned on while asking: the answer is not shown", async () => {
    answer(late(2_000, { ok: true, count: 2, since: 1_794_700_800 }));
    open();
    await elapse(500);
    act(() => fakeEngine.update({ settings: { relayOnly: true } }));
    await elapse(2_000);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("the group's call changed while asking (sealed now): only the new call's answer is shown", async () => {
    let n = 0;
    answer(() => (++n === 1 ? late(2_000, { ok: true, count: 2, since: 1_794_700_800 })() : { ok: true, count: 0 }));
    const group = community();
    const view = open(group);
    await elapse(500);
    const sealed = { ...group, call: { sfu: group.call!.sfu, e2ee: 1 } } as GroupView;
    view.rerender(<GroupCallButton group={sealed} loadLivekit={loadLivekit} />);
    await elapse(0);
    expect(asks()).toBe(2);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "off");
    // The first call's answer comes after: not shown.
    await elapse(2_000);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "off");
  });

  it("the group's call names another node while it was closed: opened again, the old node's answer is not shown", async () => {
    answer(() => ({ ok: true, count: 2, since: 1_794_700_800 }));
    const group = community();
    const first = open(group);
    await elapse(0);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "on");
    first.unmount();
    await elapse(4_000);
    answer(late(1_000, { ok: true, count: 0 }));
    open({ ...group, call: { sfu: "https://moved.ghostly.test" } } as GroupView);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
    await elapse(1_000);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "off");
  });
});

describe("the group's call button, by what the node says", () => {
  it("not known: Join call as before, labelled, in the call's colour", async () => {
    answer(() => ({ ok: false, code: "unsupported" }));
    open();
    await elapse(0);
    const button = screen.getByTestId("group-call-join");
    expect(button).toHaveAttribute("data-call", "unknown");
    expect(button).toHaveAccessibleName("Join call");
    expect(button).toHaveTextContent("Join call");
    expect(button).toHaveClass("text-accent", "bg-accent/15");
    expect(button).not.toHaveAccessibleDescription(/in the call/);
  });

  it("nobody in the call: Start call, a plain phone with no label", async () => {
    answer(() => ({ ok: true, count: 0 }));
    open();
    await elapse(0);
    const button = screen.getByTestId("group-call-join");
    expect(button).toHaveAttribute("data-call", "off");
    expect(button).toHaveAccessibleName("Start call");
    expect(button).toHaveAttribute("title", "Start call");
    expect(button.textContent).toBe("");
    expect(button.querySelector("path")?.getAttribute("d")).toMatch(/^M22 16\.92/);
    expect(button).not.toHaveClass("text-accent");
    expect(button).not.toHaveClass("bg-accent/15");
    expect(button).toHaveClass("text-text-secondary", "max-md:min-h-[44px]", "max-md:min-w-[44px]");
  });

  it("someone in the call: Join call, labelled, in the call's colour, saying how many (never who)", async () => {
    answer(() => ({ ok: true, count: 3, since: 1_794_700_800 }));
    open();
    await elapse(0);
    const button = screen.getByTestId("group-call-join");
    expect(button).toHaveAttribute("data-call", "on");
    expect(button).toHaveAccessibleName("Join call");
    expect(button).toHaveTextContent("Join call");
    expect(button).toHaveClass("text-accent", "bg-accent/15");
    expect(button).toHaveAccessibleDescription("3 in the call");
    expect(button).toHaveAttribute("title", "3 in the call");
  });

  it("follows the call: Join call once someone starts it, Start call once the last leaves, Join call again with no answer", async () => {
    let now: GroupCallOccupancyResult = { ok: true, count: 0 };
    answer(() => now);
    open();
    await elapse(0);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Start call");
    now = { ok: true, count: 1, since: 1_794_700_800 };
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Join call");
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleDescription("1 in the call");
    now = { ok: true, count: 0 };
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(screen.getByTestId("group-call-join")).toHaveAccessibleName("Start call");
    now = { ok: false, code: "refused" };
    await elapse(OCCUPANCY_FLOOR_MS);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("in the call: the call's own button, as before, and nothing asked until I leave it", async () => {
    answer(() => ({ ok: true, count: 0 }));
    fakeEngine.on("groupCallToken", () => pass());
    open();
    await elapse(0);
    expect(asks()).toBe(1);
    // Start call starts it: the pass asked of the node and its room joined, as Join call does.
    fireEvent.click(screen.getByTestId("group-call-join"));
    await elapse(100);
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
    const button = screen.getByTestId("group-call-join");
    expect(button).toHaveAttribute("data-call", "joined");
    expect(button).toHaveAccessibleName("Join call");
    expect(button).toHaveClass("text-accent", "bg-accent/15");
    await elapse(5 * 60_000);
    expect(asks()).toBe(1);
    fireEvent.click(screen.getByTestId("group-call-leave"));
    await elapse(0);
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(asks()).toBe(2);
  });

  it("left within 15 s of the last answer: not the answer from before joining (nobody in it), Join call until the node says", async () => {
    answer(() => ({ ok: true, count: 0 }));
    fakeEngine.on("groupCallToken", () => pass());
    open();
    await elapse(0);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "off");
    fireEvent.click(screen.getByTestId("group-call-join"));
    await elapse(100);
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
    // Another member joined meanwhile, and stays when I leave 5 s later.
    answer(() => ({ ok: true, count: 1, since: 1_794_700_800 }));
    await elapse(5_000);
    fireEvent.click(screen.getByTestId("group-call-leave"));
    await elapse(0);
    expect(screen.queryByTestId("group-call")).toBeNull();
    const button = screen.getByTestId("group-call-join");
    expect(button).toHaveAttribute("data-call", "unknown");
    expect(button).toHaveAccessibleName("Join call");
    // Asked once the floor from the last ask is out: then it says who is in it.
    await elapse(OCCUPANCY_FLOOR_MS - 5_100);
    expect(asks()).toBe(2);
    expect(button).toHaveAttribute("data-call", "on");
  });

  it("closed in the call and opened again within 15 s: not the answer from before joining either", async () => {
    answer(() => ({ ok: true, count: 0 }));
    fakeEngine.on("groupCallToken", () => pass());
    const group = community();
    const first = open(group);
    await elapse(0);
    fireEvent.click(screen.getByTestId("group-call-join"));
    await elapse(100);
    expect(screen.getByTestId("group-call")).toBeInTheDocument();
    first.unmount();
    answer(() => ({ ok: true, count: 1, since: 1_794_700_800 }));
    await elapse(3_000);
    open(group);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("an answer from before joining that comes in the call: not shown once I leave", async () => {
    answer(late(2_000, { ok: true, count: 0 }));
    fakeEngine.on("groupCallToken", () => pass());
    open();
    await elapse(0);
    fireEvent.click(screen.getByTestId("group-call-join"));
    await elapse(100);
    await elapse(2_000);
    answer(() => ({ ok: true, count: 1, since: 1_794_700_800 }));
    fireEvent.click(screen.getByTestId("group-call-leave"));
    await elapse(0);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });

  it("an answer from before joining that comes in the call, closed and opened again within 15 s: not shown either", async () => {
    answer(late(2_000, { ok: true, count: 0 }));
    fakeEngine.on("groupCallToken", () => pass());
    const group = community();
    const first = open(group);
    await elapse(0);
    fireEvent.click(screen.getByTestId("group-call-join"));
    await elapse(100);
    first.unmount();
    answer(() => ({ ok: true, count: 1, since: 1_794_700_800 }));
    await elapse(3_000);
    open(group);
    expect(screen.getByTestId("group-call-join")).toHaveAttribute("data-call", "unknown");
  });
});
