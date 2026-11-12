import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { groupChat, mentionsNotify, mutedFor, setChatMute, setMentionsNotify } from "../../lib/chatMute";
import { markGroupRead } from "../../lib/groups";
import { loadSettings, saveSettings } from "../../lib/settings";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: groups.mentions, groups.mentions.notify

const sound = vi.hoisted(() => ({ playSound: vi.fn((_name: string) => () => {}), notice: vi.fn(async (_id: string, _body: string) => {}) }));
vi.mock("../../lib/sounds", () => ({ playSound: sound.playSound, startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("../../lib/notifications", () => ({ showPrivateNotification: sound.notice, onNotificationOpen: () => () => {}, clearChatNotification: () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), BOB2 = "bobtwo".padEnd(52, "k");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const members = [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" })];
const active = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, members, ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

afterEach(() => {
  vi.restoreAllMocks();
  sound.playSound.mockClear();
  sound.notice.mockClear();
});

function openGroup(group: GroupView, history: StoredMessage[] = []) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }));
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const composer = () => screen.getByRole("textbox");
const options = () => within(screen.getByTestId("mention-picker")).getAllByRole("option");
const selected = () => options().find(o => o.getAttribute("aria-selected") === "true");

describe("the composer's @", () => {
  it("opens the members, filters them as I type, and a choice binds the member's key", async () => {
    const { user, engine } = openGroup(active());
    await user.type(composer(), "@");
    expect(options().map(o => o.textContent)).toEqual(["Alice…" + ALICE.slice(-6), "Bob…" + BOB.slice(-6)]);
    // Never me.
    expect(options().map(o => o.dataset.key)).not.toContain(ME);
    await user.type(composer(), "b");
    expect(options().map(o => o.dataset.key)).toEqual([BOB]);
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("mention-picker")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("@Bob ");
    await user.type(composer(), "dinner?{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "@Bob dinner?", mentions: [{ k: BOB, o: 0, l: 4 }] }]);
  });

  it("moves with the arrows, wrapping, and Tab chooses too; the field keeps the focus", async () => {
    const { user } = openGroup(active());
    await user.type(composer(), "hi @");
    expect(composer()).toHaveAttribute("aria-activedescendant", selected()!.id);
    expect(selected()!.dataset.key).toBe(ALICE);
    await user.keyboard("{ArrowDown}");
    expect(selected()!.dataset.key).toBe(BOB);
    await user.keyboard("{ArrowDown}");
    expect(selected()!.dataset.key).toBe(ALICE);
    await user.keyboard("{ArrowUp}");
    expect(selected()!.dataset.key).toBe(BOB);
    expect(composer()).toHaveAttribute("aria-activedescendant", selected()!.id);
    await user.keyboard("{Tab}");
    expect(composer()).toHaveValue("hi @Bob ");
    expect(composer()).toHaveFocus();
  });

  it("outlines the member the arrows are on in forced colors, where its background is gone, and no other", async () => {
    const { user } = openGroup(active());
    await user.type(composer(), "@");
    await user.keyboard("{ArrowDown}");
    expect(options().map(o => o.classList.contains("forced-colors:outline-[color:Highlight]"))).toEqual([false, true]);
  });

  it("gives each member a 44 px row on a phone, and the desktop keeps its rows", async () => {
    const { user } = openGroup(active());
    await user.type(composer(), "@");
    for (const option of options()) {
      expect(option).toHaveClass("py-2", "max-md:min-h-11", "max-md:py-3");
      expect(option).not.toHaveClass("min-h-11");
    }
  });

  it("Escape closes it for that @, and Enter then sends what is there, with no mention", async () => {
    const { user, engine } = openGroup(active());
    await user.type(composer(), "mail me @al");
    expect(screen.getByTestId("mention-picker")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("mention-picker")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "mail me @al" }]);
  });

  it("chooses with a click, and a token edited away is no mention", async () => {
    const { user, engine } = openGroup(active());
    await user.type(composer(), "@");
    await user.click(options()[0]);
    expect(composer()).toHaveValue("@Alice ");
    expect(composer()).toHaveFocus();
    await user.keyboard("{Backspace}{Backspace}{Backspace}!{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "@Ali!" }]);
  });

  it("does not open inside a word, as in an address", async () => {
    const { user } = openGroup(active());
    await user.type(composer(), "me@b");
    expect(screen.queryByTestId("mention-picker")).not.toBeInTheDocument();
  });

  it("reads a member's key end left to right in every language: in Arabic the \"…\" stays before it", async () => {
    const { user } = openGroup(active());
    await user.type(composer(), "@b");
    expect(within(options()[0]).getByText("…" + BOB.slice(-6))).toHaveAttribute("dir", "ltr");
    // The name in its own: a Latin one cut in Arabic keeps its start.
    expect(within(options()[0]).getByText("Bob")).toHaveAttribute("dir", "auto");
  });

  it("tells two members of one name apart by key", async () => {
    const { user, engine } = openGroup(active({ members: [...members, member({ key: BOB2, nick: "Bob" })] }));
    await user.type(composer(), "@bob");
    expect(options().map(o => o.textContent)).toEqual(["Bob…" + BOB.slice(-6), "Bob…" + BOB2.slice(-6)]);
    await user.keyboard("{ArrowDown}{Enter}");
    await user.keyboard("hi{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "@Bob hi", mentions: [{ k: BOB2, o: 0, l: 4 }] }]);
  });

  // The second Bob picked was bound to the first: never named, no sound, no notification (agents#1046).
  it("names each of two members of one name where they were picked, whatever is typed around them", async () => {
    const { user, engine } = openGroup(active({ members: [...members, member({ key: BOB2, nick: "Bob" })] }));
    await user.type(composer(), "@bob");
    await user.keyboard("{Enter}");
    await user.type(composer(), "and @bob");
    await user.keyboard("{ArrowDown}{Enter}");
    // Words typed before both of them move them along.
    await user.type(composer(), "dinner?");
    await user.keyboard("{Home}");
    await user.type(composer(), "Hi ", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    await user.keyboard("{End}{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "Hi @Bob and @Bob dinner?", mentions: [{ k: BOB, o: 3, l: 4 }, { k: BOB2, o: 12, l: 4 }] }]);
  });

  // Editing, the other Bob picked took every "@Bob" of the message, the one it already named too (agents#1046).
  it("while editing, names the member picked at the place picked only", async () => {
    const mine = stored({ id: `${ME}:1:3`, sender: "me", member: ME, text: "@Bob hi", mentions: [{ k: BOB, o: 0, l: 4 }] });
    const { user, engine } = openGroup(active({ members: [...members, member({ key: BOB2, nick: "Bob" })] }), [mine]);
    fakeEngine.on("editMessage", () => ({ error: null }));
    await screen.findByText("hi", { exact: false });
    await user.click(composer());
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(composer()).toHaveValue("@Bob hi"));
    await user.type(composer(), " @bob");
    await user.keyboard("{ArrowDown}{Enter}");
    await user.keyboard("{Enter}");
    // Only the new place is added; the engine carries the first one, still bound to the first Bob (carryMentions).
    expect(engine.callsTo("editMessage")).toEqual([{ linkId: "group:group-1", messageId: `${ME}:1:3`, text: "@Bob hi @Bob ", mentions: [{ k: BOB2, o: 8, l: 4 }] }]);
  });

  it("offers @everyone to a private group's admin only, never in a community", async () => {
    const first = openGroup(active({ isAdmin: true }));
    await first.user.type(composer(), "@ev");
    expect(options().map(o => o.dataset.key)).toEqual(["*"]);
    await first.user.keyboard("{Enter}go{Enter}");
    expect(first.engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "@everyone go", mentions: [{ k: "*", o: 0, l: 9 }] }]);
    first.unmount();
    for (const group of [active(), active({ isAdmin: true, profile: "community" })]) {
      const view = openGroup(group);
      await view.user.type(composer(), "@ev");
      expect(screen.queryByTestId("mention-picker")).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("mentions in the bubbles", () => {
  it("shows each with the member's name now, mine stronger, and someone gone as written", async () => {
    saveSettings({ ...loadSettings(), defaultNickname: "Zoe" });
    const renamed = [members[0], member({ key: ALICE, nick: "Alicia", role: "admin" }), members[2]];
    const text = "@Alice @me and @Gone, see https://x.example";
    openGroup(active({ members: renamed }), [stored({ member: BOB, text, mentioned: true,
      mentions: [{ k: ALICE, o: 0, l: 6 }, { k: ME, o: 7, l: 3 }, { k: "gone".padEnd(52, "y"), o: 15, l: 5 }] })]);
    const chips = await screen.findAllByTestId("mention");
    expect(chips.map(c => c.textContent)).toEqual(["@Alicia", "@Zoe", "@Gone"]);
    expect(chips.map(c => c.dataset.me)).toEqual([undefined, "true", undefined]);
    // The rest is text as ever: the link is still a link.
    expect(screen.getByRole("link", { name: "https://x.example" })).toBeInTheDocument();
    expect(screen.getByTestId("message-text")).toHaveTextContent("@Alicia @Zoe and @Gone, see https://x.example");
  });

  it("everyone is mine when someone else says it, not when I do", async () => {
    openGroup(active(), [
      stored({ id: "a", member: ALICE, text: "@everyone up", mentions: [{ k: "*", o: 0, l: 9 }] }),
      stored({ id: "b", sender: "me", text: "@everyone down", mentions: [{ k: "*", o: 0, l: 9 }] }),
    ]);
    const chips = await screen.findAllByTestId("mention");
    expect(chips.map(c => [c.textContent, c.dataset.me])).toEqual([["@everyone", "true"], ["@everyone", undefined]]);
  });

  it("keeps the @ before a name that starts in Arabic in an English message: only the name is isolated", async () => {
    const arabic = [members[0], members[1], member({ key: BOB, nick: "بوب Bob" })];
    openGroup(active({ members: arabic }), [stored({ member: ALICE, text: "@بوب Bob are you there?", mentions: [{ k: BOB, o: 0, l: 8 }] })]);
    const chip = await screen.findByTestId("mention");
    expect(chip).toHaveTextContent("@بوب Bob");
    // A <bdi> around "@بوب Bob" takes its direction from the Arabic, and the @ is drawn at its right: "Bob بوب@ are…".
    expect(chip.closest("bdi")).toBeNull();
    expect(chip.firstChild?.textContent).toBe("@");
    expect(chip.querySelector("bdi")).toHaveTextContent("بوب Bob");
  });
});

describe("an unread mention in the chat list", () => {
  function list(groups: GroupView[]) {
    fakeEngine.update({ groups });
    return renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
  }
  const row = () => screen.getByTestId("group-row");

  it("puts an @ beside the unread dot, until the group is read", () => {
    const t = 1_700_000_000_000;
    markGroupRead("group-1", t - 10);
    const view = list([active({ lastMessageAt: t, lastMentionAt: t - 5 })]);
    expect(within(row()).getByTestId("group-row-mention")).toBeInTheDocument();
    expect(within(row()).getByTestId("group-row-open")).toHaveAccessibleName(/, you were mentioned$/);
    view.unmount();
    // Newer messages, but the mention was read.
    markGroupRead("group-1", t - 1);
    const again = list([active({ lastMessageAt: t, lastMentionAt: t - 5 })]);
    expect(within(row()).getByTestId("group-row-unread")).toBeInTheDocument();
    expect(within(row()).queryByTestId("group-row-mention")).not.toBeInTheDocument();
    again.unmount();
  });

  it("goes at once when an edit takes the mention out: the engine's view moves the group's mark back", async () => {
    const t = 1_700_000_000_000;
    markGroupRead("group-1", t - 10);
    list([active({ lastMessageAt: t, lastPeerMessageAt: t, lastMentionAt: t })]);
    expect(within(row()).getByTestId("group-row-mention")).toBeInTheDocument();
    // The edited message is still the newest, unread; the mention before it was read.
    act(() => { fakeEngine.update({ groups: [active({ lastMessageAt: t, lastPeerMessageAt: t, lastMentionAt: t - 20 })] }); });
    await waitFor(() => expect(within(row()).queryByTestId("group-row-mention")).not.toBeInTheDocument());
    expect(within(row()).getByTestId("group-row-unread")).toBeInTheDocument();
  });

  it("goes grey in a muted group only when mentions are kept quiet too", () => {
    const t = 1_700_000_000_000;
    markGroupRead("group-1", 0);
    setChatMute(groupChat("group-1"), "forever");
    const view = list([active({ lastMessageAt: t, lastMentionAt: t })]);
    expect(within(row()).getByTestId("group-row-mention")).not.toHaveAttribute("data-muted");
    view.unmount();
    setMentionsNotify(groupChat("group-1"), false);
    list([active({ lastMessageAt: t, lastMentionAt: t })]);
    expect(within(row()).getByTestId("group-row-mention")).toHaveAttribute("data-muted", "true");
  });
});

describe("Still notify me when I'm mentioned", () => {
  it("is on unless turned off, and lets only a mention through a mute", () => {
    const chat = groupChat("g1");
    expect(mentionsNotify(chat)).toBe(true);
    expect(mutedFor(chat, true)).toBe(false);
    setChatMute(chat, "forever");
    expect(mutedFor(chat, false)).toBe(true);
    expect(mutedFor(chat, true)).toBe(false);
    setMentionsNotify(chat, false);
    expect(mutedFor(chat, true)).toBe(true);
    setMentionsNotify(chat, true);
    expect(localStorage.getItem("ghostly_mute_mentions_group:g1")).toBeNull();
    expect(mutedFor(undefined, false)).toBe(false);
  });

  it("plays and notifies a mention in a muted group, not the group's other messages", async () => {
    saveSettings({ ...loadSettings(), notifications: { soundEnabled: true, systemEnabled: true } });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderApp(<AttentionFeedback />);
    setChatMute(groupChat("g1"), "forever");
    let n = 0;
    const event = (patch: Partial<AttentionEvent>): AttentionEvent => ({ id: `mention-${++n}`, type: "message", at: Date.now(), linkId: "group:g1", ...patch });
    const send = async (...events: AttentionEvent[]) => {
      const marker = event({ type: "coin", linkId: undefined });
      act(() => { for (const e of [...events, marker]) fakeEngine.emit({ kind: "attention", event: e }); });
      await waitFor(() => expect(sound.playSound).toHaveBeenLastCalledWith("coin"));
      const played = sound.playSound.mock.calls.slice(0, -1).map(([name]) => name);
      sound.playSound.mockClear();
      return played;
    };
    expect(await send(event({}))).toEqual([]);
    expect(sound.notice).not.toHaveBeenCalled();
    // Its own sound (Chat sounds are on unless turned off: apps/ui/src/lib/cues.ts).
    expect(await send(event({ mention: true }))).toEqual(["mention"]);
    await waitFor(() => expect(sound.notice).toHaveBeenCalledTimes(1));
    setMentionsNotify(groupChat("g1"), false);
    expect(await send(event({ mention: true }))).toEqual([]);
    expect(sound.notice).toHaveBeenCalledTimes(1);
  });

  it("is a checkbox in the group's mute menu that keeps the menu open", async () => {
    const { user } = openGroup(active());
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-mute-open"));
    const toggle = within(screen.getByTestId("mute-menu")).getByRole("checkbox", { name: "Still notify me when I'm mentioned" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(mentionsNotify(groupChat("group-1"))).toBe(false);
    expect(screen.getByTestId("mute-menu")).toBeInTheDocument();
    // Choosing a duration keeps the choice; the mute durations are the same four.
    expect(within(screen.getByTestId("mute-menu")).getAllByTestId(/^mute-(15m|1h|1d|forever)$/)).toHaveLength(4);
    await user.click(screen.getByTestId("mute-1h"));
    expect(mentionsNotify(groupChat("group-1"))).toBe(false);
  });
  // A menu item role (menuitem, menuitemcheckbox, menuitemradio) is only valid inside a role=menu or menubar
  // (axe's aria-required-parent). The app's menus are groups of buttons: none may claim one outside a menu.
  const strayMenuItems = () => [...document.querySelectorAll('[role^="menuitem"]')]
    .filter(el => !el.parentElement?.closest('[role="menu"], [role="menubar"]')).map(el => el.getAttribute("data-testid"));

  for (const phone of [false, true]) it(`on ${phone ? "a phone's sheet" : "a wide screen's popover"} the mentions row is a checkbox the menu's keys reach and Space toggles`, async () => {
    windowIs(phone);
    const { user } = openGroup(active());
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-mute-open"));
    const menu = screen.getByTestId("mute-menu");
    expect(menu).toHaveAttribute("data-menu", phone ? "sheet" : "popover");
    const toggle = within(menu).getByTestId("mute-mentions");
    expect(strayMenuItems()).toEqual([]);
    expect(toggle).toHaveAttribute("role", "checkbox");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // Its container is the labelled group of the menu's rows, as in every other menu of the app.
    expect(menu).toHaveAttribute("role", "group");
    expect(menu).toHaveAccessibleName("Mute notifications");
    // The first duration has the focus; End goes to the last row, the checkbox, and ArrowDown wraps to the first.
    await waitFor(() => expect(within(menu).getByTestId("mute-15m")).toHaveFocus());
    await user.keyboard("{End}");
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(mentionsNotify(groupChat("group-1"))).toBe(false);
    expect(screen.getByTestId("mute-menu")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByTestId("mute-15m")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(toggle).toHaveFocus();
  });
});
