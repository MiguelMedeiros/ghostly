import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupJoinStage, GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { groupChat, mutedUntil, setChatMute } from "../../lib/chatMute";
import { groupReadAt, markGroupRead } from "../../lib/groups";
import { getSessionDraft } from "../../lib/storage";

// covers: groups.send, groups.leave, groups.forget, groups.rotate, groups.link.join

const ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const members = [member({ key: ME, me: true, online: true }), member({ key: ALICE, nick: "Alice", role: "admin", online: true }), member({ key: BOB, nick: "Bob" })];
const active = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, members, ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

/** Opens /group/group-1 as the app routes it, with the group in the engine's state and its history. */
function openGroup(group: GroupView | null, history: StoredMessage[] = []) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
  if (group) fakeEngine.update({ groups: [group] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}

const composer = () => screen.getByRole("textbox");

describe("GroupChat: what the header says", () => {
  it("counts the members and who of the others can be reached", () => {
    openGroup(active());
    expect(screen.getByTestId("group-name")).toHaveTextContent("Friends");
    expect(screen.getByTestId("group-members")).toHaveTextContent("3 members · 1 of 2 reachable");
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", "active");
    expect(screen.queryByTestId("group-notice")).not.toBeInTheDocument();
    expect(composer()).toBeEnabled();
  });

  it("names a group that has no name", () => {
    openGroup(active({ name: "", members: [members[0]] }));
    expect(screen.getByTestId("group-name")).toHaveTextContent("A group");
    expect(screen.getByTestId("group-members").textContent).toBe("1 member");
  });

  it("with nobody else in it (just created, or everyone left), counts the members and no reachability", () => {
    openGroup(active({ members: [members[0]] }));
    expect(screen.getByTestId("group-members").textContent).toBe("1 member");
  });

  it("says who invited me while it is an invitation, with Accept and Decline and nothing a member has", async () => {
    // On a phone the page is the only way in from the row: it was an empty chat with a field that took nothing.
    const { user, engine } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }));
    engine.on("acceptGroupInvitation", () => { throw new Error("The contact who invited you is not connected. Try again when they are."); }).on("declineGroupInvitation", () => undefined);
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", "invitation");
    expect(screen.getByTestId("group-members")).toHaveTextContent("Invitation from Alice");
    const card = screen.getByTestId("group-invitation");
    expect(card).toHaveTextContent("Friends");
    expect(card).toHaveTextContent("Invited by Alice · 3 members");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("group-options"));
    expect(screen.queryByTestId("chat-search-open")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-options-menu")).not.toHaveTextContent("Move to folder");
    await user.keyboard("{Escape}");
    await user.click(within(card).getByTestId("group-accept"));
    expect(engine.callsTo("acceptGroupInvitation")).toEqual([{ groupId: "group-1" }]);
    expect(await within(card).findByTestId("group-answer-refused")).toHaveTextContent("Alice is not connected yet. Try again in a moment.");
    await user.click(within(card).getByTestId("group-decline"));
    expect(engine.callsTo("declineGroupInvitation")).toEqual([{ groupId: "group-1" }]);
  });

  it("opens no member list on an invitation: the engine knows no member yet, only the count the card says", async () => {
    // It opened "0 members" (with the read rules) under a card that says 3 members.
    const { user } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Ana", admin: ALICE, members: 3, accepted: false } }));
    await user.click(screen.getByTestId("group-members"));
    await user.click(screen.getByTestId("group-avatar"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-avatar-open")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-members").tagName).not.toBe("BUTTON");
    await user.click(screen.getByTestId("group-options"));
    const menu = screen.getByTestId("group-options-menu");
    expect(menu).not.toHaveTextContent("Members");
    expect(screen.queryByTestId("chat-mute-open")).not.toBeInTheDocument();
    expect(within(menu).getByTestId("group-forget")).toBeInTheDocument();
  });

  it.each([["a mouse", false], ["a touch screen", true]] as const)("Accept from the keyboard hands the focus to the group's ⋮ while it joins, not the page (%s)", async (_, touch) => {
    // With a mouse the message field takes it once it is there; on a touch screen it waits for a tap (touchOnly.ts).
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => query === "(any-pointer: coarse)" || query === "(any-pointer: fine)"
      ? ({ ...matchMedia(query), matches: query === "(any-pointer: coarse)" ? touch : !touch } as MediaQueryList) : matchMedia(query));
    const invitation = { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false };
    const { user, engine } = openGroup(groupView({ canSend: false, invitation }));
    engine.on("acceptGroupInvitation", () => { fakeEngine.update({ groups: [groupView({ canSend: false, invitation: { ...invitation, accepted: true } })] }); });
    screen.getByTestId("group-accept").focus();
    await user.keyboard("{Enter}");
    expect(await within(screen.getByTestId("group-invitation")).findByText("Joining…")).toBeInTheDocument();
    expect(screen.queryByTestId("group-accept")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-options")).toHaveFocus();
    act(() => engine.update({ groups: [active()] }));
    expect(touch ? screen.getByTestId("group-options") : composer()).toHaveFocus();
  });

  it.each([["removed", "removed"], ["no status", undefined]] as const)("asks a member invited back over the history kept from before (%s)", async (_, status) => {
    openGroup(groupView({ status, canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }),
      [stored({ id: "old", text: "from before", member: ALICE })]);
    expect(screen.getByTestId("group-invitation")).toHaveTextContent("Invited by Alice · 3 members");
    expect(screen.getByTestId("group-accept")).toBeInTheDocument();
    expect(await screen.findByText("from before")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  const takenBack = groupView({ name: "Book club", canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false, takenBack: true } });
  it("says who took an invitation back, and what to do", () => {
    openGroup(takenBack);
    expect(screen.getByTestId("group-members")).toHaveTextContent("Invitation taken back");
    expect(screen.getByTestId("group-taken-back")).toHaveTextContent("Alice took back the invitation to Book club" + "Ask Alice for a new invitation or the group's link.");
    expect(screen.queryByText("This group is gone from this device.")).not.toBeInTheDocument();
  });

  it("says an invitation was taken back in the app's language", () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [takenBack] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    expect(screen.getByTestId("group-taken-back")).toHaveTextContent("Alice retirou o convite para Book club" + "Peça a Alice um novo convite ou o link do grupo.");
  });

  it("says an invitation to a group with no name was taken back in a sentence of its own, not with \"A group\" mid-sentence", () => {
    const noName = (contact: string) => groupView({ name: "", canSend: false, invitation: { linkId: "link-1", contact, admin: ALICE, members: 3, accepted: false, takenBack: true } });
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    for (const [contact, language, words] of [
      ["Ana", "en", "Ana took back the invitation to the group"], ["Ana", "pt", "Ana retirou o convite para o grupo"],
      ["", "en", "The invitation to the group was taken back"], ["", "pt", "O convite para o grupo foi retirado"],
    ] as const) {
      fakeEngine.update({ groups: [noName(contact)] });
      const { unmount } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language });
      const card = screen.getByTestId("group-taken-back");
      expect(card).toHaveTextContent(words);
      expect(card).not.toHaveTextContent(/A group|Um grupo/);
      unmount();
    }
  });

  it("says an invitation came from a contact when it does not know their name", () => {
    openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "", admin: ALICE, members: 3, accepted: true } }));
    expect(screen.getByTestId("group-members")).toHaveTextContent("Invitation from a contact");
  });

  it("Decline on the invitation's own page goes back to the chat list: the group is gone from here", async () => {
    const { user, engine } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }));
    // The engine deletes a declined invitation with nothing kept: the page would be left saying the group is gone.
    engine.on("declineGroupInvitation", () => { fakeEngine.update({ groups: [] }); });
    within(screen.getByTestId("group-invitation")).getByTestId("group-decline").focus();
    await user.keyboard("{Enter}");
    expect(engine.callsTo("declineGroupInvitation")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("Delete from the keyboard on a taken-back invitation's page hands the focus to the next row of the list, or to New", async () => {
    // It was left on the page's body once home: the next Tab started again from the top.
    const other = { ...takenBack, id: "group-2" };
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    for (const [groups, next] of [[[takenBack, other], "group-2"], [[takenBack], undefined]] as const) {
      fakeEngine.update({ groups: [...groups] });
      const { user, engine, unmount } = renderApp(<UpdateProvider><Sidebar /><Routes>
        <Route path="/" element={<p>Chat list</p>} />
        <Route path="/group/:groupId" element={<GroupChat />} />
      </Routes></UpdateProvider>, { route: "/group/group-1" });
      engine.on("declineGroupInvitation", () => { fakeEngine.update({ groups: groups.slice(1) }); });
      within(screen.getByTestId("group-invitation")).getByTestId("group-taken-back-delete").focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByText("Chat list")).toBeInTheDocument();
      const row = next && screen.getAllByTestId("group-row").find(r => r.dataset.group === next)!;
      expect(row ? within(row).getByTestId("group-row-open") : screen.getByTestId("sidebar-new-chat")).toHaveFocus();
      unmount();
    }
  });

  it("a Decline the engine refuses keeps the invitation's page, and says why", async () => {
    const { user, engine } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }));
    engine.on("declineGroupInvitation", () => { throw new Error("No invitation to decline"); });
    await user.click(within(screen.getByTestId("group-invitation")).getByTestId("group-decline"));
    expect(await screen.findByTestId("group-answer-refused")).toBeInTheDocument();
    expect(screen.queryByText("Chat list")).not.toBeInTheDocument();
  });

  it("Decline on the band over a member's kept history stays on the group", async () => {
    const { user, engine } = openGroup(groupView({ status: "removed", canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }),
      [stored({ id: "old", text: "from before", member: ALICE })]);
    engine.on("declineGroupInvitation", () => { fakeEngine.update({ groups: [groupView({ status: "removed", canSend: false })] }); });
    await screen.findByText("from before");
    await user.click(within(screen.getByTestId("group-invitation")).getByTestId("group-decline"));
    expect(engine.callsTo("declineGroupInvitation")).toEqual([{ groupId: "group-1" }]);
    await screen.findByText("from before");
    expect(screen.queryByText("Chat list")).not.toBeInTheDocument();
  });

  it("says the group is gone when this device does not have it, with a way back to the chat list", async () => {
    // Deleted on another device, say: the group page has no tabs, and an installed iPhone web app no system back.
    const { user } = openGroup(null);
    expect(screen.getByText("This group is gone from this device.")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("group-gone")).getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });
});

describe("GroupChat: joining through a link", () => {
  const viaLink = (admin: string) => groupView({ canSend: false, invitation: { linkId: "", contact: "", admin, members: 0, accepted: true, viaLink: true } });

  it("waits for the admin's app, and says it can be left alone", () => {
    openGroup(viaLink(""));
    expect(screen.getByTestId("group-members")).toHaveTextContent("Joining through a link");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("Waiting to be let in");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("It happens once the admin's app is open. You can leave this page.");
    // Nothing to write until the group lets you in: no composer at all.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("still knocking after two minutes: says the link may have been replaced, and not before", async () => {
    openGroup(groupView({ profile: "community", createdAt: Date.now() - 2 * 60_000 + 400, canSend: false, invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocked" } }));
    expect(screen.queryByTestId("group-joining-stale")).not.toBeInTheDocument();
    expect(await screen.findByTestId("group-joining-stale", {}, { timeout: 3_000 })).toHaveTextContent("Still no answer. If the link was replaced, ask for the new one.");
  });

  it("others knocking too: says how many wait, and after two minutes that the group is busy, not that the link may be dead", async () => {
    const knocking = (waiting: number | undefined, age = 0) => groupView({ profile: "community", createdAt: Date.now() - age, canSend: false,
      invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocked", ...(waiting && { waiting }) } });
    const view = openGroup(knocking(3));
    expect(screen.getByTestId("group-joining-queue")).toHaveTextContent("3 more people are waiting to be let in.");
    expect(screen.queryByTestId("group-joining-stale")).not.toBeInTheDocument();
    act(() => view.engine.update({ groups: [knocking(1)] }));
    expect(screen.getByTestId("group-joining-queue")).toHaveTextContent("1 more person is waiting to be let in.");
    // Alone at the door: nothing about a queue.
    act(() => view.engine.update({ groups: [knocking(undefined)] }));
    expect(screen.queryByTestId("group-joining-queue")).not.toBeInTheDocument();
    // Two minutes on, still behind others: a wait, in words that do not send the person to ask for another link.
    act(() => view.engine.update({ groups: [knocking(2, 2 * 60_000 - 400)] }));
    const hint = await screen.findByTestId("group-joining-stale", {}, { timeout: 3_000 });
    expect(hint).toHaveTextContent("Still waiting: the group lets people in a few at a time.");
    expect(hint).not.toHaveTextContent("link was replaced");
  });

  it("a knock someone answered is not told the link may be old", () => {
    openGroup(groupView({ createdAt: Date.now() - 10 * 60_000, canSend: false, invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "answered" } }));
    expect(screen.getByTestId("group-joining")).toHaveTextContent("The admin's app saw you knock");
    expect(screen.queryByTestId("group-joining-stale")).not.toBeInTheDocument();
  });

  it("an app with no WebRTC but native transports is told it is in in a moment, as any", () => {
    // Ghostly Desktop on Linux: Iroh or HyperDHT carry the entry session (WISP 902 § Transports).
    fakeEngine.update({ transport: { protocol: "webrtc/1", relays: [], webrtc: false } });
    openGroup({ ...groupView({ canSend: false, invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "answered" } }), profile: "community" });
    expect(screen.getByTestId("group-joining")).not.toHaveTextContent("Groups can't connect from this app yet");
  });

  it("an app with no transport for group links says it cannot get in from here, not that it is in in a moment", () => {
    fakeEngine.update({ transport: { protocol: "webrtc/1", relays: [], webrtc: false, groupLinks: false } });
    openGroup({ ...groupView({ canSend: false, invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "answered" } }), profile: "community" });
    const card = screen.getByTestId("group-joining");
    expect(card).toHaveTextContent("Groups can't connect from this app yet");
    expect(card).toHaveTextContent("Open the group in the web app or on another device.");
    expect(card).not.toHaveTextContent("You are in in a moment");
    expect(card.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByTestId("group-joining-cancel")).toBeInTheDocument();
  });

  it("says when the admin's app answered", () => {
    openGroup(viaLink(ALICE));
    expect(screen.getByTestId("group-members")).toHaveTextContent("Joining…");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("Joining Friends…");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("The admin's app answered: getting the group's keys.");
  });

  const staged = (stage: GroupJoinStage, admin = "") => groupView({ canSend: false, invitation: { linkId: "", contact: "", admin, members: 0, accepted: true, viaLink: true, stage } });
  const steps = () => within(screen.getByTestId("group-joining-steps")).getAllByRole("listitem").map(li => li.getAttribute("data-state"));

  it.each([
    ["knocking", "", "Leaving a knock where the admin's app looks for one", ["current", "todo", "todo", "todo"]],
    ["knocked", "", "It happens once the admin's app is open", ["done", "current", "todo", "todo"]],
    ["answered", "", "The admin's app saw you knock and is connecting to you", ["done", "done", "current", "todo"]],
    // Let in: what is left is connecting to the members, which the chat itself shows next.
    ["admitted", ALICE, "getting the group's keys", ["done", "done", "done", "current"]],
  ] as const)("shows the join step by step: %s", (stage, admin, text, states) => {
    openGroup(staged(stage, admin));
    expect(screen.getByTestId("group-joining")).toHaveTextContent(text);
    expect(screen.getByTestId("group-joining-steps")).toHaveAttribute("data-stage", stage);
    expect(steps()).toEqual(states);
  });

  it("in a community, says a member (any) is answering, then that it connects to the group", () => {
    const labels = () => within(screen.getByTestId("group-joining-steps")).getAllByRole("listitem").map(li => li.textContent);
    openGroup({ ...staged("answered"), profile: "community" });
    expect(screen.getByTestId("group-joining")).toHaveTextContent("A member is letting you in");
    expect(labels()).toEqual(["✓Knock sent to the group", "✓A member's app is answering", "Let in: getting the group's keys", "Connecting to the group"]);
    expect(steps()).toEqual(["done", "done", "current", "todo"]);
  });

  it("once in, says it is connecting to the members until one is reached", async () => {
    const joined = stored({ id: "event:1:joined", event: "joined", text: "You joined.", timestamp: Date.now() });
    const away = [members[0], member({ key: ALICE, nick: "Alice", role: "admin" })];
    openGroup(active({ members: away }), [joined]);
    expect(await screen.findByTestId("group-connecting")).toHaveTextContent("You're in. Messages go out once a member is reached.");
    expect(screen.getByTestId("group-members")).toHaveTextContent("2 members · 0 of 1 reachable");
    act(() => fakeEngine.update({ groups: [active({ members: [members[0], { ...away[1], online: true }] })] }));
    expect(screen.queryByTestId("group-connecting")).not.toBeInTheDocument();
  });

  it("a member of long standing whose members are away is not told it is connecting", async () => {
    const joined = stored({ id: "event:1:joined", event: "joined", text: "You joined.", timestamp: Date.now() - 60 * 60_000 });
    openGroup(active({ members: [members[0], member({ key: ALICE, nick: "Alice", role: "admin" })] }), [joined]);
    expect(await screen.findByTestId("group-members")).toHaveTextContent("0 of 1 reachable");
    expect(screen.queryByTestId("group-connecting")).not.toBeInTheDocument();
  });

  it("cancels the join: forgets the group and goes back to the chat list", async () => {
    const { user, engine } = openGroup(viaLink(""));
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-joining-cancel"));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
    expect(screen.getByText("Chat list")).toBeInTheDocument();
  });
});

describe("GroupChat: out of the group", () => {
  it.each([
    ["removed", "You were removed from this group", "You were removed from this group"],
    ["left", "You left this group", "You left this group"],
    // In a few words; the engine's own English (which fork) is not the line.
    ["forked", "The membership history forked. Membership changes are halted; the admin must re-form the group.", "Group changes are paused. The admin must re-form the group."],
  ] as const)("says why when %s, and cannot send", async (status, reason, said) => {
    const { user } = openGroup(active({ status, statusReason: reason, canSend: false }));
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", status);
    expect(screen.getByTestId("group-notice")).toHaveTextContent(said);
    expect(screen.getByTestId("group-members")).toHaveTextContent(said);
    expect(composer()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    // Nothing to leave; only forgetting it here is left.
    await user.click(screen.getByTestId("group-options"));
    expect(screen.queryByTestId("group-leave")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-forget")).toBeInTheDocument();
  });

  it("says how to come back when removed from a community, and a line when back in", async () => {
    openGroup(active({ profile: "community", status: "removed", statusReason: "You were removed from this group", canSend: false }),
      [stored({ id: "event:4:joined::1", event: "joined", text: "You joined again" })]);
    expect(screen.getByTestId("group-notice")).toHaveTextContent("You were removed. Open the group's link to join again.");
    expect(composer()).toBeDisabled();
    expect(await screen.findByText("You joined again.")).toBeInTheDocument();
  });

  // Removed from a community, the link opened again and nobody there yet: the engine lists the group as it was kept,
  // with the knock beside it.
  const knockingAgain = (stage: GroupJoinStage = "knocked") => active({ profile: "community", status: "removed", statusReason: "You were removed from this group", canSend: false,
    invitation: { linkId: "entry-1", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage } });

  it("removed from a community and knocking again: the history kept stays readable, under a line that says it waits", async () => {
    const { user } = openGroup(knockingAgain(), [stored({ id: "g1", text: "said before I was removed" })]);
    expect(await screen.findByText("said before I was removed")).toBeInTheDocument();
    // No join card over the history: that is a first join's.
    expect(screen.queryByTestId("group-joining")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", "removed");
    const notice = screen.getByTestId("group-notice");
    expect(notice).toHaveTextContent("Waiting to be let in" + "It happens once a member's app is open. You can leave this page.");
    expect(notice).not.toHaveTextContent("Open the group's link to join again");
    // The header still says what the group is to me, not "Invitation from a contact".
    expect(screen.getByTestId("group-members")).toHaveTextContent("You were removed from this group");
    expect(composer()).toBeDisabled();
    // Its menu is the group's, the search among it.
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-search-open")).toBeInTheDocument();
    expect(screen.getByTestId("group-forget")).toBeInTheDocument();
  });

  it("removed from a community and knocking again: says when a member is letting it in", () => {
    openGroup(knockingAgain("answered"));
    expect(screen.getByTestId("group-notice")).toHaveTextContent("A member is letting you in" + "A member's app saw you knock and is connecting to you. You are in in a moment.");
  });

  it("removed from a community and knocking again: Cancel joining stops the knock and keeps the group and its history", async () => {
    const { user, engine } = openGroup(knockingAgain(), [stored({ id: "g1", text: "said before I was removed" })]);
    engine.on("declineGroupInvitation", () => { fakeEngine.update({ groups: [{ ...knockingAgain(), invitation: undefined }] }); });
    await user.click(within(screen.getByTestId("group-notice")).getByRole("button", { name: "Cancel joining" }));
    expect(engine.callsTo("declineGroupInvitation")).toEqual([{ groupId: "group-1" }]);
    expect(engine.callsTo("forgetGroup")).toEqual([]);
    // Still on the group, as it was before the link was opened.
    expect(screen.queryByText("Chat list")).not.toBeInTheDocument();
    expect(await screen.findByText("You were removed. Open the group's link to join again.")).toBeInTheDocument();
    expect(screen.getByText("said before I was removed")).toBeInTheDocument();
  });

  it("removed from a community and knocking again: after two minutes of the knock, says the link may have been replaced", () => {
    // Kept a month: timed from when the knock started, not from the group's creation.
    const kept = (since: number) => ({ ...knockingAgain(), createdAt: Date.now() - 30 * 86_400_000,
      invitation: { ...knockingAgain().invitation!, since } });
    const view = openGroup(kept(Date.now() - 60_000));
    expect(screen.queryByTestId("group-joining-stale")).not.toBeInTheDocument();
    act(() => view.engine.update({ groups: [kept(Date.now() - 2 * 60_000 - 1000)] }));
    expect(within(screen.getByTestId("group-notice")).getByTestId("group-joining-stale")).toHaveTextContent("Still no answer. If the link was replaced, ask for the new one.");
  });

  it("removed from a community and knocking again: Cancel joining hands the focus to the group's ⋮", async () => {
    const { user, engine } = openGroup(knockingAgain());
    engine.on("declineGroupInvitation", () => { fakeEngine.update({ groups: [{ ...knockingAgain(), invitation: undefined }] }); });
    within(screen.getByTestId("group-notice")).getByRole("button", { name: "Cancel joining" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("You were removed. Open the group's link to join again.")).toBeInTheDocument();
    expect(screen.getByTestId("group-options")).toHaveFocus();
  });

  it("removed from a community and knocking again: a cancel the engine refuses is said, and the knock goes on", async () => {
    const { user, engine } = openGroup(knockingAgain());
    engine.on("declineGroupInvitation", () => { throw new Error("No invitation to decline"); });
    await user.click(within(screen.getByTestId("group-notice")).getByRole("button", { name: "Cancel joining" }));
    expect(await within(screen.getByTestId("group-notice")).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("group-chat")).toBeInTheDocument();
  });

  it("names the status when the engine gave no reason, in the notice too", () => {
    openGroup(active({ status: "left", canSend: false }));
    expect(screen.getByTestId("group-members")).toHaveTextContent("left");
    expect(screen.getByTestId("group-notice")).toHaveTextContent("left");
  });

  it.each([
    ["removed", "You were removed from this group", "Você foi removido deste grupo"],
    ["forked", "Member 3r69cgd5 holds a different membership history for epoch 4. Membership changes are halted; the admin must re-form the group.",
      "As mudanças no grupo estão pausadas. O admin precisa recriar o grupo."],
    ["lost", "Two members let people in at the same moment and yours did not count. Asking to be let in again…",
      "Dois membros deixaram pessoas entrar ao mesmo tempo. Pedindo para entrar de novo…"],
  ] as const)("says why when %s in the app's language, not in the engine's English", (status, reason, said) => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [active({ status, statusReason: reason, canSend: false })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    expect(screen.getByTestId("group-notice")).toHaveTextContent(said);
    expect(screen.getByTestId("group-members")).toHaveTextContent(said);
  });

  it("disables the composer when the engine says it cannot send, even while active", () => {
    openGroup(active({ canSend: false }));
    expect(composer()).toBeDisabled();
  });
});

describe("GroupChat: the options menu", () => {
  it("offers a member no admin controls", async () => {
    const { user } = openGroup(active());
    await user.click(screen.getByTestId("group-options"));
    const menu = screen.getByTestId("group-options-menu");
    expect(within(menu).getByRole("button", { name: "Members…" })).toBeInTheDocument();
    expect(within(menu).queryByTestId("group-rotate")).not.toBeInTheDocument();
    expect(within(menu).getByTestId("group-leave")).toBeInTheDocument();
  });

  it("lets the admin rotate the keys", async () => {
    const { user, engine } = openGroup(active({ isAdmin: true }));
    engine.on("rotateGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-rotate"));
    expect(engine.callsTo("rotateGroup")).toEqual([{ groupId: "group-1" }]);
    expect(screen.queryByTestId("group-options-menu")).not.toBeInTheDocument();
  });

  it("shows what the engine refused", async () => {
    const { user, engine } = openGroup(active({ isAdmin: true }));
    engine.on("rotateGroup", () => { throw new Error("Bob is not reachable"); });
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-rotate"));
    expect(await screen.findByTestId("group-notice")).toHaveTextContent("Bob is not reachable");
  });

  it("deletes the group from this device only after confirming, and says it leaves the group", async () => {
    const { user, engine } = openGroup(active());
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Delete Friends?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Deleting the group from this device also leaves it.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(engine.callsTo("forgetGroup")).toEqual([]);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from this device" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("keeps the admin from deleting the group while no member is online to become admin", async () => {
    const { user, engine } = openGroup(active({ isAdmin: true, members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: BOB, nick: "Bob" })] }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Nobody is online to become admin" + "Make someone admin, or wait for a member.");
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
    expect(engine.callsTo("forgetGroup")).toEqual([]);
  });

  it("tells the admin of a private group with a working link that it stops working when they leave", async () => {
    const { user } = openGroup(active({ isAdmin: true, entryLink: "https://app.ghostly.tools/#/join/group2/g/k", members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: ALICE, nick: "Alice", online: true })] }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-leave"));
    expect(within(screen.getByRole("dialog")).getByTestId("group-leave-successor"))
      .toHaveTextContent("You are the admin: Alice becomes the admin when you leave. The link shared so far stops working. Alice can share a new one.");
  });

  it("tells the admin who becomes admin when they delete the group, and stays when the engine refuses", async () => {
    const { user, engine } = openGroup(active({ isAdmin: true, members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: ALICE, nick: "Alice", online: true })] }));
    engine.on("forgetGroup", () => { throw new Error("Nobody is online to take over"); });
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("group-leave-successor")).toHaveTextContent("You are the admin: Alice becomes the admin when you leave.");
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nobody is online to take over");
    expect(screen.getByTestId("group-chat")).toBeInTheDocument();
  });

  it("deletes a group it is no longer in in a group's words: nothing to leave, and no contact's copy", async () => {
    const { user, engine } = openGroup(active({ status: "removed", canSend: false }));
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Delete Friends?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("The group and its history go from this device.");
    expect(dialog).not.toHaveTextContent("contact");
    await user.click(within(dialog).getByRole("button", { name: "Delete from this device" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
  });

  it("deleting an invitation says its sender is told it was declined", async () => {
    const { user } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Ana", admin: ALICE, members: 3, accepted: false } }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Delete Friends?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("The invitation goes from this device. Ana is told you declined.");
    expect(dialog).not.toHaveTextContent("Your contact");
  });

  it("deleting an invitation that was taken back says nobody is told", async () => {
    const { user } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Ana", admin: ALICE, members: 3, accepted: false, takenBack: true } }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("The invitation goes from this device. It was taken back, so nobody is told.");
    expect(dialog).not.toHaveTextContent("declined");
  });

  it("deleting an invitation back into a group whose history is kept here says that history goes too", async () => {
    // Removed earlier, invited again: Delete takes the kept group with the invitation (Decline would keep it).
    const { user, engine } = openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Ana", admin: ALICE, members: 3, accepted: false } }),
      [stored({ id: "m1", member: ALICE, text: "from before" })]);
    engine.on("forgetGroup", () => undefined);
    expect(await screen.findByText("from before")).toBeInTheDocument();
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("The invitation and the group's history go from this device. Ana is told you declined.");
    await user.click(within(dialog).getByRole("button", { name: "Delete from this device" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
  });

  it("deleting a community I knock to get back into says the group and its history go", async () => {
    const { user } = openGroup(active({ profile: "community", status: "removed", canSend: false,
      invitation: { linkId: "entry-1", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocked" } }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("The group and its history go from this device.");
    expect(dialog).not.toHaveTextContent("declined");
  });

  it("says that deleting a community leaves it, and how to come back", async () => {
    const { user, engine } = openGroup(active({ profile: "community", community: { hub: false, hubs: 1, connected: 1 } }));
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Delete Friends?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Deleting the group from this device also leaves it.");
    expect(dialog).toHaveTextContent("to come back, open the group's link again");
    // A community is no chat with a contact: none of the chat dialog's words.
    expect(dialog).not.toHaveTextContent("contact");
    await user.click(within(dialog).getByRole("button", { name: "Delete from this device" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("tells a community's admin who becomes admin when they delete it", async () => {
    const { user } = openGroup(active({ profile: "community", isAdmin: true, community: { hub: false, hubs: 1, connected: 1 },
      members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: BOB, nick: "Bob" }), member({ key: ALICE, nick: "Alice", online: true })] }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    expect(within(screen.getByRole("dialog")).getByTestId("group-leave-successor")).toHaveTextContent("You are the admin: Alice becomes the admin when you leave.");
  });

  it("deletes a community nobody is connected to anyway, and says the others still list the person", async () => {
    // Members who never open the app again kept it here for good: Delete was greyed while nobody could take the leave.
    const { user, engine } = openGroup(active({ profile: "community", community: { hub: false, hubs: 0, connected: 0 } }));
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByTestId("leave-blocked")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("leave-unsaid")).toHaveTextContent("Nobody is online to take your leave" + "It goes from this device anyway. The others will still list you as a member.");
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("keeps a community's admin from deleting it while nobody is connected, and says what works with nobody there", async () => {
    // Members who never come back: "Try again in a moment" waited for good, while removing them, or making one admin
    // (a member's delete goes ahead unsaid), works with nobody connected.
    const { user, engine } = openGroup(active({ profile: "community", isAdmin: true, community: { hub: false, hubs: 0, connected: 0 },
      members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: BOB, nick: "Bob" })] }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("leave-blocked")).toHaveTextContent("Nobody is online to take your leave"
      + "Wait for a member to be online, or remove the members first, or make one of them admin.");
    expect(within(dialog).queryByTestId("leave-unsaid")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
    expect(engine.callsTo("forgetGroup")).toEqual([]);
  });

  it("keeps a member from leaving a community while nobody is connected: only Delete goes ahead unsaid", async () => {
    const { user } = openGroup(active({ profile: "community", community: { hub: false, hubs: 0, connected: 0 } }));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-leave"));
    const dialog = screen.getByTestId("group-leave-dialog");
    expect(within(dialog).getByTestId("leave-blocked")).toHaveTextContent("Nobody is online to take your leave" + "Try again in a moment.");
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
  });

  it("keeps a community whose delete was refused, and says why in the dialog", async () => {
    const { user, engine } = openGroup(active({ profile: "community", community: { hub: false, hubs: 1, connected: 1 } }));
    engine.on("forgetGroup", () => { throw new Error("Nobody in the group is connected right now to take your leave. Try again in a moment."); });
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete from this device" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nobody is online to take your leave");
    expect(screen.getByTestId("group-chat")).toBeInTheDocument();
    expect(screen.queryByText("Chat list")).not.toBeInTheDocument();
  });

  it.each(["removed", "left"] as const)("deletes a community it is no longer in (%s) in a group's words: nothing to leave", async (status) => {
    const { user, engine } = openGroup(active({ profile: "community", status, canSend: false }));
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    expect(screen.queryByTestId("group-leave-dialog")).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete from this device" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
  });

  it("opens the members from the header", async () => {
    const { user } = openGroup(active());
    await user.click(screen.getByTestId("group-members"));
    expect(screen.getByTestId("group-members-dialog")).toBeInTheDocument();
  });
});

describe("GroupChat: leaving", () => {
  const leaveFromMenu = async (user: ReturnType<typeof openGroup>["user"]) => {
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-leave"));
    return screen.getByTestId("group-leave-dialog");
  };

  it("says what leaving means before it happens, and can be called off", async () => {
    const { user, engine } = openGroup(active());
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).getByRole("heading", { name: "Leave Friends?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("The group and its history go from this device.");
    expect(within(dialog).queryByTestId("group-leave-successor")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("group-leave-dialog")).not.toBeInTheDocument();
    expect(engine.callsTo("leaveGroup")).toEqual([]);
  });

  // A private group takes someone to let the person back in; a community's link lets them in by itself.
  it.each([
    ["mesh", "to come back someone has to let you in again."],
    ["community", "to come back, open the group's link again."],
  ] as const)("says how to come back to a %s group", async (profile, line) => {
    const { user } = openGroup(active({ profile }));
    expect(await leaveFromMenu(user)).toHaveTextContent(line);
  });

  it("leaves, and goes back to the chat list: the group is gone from it", async () => {
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => ({}));
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(engine.callsTo("leaveGroup")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("forgets the group's mute with its history: rejoining by link reuses the group id, and it is not muted then", async () => {
    setChatMute(groupChat("group-1"), "forever");
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => ({}));
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
    expect(mutedUntil(groupChat("group-1"))).toBeUndefined();
  });

  it("forgets what was typed in it and its read mark: a community rejoined by link had the old words in its field", async () => {
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => ({}));
    await user.type(composer(), "the door code is 4471");
    expect(getSessionDraft("group:group-1")).toBe("the door code is 4471");
    markGroupRead("group-1");
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
    expect(getSessionDraft("group:group-1")).toBe("");
    expect(groupReadAt("group-1")).toBe(0);
  });

  it("stays, and says why, when the engine refuses", async () => {
    setChatMute(groupChat("group-1"), "forever");
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => { throw new Error("Nobody is online to take over"); });
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nobody is online to take over");
    // Still in the group: still muted.
    expect(mutedUntil(groupChat("group-1"))).toBe("forever");
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeEnabled();
    expect(screen.getByTestId("group-chat")).toBeInTheDocument();
  });

  const adminOf = (others: GroupMemberView[]) => active({ isAdmin: true, members: [member({ key: ME, me: true, online: true, role: "admin" }), ...others] });

  it("tells the admin who takes over: the first member online", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob" }), member({ key: ALICE, nick: "Alice", online: true })]));
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).getByTestId("group-leave-successor")).toHaveTextContent("You are the admin: Alice becomes the admin when you leave.");
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeEnabled();
  });

  // The engine hands the role to the first member in roster order over a direct edge of mine (`successor()`): a member
  // reached through a hub cannot take the role commit, so the dialog does not name one.
  it("names the member the engine hands the role to: the first one over a direct edge, not one reached through a hub", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob", online: true, viaHub: true }), member({ key: ALICE, nick: "Alice", online: true })]));
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).getByTestId("group-leave-successor")).toHaveTextContent("You are the admin: Alice becomes the admin when you leave.");
  });

  it("keeps the admin from leaving while the only members online are reached through a hub", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob", online: true, viaHub: true })]));
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).queryByTestId("group-leave-successor")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
  });

  it("keeps the admin from leaving while no member is online to take over", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob" })]));
    const dialog = await leaveFromMenu(user);
    expect(dialog).toHaveTextContent("Nobody is online to become admin" + "Make someone admin, or wait for a member.");
    expect(within(dialog).queryByTestId("group-leave-successor")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
  });

  it("says in red that a private group's admin must act first", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob" })]));
    expect(within(await leaveFromMenu(user)).getByTestId("leave-blocked")).toHaveAttribute("data-tone", "error");
  });

  it("says a community's wait for a hub in the wait tone, not in red", async () => {
    // Nobody at a hub: the button comes back by itself once one is reached, nothing for the person to do meanwhile.
    const { user } = openGroup(active({ profile: "community", isAdmin: true, community: { hub: false, hubs: 1, connected: 0 },
      members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: BOB, nick: "Bob" })] }));
    const dialog = await leaveFromMenu(user);
    // Made a member, the admin could still not leave with nobody connected: removing the members is what lets it go.
    expect(dialog).toHaveTextContent("Nobody is online to take your leave" + "Wait for a member to be online, or remove the members first.");
    expect(within(dialog).getByTestId("leave-blocked")).toHaveAttribute("data-tone", "wait");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeDisabled();
  });

  it("lets the admin of a group of one simply leave", async () => {
    const { user } = openGroup(adminOf([]));
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).queryByTestId("group-leave-successor")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("group-leave-confirm")).toBeEnabled();
  });

  it("names an unnamed group", async () => {
    const { user } = openGroup(active({ name: "" }));
    const dialog = await leaveFromMenu(user);
    expect(within(dialog).getByRole("heading", { name: "Leave this group?" })).toBeInTheDocument();
  });
});

describe("GroupChat: history and sending", () => {
  it("names each message's member as the roster knows them now", async () => {
    openGroup(active(), [
      stored({ id: "e1", event: "joined", member: ALICE, text: "someone joined" }),
      stored({ id: "e2", event: "admin", member: ME, text: "admin changed" }),
      stored({ id: "m1", member: ALICE, text: "hi all" }),
      stored({ id: "m2", member: "gone".padEnd(52, "y"), text: "bye" }),
      stored({ id: "m3", sender: "me", member: ME, text: "hello" }),
    ]);
    expect(await screen.findByText("Alice joined")).toBeInTheDocument();
    expect(screen.getByText("You are now the admin")).toBeInTheDocument();
    expect(screen.getByText("~Alice")).toBeInTheDocument();
    // Someone no longer in the roster: named by their key.
    expect(screen.getByText("~Member goneyyyy")).toBeInTheDocument();
    expect(screen.getAllByText(/^~/)).toHaveLength(2);
  });

  it("names an author no longer in the roster by the name the group knew them by", async () => {
    // Removed, then invited again: a new member key, so their earlier messages' key is not in the roster.
    const gone = "gone".padEnd(52, "y");
    openGroup(active({ formerNames: { [gone]: "Carol" } }), [stored({ id: "m1", member: gone, text: "before I left" })]);
    expect(await screen.findByText("~Carol")).toBeInTheDocument();
    expect(screen.queryByText("~Member goneyyyy")).not.toBeInTheDocument();
  });

  it("in a community, names a member who left by the name it was heard under, on their messages and their join line", async () => {
    // Bug hunt r9c: after Caio left, his messages read "~Member xxxx", and his join line, written before his name came,
    // read "Member d19xxqgr joined" right above "Caio is no longer a member".
    const gone = "gone".padEnd(52, "y");
    openGroup(active({ profile: "community", formerNames: { [gone]: "Caio" } }), [
      stored({ id: "e1", event: "joined", member: gone, text: "Member goneyyyy joined" }),
      stored({ id: "m1", member: gone, text: "caio was here" }),
      stored({ id: "e2", event: "gone", member: gone, text: "Caio is no longer a member" }),
    ]);
    expect(await screen.findByText("~Caio")).toBeInTheDocument();
    expect(screen.getByText("Caio joined")).toBeInTheDocument();
    expect(screen.queryByText(/Member goneyyyy/)).not.toBeInTheDocument();
  });

  it("keeps what was stored for an event about someone no longer there", async () => {
    openGroup(active(), [stored({ id: "e1", event: "removed", member: "gone".padEnd(52, "y"), text: "Carol was removed" })]);
    expect(await screen.findByText("Carol was removed")).toBeInTheDocument();
  });

  it("follows messages that arrive while it is open", async () => {
    const { engine } = openGroup(active());
    await screen.findByTestId("group-chat");
    act(() => engine.messages("group:group-1", [stored({ id: "m9", member: BOB, text: "late news" })]));
    expect(screen.getByText("late news")).toBeInTheDocument();
    act(() => engine.messages("group:other", [stored({ id: "m10", text: "elsewhere" })]));
    expect(screen.queryByText("elsewhere")).not.toBeInTheDocument();
  });

  it("shows only the open group's history, with what came while it was away", async () => {
    const other = active({ id: "group-2", name: "Others" });
    fakeEngine.update({ groups: [active(), other] });
    const first = [stored({ id: "m1", member: ALICE, text: "in the first group" })];
    // The first group's list comes once; after that, neither group's own list ever does.
    let asked = 0;
    fakeEngine.on("groupMessages", ({ groupId }) => groupId === "group-1" && asked++ === 0 ? first : new Promise<StoredMessage[]>(() => {}));
    function Go() {
      const navigate = useNavigate();
      return <><button onClick={() => navigate("/group/group-1")}>one</button><button onClick={() => navigate("/group/group-2")}>two</button></>;
    }
    renderApp(<><Go /><Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes></>, { route: "/group/group-1" });
    expect(await screen.findByText("in the first group")).toBeInTheDocument();
    await act(async () => screen.getByRole("button", { name: "two" }).click());
    expect(screen.getByTestId("group-name")).toHaveTextContent("Others");
    // Never the last group's messages under this one's name.
    expect(screen.queryByText("in the first group")).not.toBeInTheDocument();
    act(() => fakeEngine.messages("group:group-1", [...first, stored({ id: "m2", member: ALICE, text: "while you were away" })]));
    await act(async () => screen.getByRole("button", { name: "one" }).click());
    expect(screen.getByText("while you were away")).toBeInTheDocument();
  });

  it("a community's lines about a member who has left since read in the app's language", () => {
    const GONE = "gone".padEnd(52, "y");
    fakeEngine.on("groupMessages", () => [
      stored({ id: "e1", event: "joined", member: GONE, text: "Carol joined" }),
      stored({ id: "e2", event: "admin", member: GONE, text: "Carol is now the admin", timestamp: 1_700_000_000_001 }),
      stored({ id: "e3", event: "renamed", member: GONE, text: "Carol renamed the group to “Town”", timestamp: 1_700_000_000_002 }),
      stored({ id: "e4", event: "picture", member: GONE, text: "Carol changed the group's picture", timestamp: 1_700_000_000_003 }),
      stored({ id: "e5", event: "picture", member: GONE, text: "Carol removed the group's picture", timestamp: 1_700_000_000_004 }),
    ]).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [active({ profile: "community" })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    return screen.findAllByTestId("group-event").then(lines => expect(lines.map(l => l.textContent)).toEqual([
      "Carol entrou", "Carol agora é o admin", "Carol renomeou o grupo para “Town”", "Carol alterou a foto do grupo", "Carol removeu a foto do grupo",
    ]));
  });

  for (const profile of ["mesh", "community"] as const) it(`after being removed (${profile}), my own lines still read as mine, in the app's language`, async () => {
    // Bug hunt 1008-1246: once removed the roster no longer has me, so "You are now the admin" read "Membro meyyyyyy agora é o admin".
    fakeEngine.on("groupMessages", () => [
      stored({ id: "e1", event: "admin", member: ME, text: "You are now the admin" }),
      stored({ id: "e2", event: "renamed", member: ME, text: "You renamed the group to “Ghost Club”", timestamp: 1_700_000_000_001 }),
      stored({ id: "e3", event: "picture", member: ME, text: "You changed the group's picture", timestamp: 1_700_000_000_002 }),
      stored({ id: "e4", event: "picture", member: ME, text: "You removed the group's picture", timestamp: 1_700_000_000_003 }),
      stored({ id: "e5", event: "removed", text: "You were removed from this group", timestamp: 1_700_000_000_004 }),
    ]).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [active({ profile, status: "removed", myKey: ME, members: members.filter(m => !m.me) })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual([
      "Agora você é o admin", "Você renomeou o grupo para “Ghost Club”", "Você alterou a foto do grupo", "Você removeu a foto do grupo", "Você foi removido deste grupo",
    ]);
  });

  it("says a fork or a removal with the core's own reason in the app's language", () => {
    fakeEngine.on("groupMessages", () => [
      stored({ id: "e1", event: "forked", text: "Member 3r69cgd5 holds a different membership history for epoch 4. Membership changes are halted; the admin must re-form the group." }),
      stored({ id: "e2", event: "forked", text: "The admin signed two different changes after epoch 5. Membership changes are halted; the admin must re-form the group.", timestamp: 1_700_000_000_001 }),
      stored({ id: "e3", event: "removed", text: "Removed by a reason this app does not know", timestamp: 1_700_000_000_002 }),
    ]).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [active()] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    return screen.findAllByTestId("group-event").then(lines => expect(lines.map(l => l.textContent)).toEqual([
      "O histórico de membros se bifurcou", "O histórico de membros se bifurcou", "Você foi removido deste grupo",
    ]));
  });

  it("sends what is typed to the group", async () => {
    const { user, engine } = openGroup(active());
    engine.on("sendGroupMessage", () => ({ error: null }));
    await user.type(composer(), "dinner at eight{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "dinner at eight" }]);
    expect(composer()).toHaveValue("");
  });

  it("keeps the draft when the engine refuses it", async () => {
    const { user, engine } = openGroup(active());
    engine.on("sendGroupMessage", () => ({ error: "You are no longer in this group" }));
    await user.type(composer(), "anyone?{Enter}");
    expect(await screen.findByText("You are no longer in this group")).toBeInTheDocument();
    expect(composer()).toHaveValue("anyone?");
  });

  it("says why the engine refused it in the app's language", async () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
      .on("sendGroupMessage", () => ({ error: "This epoch's key has not arrived yet. Wait for a member to catch you up." }));
    fakeEngine.update({ groups: [active()] });
    const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    await user.type(composer(), "alguém?{Enter}");
    expect(await screen.findByText("A chave mais recente do grupo não chegou. Um membro vai te atualizar.")).toBeInTheDocument();
    expect(composer()).toHaveValue("alguém?");
  });
});

describe("GroupChat: the mark on a message of mine", () => {
  it("marks a message of mine sent, never delivered: a group has no receipts", async () => {
    const { user } = openGroup(active(), [stored({ id: "m3", sender: "me", member: ME, text: "hello" })]);
    const mark = await screen.findByTestId("message-delivery");
    expect(mark).toHaveAttribute("data-delivery", "unacked");
    expect(mark).toHaveAccessibleName("Sent");
    await user.click(mark);
    expect(screen.getByTestId("message-delivery-tip")).toHaveTextContent("Sent to the group. Groups have no receipts.");
  });
});
