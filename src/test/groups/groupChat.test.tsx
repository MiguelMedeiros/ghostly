import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupJoinStage, GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

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
    expect(screen.getByTestId("group-members")).toHaveTextContent("1 member · 0 of 0 reachable");
  });

  it("says who invited me while it is an invitation", () => {
    openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: ALICE, members: 3, accepted: false } }));
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", "invitation");
    expect(screen.getByTestId("group-members")).toHaveTextContent("Invitation from Alice");
    expect(composer()).toBeDisabled();
  });

  it("says an invitation came from a contact when it does not know their name", () => {
    openGroup(groupView({ canSend: false, invitation: { linkId: "link-1", contact: "", admin: ALICE, members: 3, accepted: true } }));
    expect(screen.getByTestId("group-members")).toHaveTextContent("Invitation from a contact");
  });

  it("says the group is gone when this device does not have it", () => {
    openGroup(null);
    expect(screen.getByText("This group is gone from this device.")).toBeInTheDocument();
  });
});

describe("GroupChat: joining through a link", () => {
  const viaLink = (admin: string) => groupView({ canSend: false, invitation: { linkId: "", contact: "", admin, members: 0, accepted: true, viaLink: true } });

  it("waits for the admin's app, and says it can be left alone", () => {
    openGroup(viaLink(""));
    expect(screen.getByTestId("group-members")).toHaveTextContent("Joining through a link");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("Waiting to be let in");
    expect(screen.getByTestId("group-joining")).toHaveTextContent("Waiting for the admin's app to let you in");
    // Nothing to write until the group lets you in: no composer at all.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
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
    ["knocked", "", "Waiting for the admin's app to let you in", ["done", "current", "todo", "todo"]],
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
    expect(await screen.findByTestId("group-connecting")).toHaveTextContent("Connecting to the members");
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
    ["removed", "You were removed from this group"],
    ["left", "You left this group"],
    ["forked", "The membership history forked. Membership changes are halted; the admin must re-form the group."],
  ] as const)("says why when %s, and cannot send", async (status, reason) => {
    const { user } = openGroup(active({ status, statusReason: reason, canSend: false }));
    expect(screen.getByTestId("group-chat")).toHaveAttribute("data-status", status);
    expect(screen.getByTestId("group-notice")).toHaveTextContent(reason);
    expect(screen.getByTestId("group-members")).toHaveTextContent(reason);
    expect(composer()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    // Nothing to leave; only forgetting it here is left.
    await user.click(screen.getByTestId("group-options"));
    expect(screen.queryByTestId("group-leave")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-forget")).toBeInTheDocument();
  });

  it("names the status when the engine gave no reason", () => {
    openGroup(active({ status: "left", canSend: false }));
    expect(screen.getByTestId("group-members")).toHaveTextContent("left");
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

  it("deletes the group from this device only after confirming", async () => {
    const { user, engine } = openGroup(active());
    engine.on("forgetGroup", () => undefined);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Friends")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(engine.callsTo("forgetGroup")).toEqual([]);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete chat" }));
    expect(engine.callsTo("forgetGroup")).toEqual([{ groupId: "group-1" }]);
    expect(screen.getByText("Chat list")).toBeInTheDocument();
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

  it("leaves, and goes back to the chat list: the group is gone from it", async () => {
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => undefined);
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(engine.callsTo("leaveGroup")).toEqual([{ groupId: "group-1" }]);
    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });

  it("stays, and says why, when the engine refuses", async () => {
    const { user, engine } = openGroup(active());
    engine.on("leaveGroup", () => { throw new Error("Nobody is online to take over"); });
    const dialog = await leaveFromMenu(user);
    await user.click(within(dialog).getByTestId("group-leave-confirm"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nobody is online to take over");
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

  it("keeps the admin from leaving while no member is online to take over", async () => {
    const { user } = openGroup(adminOf([member({ key: BOB, nick: "Bob" })]));
    const dialog = await leaveFromMenu(user);
    expect(dialog).toHaveTextContent("nobody else in the group is online to take over");
    expect(within(dialog).queryByTestId("group-leave-successor")).not.toBeInTheDocument();
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
});
