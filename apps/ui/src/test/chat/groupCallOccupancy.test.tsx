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
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * Whether a group's call is on, before joining it (WISP 602 § Occupancy): the header asks the engine
 * (`groupCallOccupancy`) when the group opens and every 15 s while the page is shown, never while it is hidden or
 * more often than that, and less and less often while no answer comes (up to 10 min). Join call, labelled in the
 * call's colour, only while someone is in the call; Start call, a plain phone, while nobody is; Join call as before
 * while that is not known; and in the call, the call's own button, with nothing asked.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y");
let groups = 0;
/** A community with a call node, under an id of its own: each test's group was never asked about on this page. */
const community = () =>
  ({ ...groupView({ id: `occupancy-${++groups}`, profile: "community", status: "active", epoch: 1, name: "Club", members: [{ key: ME, role: "member", me: true, online: true, missing: 0 }] }), call: { sfu: "https://sfu.ghostly.test" } }) as GroupView;

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
const answer = (handler: () => GroupCallOccupancyResult) => fakeEngine.on("groupCallOccupancy", handler);
const asks = () => fakeEngine.callsTo("groupCallOccupancy").length;

let visibility: DocumentVisibilityState = "visible";
const setShown = (shown: boolean) => act(() => {
  visibility = shown ? "visible" : "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
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
    answer(() => ({ ok: false, code: "unreachable" }));
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

  it("waits out a 429's Retry-After when it is longer than the wait it would take", async () => {
    answer(() => ({ ok: false, code: "rate_limited", retryAfter: 90 }));
    open();
    await elapse(0);
    await elapse(90_000 - 1);
    expect(asks()).toBe(1);
    await elapse(1);
    expect(asks()).toBe(2);
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
});
