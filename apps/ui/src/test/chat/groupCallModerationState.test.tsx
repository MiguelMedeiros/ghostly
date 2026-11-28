import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
import type { GroupCallModerator } from "../../hooks/useCallModeration";
import type { GroupCallModeration, GroupCallModerationResult, GroupCallRoomState } from "../../lib/groupCallModeration";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * The admin's read of the room's state (WISP 602 § Moderation) when it does nothing: a 429 is asked again after its
 * Retry-After, no answer on the floor-and-doubling backoff of § Occupancy's client rule, until a state comes (by the
 * read or by an act's reply), and never after the call's window goes or the admin's role does. Meanwhile the menu goes
 * by what the tiles know. Each act that did nothing says why in its own words.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<object>(), invoke: vi.fn(async () => undefined) }));

const ANA = "ana".padEnd(52, "a"), BO = "bo".padEnd(52, "b");
const EMPTY: GroupCallRoomState = { muted: {}, banned: [] };
/** The room as the node holds it: Ana's mic taken, Bo removed. */
const ROOM: GroupCallRoomState = { muted: { [ANA]: ["microphone"] }, banned: [BO] };

const answerModerate = (handler: (params: GroupCallModeration) => GroupCallModerationResult | Promise<GroupCallModerationResult>) =>
  (fakeEngine as unknown as { on(method: string, h: typeof handler): void }).on("groupCallModerate", handler);
const moderateAsks = () => fakeEngine.calls.filter((c) => (c.method as string) === "groupCallModerate").map((c) => c.params as GroupCallModeration);
const stateReads = () => moderateAsks().filter((ask) => ask.act === "state").length;

function person(identity: string, name: string, extra: Partial<GroupCallParticipant> = {}): GroupCallParticipant {
  return { identity, name, mic: true, camera: false, screen: false, speaking: false, tracks: {}, ...extra };
}
const call: GroupCallState = { local: person("me".padEnd(52, "m"), "Me"), participants: [person(ANA, "Ana")], activeSpeaker: null };
const ADMIN: GroupCallModerator = { groupId: "group-1", inGroup: () => true };

function adminView(shown: GroupCallState = call) {
  const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
  const draw = (moderator: GroupCallModerator | undefined) => <GroupCallView call={shown} groupName="Club" {...handlers} nameOf={(id) => (id === BO ? "Bo" : id)} moderator={moderator} />;
  const result = renderApp(draw(ADMIN));
  return { ...result, redrawAs: (moderator: GroupCallModerator | undefined) => result.rerender(draw(moderator)) };
}
/** Time goes on by `ms`, with every answer that comes meanwhile taken in. */
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const tileOf = (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
/** Ana's mic row in her tile's menu, as the menu offers it now. */
function micRow(identity = ANA) {
  fireEvent.click(within(tileOf(identity)).getByTestId("group-call-moderate"));
  const row = screen.queryByTestId("group-call-allow-microphone") ? "Allow mic" : screen.queryByTestId("group-call-mute-microphone") ? "Mute mic" : "none";
  fireEvent.click(within(tileOf(identity)).getByTestId("group-call-moderate"));
  return row;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  localStorage.removeItem("ghostly_group_call_mini");
  vi.useRealTimers();
});

describe("the admin's read of the room's state", () => {
  it("asks again after a 429's Retry-After, and the Removed list and Allow mic show then", async () => {
    let n = 0;
    answerModerate(({ act }) => (act === "state" && ++n === 1 ? { ok: false, code: "rate_limited", retryAfter: 30 } : { ok: true, state: ROOM }));
    adminView();
    await elapse(0);
    // A retry before the node's wait is over only spends the key's limit again.
    expect(stateReads()).toBe(1);
    await elapse(29_000);
    expect(stateReads()).toBe(1);
    expect(screen.queryByTestId("group-call-removed")).toBeNull();
    await elapse(1_000);
    expect(stateReads()).toBe(2);
    expect(screen.getByTestId("group-call-removed")).toHaveTextContent("Removed (1)");
    expect(micRow()).toBe("Allow mic");
    // A state came: nothing more is asked.
    await elapse(30 * 60_000);
    expect(stateReads()).toBe(2);
  });

  it("waits a minute after a 429 that says no time", async () => {
    let n = 0;
    answerModerate(({ act }) => (act === "state" && ++n === 1 ? { ok: false, code: "rate_limited" } : { ok: true, state: ROOM }));
    adminView();
    await elapse(59_000);
    expect(stateReads()).toBe(1);
    await elapse(1_000);
    expect(stateReads()).toBe(2);
    expect(screen.getByTestId("group-call-removed")).toBeInTheDocument();
  });

  it("asks again after no answer on a backoff: 15 s, then twice as long each time, ten minutes at most", async () => {
    let fail = true;
    answerModerate(({ act }) => (act === "state" && fail ? { ok: false, code: "unreachable" } : { ok: true, state: ROOM }));
    adminView();
    await elapse(0);
    expect(stateReads()).toBe(1);
    const reads: number[] = [];
    for (const wait of [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      await elapse(wait - 1);
      reads.push(stateReads());
      await elapse(1);
      reads.push(stateReads());
    }
    // Each ask comes exactly when its wait is over, not a moment before.
    expect(reads).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9]);
    fail = false;
    await elapse(600_000);
    expect(stateReads()).toBe(10);
    expect(screen.getByTestId("group-call-removed")).toBeInTheDocument();
    await elapse(30 * 60_000);
    expect(stateReads()).toBe(10);
  });

  it("asks nothing more once the call's window is gone", async () => {
    answerModerate(({ act }) => (act === "state" ? { ok: false, code: "unreachable" } : { ok: true, state: EMPTY }));
    const { unmount } = adminView();
    await elapse(0);
    expect(stateReads()).toBe(1);
    unmount();
    await elapse(30 * 60_000);
    expect(stateReads()).toBe(1);
  });

  it("asks nothing more once the role of admin is gone", async () => {
    answerModerate(({ act }) => (act === "state" ? { ok: false, code: "rate_limited", retryAfter: 30 } : { ok: true, state: EMPTY }));
    const { redrawAs } = adminView();
    await elapse(0);
    redrawAs(undefined);
    await elapse(30 * 60_000);
    expect(stateReads()).toBe(1);
  });

  it("asks nothing more after an act's reply, which carries the room's whole state", async () => {
    answerModerate(({ act }) => (act === "state" ? { ok: false, code: "rate_limited", retryAfter: 30 } : { ok: true, state: ROOM }));
    adminView();
    await elapse(0);
    fireEvent.click(within(tileOf(ANA)).getByTestId("group-call-moderate"));
    fireEvent.click(screen.getByTestId("group-call-mute-camera"));
    await elapse(0);
    expect(screen.getByTestId("group-call-removed")).toBeInTheDocument();
    await elapse(30 * 60_000);
    expect(stateReads()).toBe(1);
  });

  it("is not asked again when the node has no route or refuses the admin", async () => {
    for (const code of ["unsupported", "refused", "not_admin"] as const) {
      fakeEngine.calls.length = 0;
      answerModerate(() => ({ ok: false, code }));
      const { unmount } = adminView();
      await elapse(30 * 60_000);
      expect(stateReads(), code).toBe(1);
      unmount();
    }
  });

  it("until the node answers, the menu goes by what the tile knows: Allow mic for a mic the admin took", async () => {
    answerModerate(() => ({ ok: false, code: "unreachable" }));
    adminView({ ...call, participants: [person(ANA, "Ana", { mic: false, camera: false, byAdmin: { mic: true, camera: false, screen: false } })] });
    await elapse(0);
    expect(micRow()).toBe("Allow mic");
    fireEvent.click(within(tileOf(ANA)).getByTestId("group-call-moderate"));
    expect(screen.getByTestId("group-call-mute-camera")).toHaveTextContent("Stop camera");
  });
});

describe("an act that did nothing says why", () => {
  const said = async (answer: () => GroupCallModerationResult) => {
    answerModerate(({ act }) => (act === "state" ? { ok: true, state: EMPTY } : answer()));
    const { unmount } = adminView({ ...call, participants: [person("EG_recorder", "recorder"), person(ANA, "Ana")] });
    await elapse(0);
    fireEvent.click(within(tileOf("EG_recorder")).getByTestId("group-call-moderate"));
    fireEvent.click(screen.getByTestId("group-call-mute-microphone"));
    await elapse(0);
    const line = screen.getByTestId("group-call-moderation-error").textContent;
    unmount();
    return line;
  };

  it("on a tile whose identity is not a member's key: only members can be moderated, not an unreachable node", async () => {
    expect(await said(() => { throw new Error("target must be the key of another member"); })).toBe("Only members of the group can be moderated");
  });

  it("each code in its own words: not the admin, refused, too many, no answer, the engine gone", async () => {
    expect(await said(() => ({ ok: false, code: "not_admin" }))).toBe("Only the admin can do that");
    expect(await said(() => ({ ok: false, code: "refused" }))).toBe("The call's node didn't accept this");
    expect(await said(() => ({ ok: false, code: "rate_limited", retryAfter: 30 }))).toBe("Too many changes at once. Try again in a minute.");
    expect(await said(() => ({ ok: false, code: "unreachable" }))).toBe("Couldn't reach the call's node");
    expect(await said(() => { throw new Error("engine gone"); })).toBe("Couldn't reach the call's node");
  });
});
