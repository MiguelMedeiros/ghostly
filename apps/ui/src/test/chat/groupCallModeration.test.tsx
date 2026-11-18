import "fake-indexeddb/auto";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endOtherCalls } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { GroupCallButton } from "../../components/GroupCallButton";
import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
import type { LivekitModule } from "../../hooks/useGroupCall";
import type { GroupCallModeration, GroupCallModerationResult, GroupCallRoomState } from "../../lib/groupCallModeration";
import { axeViolations } from "../axe";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.group

/**
 * The group's admin moderates its call from each other member's tile (WISP 602 § Moderation): the menu is the admin's
 * alone and never on its own tile, each row sends the engine's `groupCallModerate` with its act and sources, the two
 * removes ask first and say what they do to the call's key, a removed member is let back in from the call's top, and a
 * node without the route says so.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<object>(), invoke: vi.fn(async () => undefined) }));

const ANA = "ana".padEnd(52, "a"), BO = "bo".padEnd(52, "b");
const EMPTY: GroupCallRoomState = { muted: {}, banned: [] };

/** The engine's `groupCallModerate`, not in `EngineApi` until the engine's slice lands. */
const answerModerate = (handler: (params: GroupCallModeration) => GroupCallModerationResult | Promise<GroupCallModerationResult>) =>
  (fakeEngine as unknown as { on(method: string, h: typeof handler): void }).on("groupCallModerate", handler);
const moderateAsks = () => fakeEngine.calls.filter((c) => (c.method as string) === "groupCallModerate").map((c) => c.params as GroupCallModeration);
const acts = () => moderateAsks().filter((ask) => ask.act !== "state");

function person(identity: string, name: string): GroupCallParticipant {
  return { identity, name, mic: true, camera: false, screen: false, speaking: false, tracks: {} };
}
const call: GroupCallState = { local: person("me".padEnd(52, "m"), "Me"), participants: [person(ANA, "Ana"), person(BO, "Bo")], activeSpeaker: null };
const names: Record<string, string> = { [ANA]: "Ana", [BO]: "Bo" };

function adminView({ inGroup = () => true }: { inGroup?: (identity: string) => boolean } = {}) {
  const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
  return renderApp(<GroupCallView call={call} groupName="Club" {...handlers} nameOf={(id) => names[id] ?? id} moderator={{ groupId: "group-1", inGroup }} />);
}
const tileOf = (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
const menuButton = (identity: string) => within(tileOf(identity)).getByTestId("group-call-moderate");

afterEach(() => {
  localStorage.removeItem("ghostly_group_call_mini");
  FakeRoom.others = [];
  endOtherCalls(Symbol("none"));
});

describe("the admin's menu on a member's tile", () => {
  it("is on each other member's tile, named for them, and never on the admin's own", () => {
    answerModerate(() => ({ ok: true, state: EMPTY }));
    adminView();
    // The name keeps its own direction in the label and its tooltip ("Bob!" in Arabic keeps its "!").
    expect(menuButton(ANA)).toHaveAccessibleName("Moderate \u2068Ana\u2069");
    expect(menuButton(ANA)).toHaveAttribute("title", "Moderate \u2068Ana\u2069");
    expect(menuButton(BO)).toHaveAccessibleName("Moderate \u2068Bo\u2069");
    expect(within(tileOf(call.local.identity)).queryByTestId("group-call-moderate")).toBeNull();
  });

  it("reads the room's state once in, and each row sends its act and sources", async () => {
    answerModerate(({ act, target, src }) => ({ ok: true, state: act === "mute" ? { muted: { [target!]: src! }, banned: [] } : EMPTY }));
    const { user } = adminView();
    await waitFor(() => expect(moderateAsks()).toEqual([{ groupId: "group-1", act: "state" }]));
    for (const [row, src] of [["group-call-mute-microphone", "microphone"], ["group-call-mute-camera", "camera"], ["group-call-mute-screen_share", "screen_share"]] as const) {
      await user.click(menuButton(ANA));
      await user.click(screen.getByTestId(row));
      await waitFor(() => expect(acts()[acts().length - 1]).toEqual({ groupId: "group-1", act: "mute", target: ANA, src: [src] }));
    }
  });

  it("offers Allow for a source the admin took, as the node's state says, and sends allow", async () => {
    answerModerate(({ act }) => ({ ok: true, state: act === "state" ? { muted: { [ANA]: ["camera", "microphone"] }, banned: [] } : EMPTY }));
    const { user } = adminView();
    await user.click(menuButton(ANA));
    expect(await screen.findByTestId("group-call-allow-microphone")).toHaveTextContent("Allow mic");
    expect(screen.getByTestId("group-call-allow-camera")).toHaveTextContent("Allow camera");
    expect(screen.getByTestId("group-call-mute-screen_share")).toHaveTextContent("Stop screen");
    await user.click(screen.getByTestId("group-call-allow-microphone"));
    await waitFor(() => expect(acts()).toEqual([{ groupId: "group-1", act: "allow", target: ANA, src: ["microphone"] }]));
    // The reply is the state after it: Mute mic again.
    await user.click(menuButton(ANA));
    expect(screen.getByTestId("group-call-mute-microphone")).toHaveTextContent("Mute mic");
  });

  it("keeps the state after the admin's last act when an earlier ask answers after it", async () => {
    // The read sent on joining answers late, after a mute made meanwhile: its state is from before the mute.
    let readLate: (result: GroupCallModerationResult) => void = () => {};
    answerModerate(({ act, target, src }) => act === "state"
      ? new Promise<GroupCallModerationResult>((resolve) => { readLate = resolve; })
      : { ok: true, state: { muted: { [target!]: src! }, banned: [] } });
    const { user } = adminView();
    await user.click(menuButton(ANA));
    await user.click(screen.getByTestId("group-call-mute-microphone"));
    await waitFor(() => expect(acts()).toHaveLength(1));
    await act(async () => readLate({ ok: true, state: EMPTY }));
    await user.click(menuButton(ANA));
    expect(screen.getByTestId("group-call-allow-microphone")).toHaveTextContent("Allow mic");
  });

  it("asks before removing from the call, saying behind the ⓘ that the call's key stays; Cancel sends nothing", async () => {
    answerModerate(({ act, target }) => ({ ok: true, state: act === "remove" ? { muted: {}, banned: [target!] } : EMPTY }));
    const { user } = adminView();
    await user.click(menuButton(BO));
    await user.click(screen.getByTestId("group-call-remove-from-call"));
    const ask = screen.getByTestId("group-call-remove-call-dialog");
    expect(ask).toHaveAccessibleName("Remove Bo from the call?");
    expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(ask).getByTestId("group-call-remove-call-info"));
    expect(within(ask).getByTestId("group-call-remove-call-info-text")).toHaveTextContent("This doesn't change the call's key, so they keep the current one.");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(acts()).toEqual([]);
    expect(menuButton(BO)).toHaveFocus();
    await user.click(menuButton(BO));
    await user.click(screen.getByTestId("group-call-remove-from-call"));
    await user.click(screen.getByTestId("group-call-remove-call-confirm"));
    await waitFor(() => expect(acts()).toEqual([{ groupId: "group-1", act: "remove", target: BO }]));
    // The focus is back on the tile's menu button after the confirmation.
    expect(menuButton(BO)).toHaveFocus();
  });

  it("lets a removed member back in from the call's top, which sends unban", async () => {
    answerModerate(({ act }) => ({ ok: true, state: act === "state" ? { muted: {}, banned: [BO] } : EMPTY }));
    const { user } = adminView();
    await user.click(await screen.findByTestId("group-call-removed"));
    expect(screen.getByTestId("group-call-removed")).toHaveTextContent("Removed (1)");
    await user.click(screen.getByRole("button", { name: "Let Bo back in" }));
    await waitFor(() => expect(acts()).toEqual([{ groupId: "group-1", act: "unban", target: BO }]));
    await waitFor(() => expect(screen.queryByTestId("group-call-removed")).toBeNull());
  });

  it("asks before removing from the group, saying behind the ⓘ that the group gets a new key, and uses the group's remove", async () => {
    answerModerate(() => ({ ok: true, state: EMPTY }));
    fakeEngine.on("removeGroupMember", () => undefined);
    const { user } = adminView();
    await user.click(menuButton(ANA));
    await user.click(screen.getByTestId("group-call-remove-from-group"));
    const ask = screen.getByTestId("group-call-remove-group-dialog");
    expect(ask).toHaveAccessibleName("Remove Ana from the group?");
    await user.click(within(ask).getByTestId("group-call-remove-group-info"));
    expect(within(ask).getByTestId("group-call-remove-group-info-text")).toHaveTextContent("The group gets a new key");
    await user.click(screen.getByTestId("group-call-remove-group-confirm"));
    await waitFor(() => expect(fakeEngine.callsTo("removeGroupMember")).toEqual([{ groupId: "group-1", key: ANA }]));
    expect(acts()).toEqual([]);
    expect(menuButton(ANA)).toHaveFocus();
  });

  it("offers no Remove from group for someone outside the group", async () => {
    answerModerate(() => ({ ok: true, state: EMPTY }));
    const { user } = adminView({ inGroup: (id) => id !== BO });
    await user.click(menuButton(BO));
    expect(screen.getByTestId("group-call-remove-from-call")).toBeInTheDocument();
    expect(screen.queryByTestId("group-call-remove-from-group")).toBeNull();
  });

  it("says a node without the route can't moderate yet", async () => {
    answerModerate(({ act }) => (act === "state" ? { ok: true, state: EMPTY } : { ok: false, code: "unsupported" }));
    const { user } = adminView();
    await user.click(menuButton(ANA));
    await user.click(screen.getByTestId("group-call-mute-microphone"));
    expect(await screen.findByTestId("group-call-moderation-error")).toHaveTextContent("This call's node can't moderate yet");
    expect(screen.getByTestId("group-call-moderation-error")).toHaveAttribute("role", "alert");
  });

  it("works from the keyboard: Escape and Tab out of the menu go back to its button", async () => {
    answerModerate(() => ({ ok: true, state: EMPTY }));
    const { user } = adminView();
    menuButton(ANA).focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByTestId("group-call-moderate-menu");
    expect(within(menu).getByTestId("group-call-mute-microphone")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("group-call-moderate-menu")).toBeNull();
    expect(menuButton(ANA)).toHaveFocus();
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "false");
    await user.keyboard("{Enter}");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.queryByTestId("group-call-moderate-menu")).toBeNull();
    expect(menuButton(ANA)).toHaveFocus();
  });

  it("passes axe with the menu open inside the call's window and a removed member listed", async () => {
    answerModerate(() => ({ ok: true, state: { muted: {}, banned: [BO] } }));
    const { user } = adminView();
    await screen.findByTestId("group-call-removed");
    await user.click(menuButton(ANA));
    expect(screen.getByTestId("group-call")).toContainElement(screen.getByTestId("group-call-moderate-menu"));
    expect(await axeViolations(screen.getByTestId("group-call"))).toEqual([]);
  });

  it("puts a member's name in its own <bdi> in the remove headings and in Let back in: a Latin name keeps its punctuation in Arabic", async () => {
    answerModerate(({ act }) => ({ ok: true, state: act === "state" ? { muted: {}, banned: [BO] } : EMPTY }));
    const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].some((bdi) => bdi.textContent === name);
    const { user } = adminView();
    await user.click(menuButton(ANA));
    await user.click(screen.getByTestId("group-call-remove-from-call"));
    const heading = within(screen.getByTestId("group-call-remove-call-dialog")).getByRole("heading");
    expect(heading).toHaveTextContent("Remove Ana from the call?");
    expect(isolated(heading, "Ana")).toBe(true);
    await user.click(within(screen.getByTestId("group-call-remove-call-dialog")).getByRole("button", { name: "Cancel" }));
    await user.click(menuButton(ANA));
    await user.click(screen.getByTestId("group-call-remove-from-group"));
    expect(isolated(within(screen.getByTestId("group-call-remove-group-dialog")).getByRole("heading"), "Ana")).toBe(true);
    await user.click(within(screen.getByTestId("group-call-remove-group-dialog")).getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByTestId("group-call-removed"));
    const row = screen.getByRole("button", { name: "Let Bo back in" });
    expect(isolated(row, "Bo")).toBe(true);
  });

  it("is not in the small window", async () => {
    answerModerate(() => ({ ok: true, state: EMPTY }));
    localStorage.setItem("ghostly_group_call_mini", "1");
    adminView();
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "true");
    expect(screen.queryByTestId("group-call-moderate")).toBeNull();
  });
});

/** Joined through Join call on a fake LiveKit: the admin gets the menu, a member does not. */
class FakeRoom {
  static others: { identity: string; name: string }[] = [];
  readonly remoteParticipants = new Map(FakeRoom.others.map((p) => [p.identity, {
    ...p, isMicrophoneEnabled: true, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false, getTrackPublication: () => undefined,
  }]));
  readonly activeSpeakers = [];
  private readonly listeners = new Map<string, () => void>();
  readonly localParticipant = {
    identity: ME, name: "Me", isMicrophoneEnabled: false, isCameraEnabled: false, isScreenShareEnabled: false, isSpeaking: false,
    trackPublications: new Map(), getTrackPublication: () => undefined, setMicrophoneEnabled: vi.fn(async () => {}),
  };
  readonly connect = vi.fn(async () => {});
  readonly disconnect = vi.fn(async () => this.listeners.get("disconnected")?.());
  on(event: string, listener: () => void) { this.listeners.set(event, listener); return this; }
}
const ME = "me".padEnd(52, "y");
const RoomEvent = new Proxy({}, { get: (_, name) => (name === "Disconnected" ? "disconnected" : String(name)) });
const loadLivekit = async () => ({ Room: FakeRoom, RoomEvent, Track: { Source: {} } }) as unknown as LivekitModule;

describe("Join call, as the admin or a member", () => {
  const members = [{ key: ME, role: "member" as const, me: true, online: true, missing: 0 }, { key: ANA, role: "member" as const, me: false, online: true, missing: 0, nick: "Ana" }];
  const group = (isAdmin: boolean) =>
    ({ ...groupView({ profile: "community", status: "active", epoch: 1, name: "Club", isAdmin, members }), call: { sfu: "https://sfu.ghostly.test" } }) as unknown as GroupView;
  const join = async (isAdmin: boolean) => {
    FakeRoom.others = [{ identity: ANA, name: "Ana" }];
    (fakeEngine as unknown as { on(method: string, h: () => unknown): void }).on("groupCallToken", () => ({ url: "wss://sfu.ghostly.test", token: "pass-1", room: "g_group-1", identity: ME, expiresIn: 600 }));
    answerModerate(() => ({ ok: true, state: EMPTY }));
    fakeEngine.update({ groups: [group(isAdmin)] });
    const { user } = renderApp(<GroupCallButton group={group(isAdmin)} loadLivekit={loadLivekit} />);
    await user.click(screen.getByTestId("group-call-join"));
    await waitFor(() => expect(screen.getAllByTestId("group-call-tile")).toHaveLength(2));
  };

  it("the admin has the menu on the member's tile", async () => {
    await join(true);
    expect(menuButton(ANA)).toBeInTheDocument();
    expect(within(tileOf(ME)).queryByTestId("group-call-moderate")).toBeNull();
  });

  it("a member sees no menu and asks the node nothing", async () => {
    await join(false);
    expect(screen.queryByTestId("group-call-moderate")).toBeNull();
    await act(async () => {});
    expect(moderateAsks()).toEqual([]);
  });
});
