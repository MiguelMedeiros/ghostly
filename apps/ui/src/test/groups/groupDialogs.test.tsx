import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import type { GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { GroupLinkPanel } from "../../components/GroupLinkPanel";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { NewGroupDialog } from "../../components/NewGroupDialog";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { publicKeyLabel } from "../../lib/publicKeyLabel";

// covers: groups.create, groups.invite, groups.remove-member, groups.admin-change, groups.link.enable, groups.link.replace, groups.hubs

const ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const members = [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: ALICE, nick: "Alice", online: true }), member({ key: BOB, nick: "Bob", missing: 3 })];
const paired = (patch: Partial<LinkView>) => linkView({ profile: "paired-chat/1", groups: true, ...patch });

describe("GroupMembersDialog", () => {
  function members_(group: GroupView, links: LinkView[] = []) {
    const onClose = vi.fn();
    fakeEngine.update({ groups: [group], links });
    return { ...renderApp(<GroupMembersDialog group={group} onClose={onClose} />), onClose };
  }
  const rows = () => screen.getAllByTestId("group-member");
  const row = (key: string) => rows().find(r => r.dataset.key === key)!;

  it("lists the members with their role, whether they can be reached, and what they miss", () => {
    members_(groupView({ status: "active", epoch: 4, isAdmin: false, members: [member({ key: ME, me: true, online: true }), member({ key: ALICE, nick: "Alice", role: "admin", online: true }), member({ key: BOB, missing: 3 })] }));
    const dialog = screen.getByTestId("group-members-dialog");
    expect(within(dialog).getByRole("heading", { name: "Friends" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("3 members · epoch 4");
    expect(row(ME)).toHaveTextContent(/^You/);
    expect(row(ALICE)).toHaveAttribute("data-role", "admin");
    expect(within(row(ALICE)).getByText("admin")).toBeInTheDocument();
    expect(within(row(ALICE)).getByRole("img", { name: "reachable" })).toBeInTheDocument();
    expect(row(BOB)).toHaveTextContent(/^Member bobyyy/);
    expect(within(row(BOB)).getByRole("img", { name: "not reachable" })).toBeInTheDocument();
    expect(within(row(BOB)).getByText("3 missing")).toBeInTheDocument();
    expect(screen.getByTestId("group-read-note")).toHaveTextContent("Everyone in the group can read everything sent while they are a member.");
  });

  it("says an unnamed member's key once: in its name, not again beside it", () => {
    members_(groupView({ status: "active", isAdmin: false, members: [member({ key: ME, me: true, online: true }), member({ key: ALICE, nick: "Alice", online: true }), member({ key: BOB, role: "admin" })] }));
    const times = (key: string) => row(key).textContent!.split(publicKeyLabel(key)).length - 1;
    expect(row(BOB)).toHaveTextContent(/^Member bobyyy/);
    expect(times(BOB), "an unnamed member: its name is its key").toBe(1);
    expect(times(ALICE), "a named one: the key beside the name").toBe(1);
    expect(times(ME)).toBe(1);
  });

  it("gives a member no controls over others, and no invitations", () => {
    members_(groupView({ status: "active", isAdmin: false, members }), [paired({})]);
    expect(screen.queryByTestId("group-make-admin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-remove-member")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-invite-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-link")).not.toBeInTheDocument();
  });

  it("lets the admin promote or remove anyone but themselves", async () => {
    const { user, engine } = members_(groupView({ status: "active", isAdmin: true, members }));
    engine.on("makeGroupAdmin", () => undefined).on("removeGroupMember", () => undefined);
    expect(within(row(ME)).queryByRole("button")).not.toBeInTheDocument();
    await user.click(within(row(ALICE)).getByTestId("group-make-admin"));
    await user.click(within(row(BOB)).getByTestId("group-remove-member"));
    await user.click(screen.getByTestId("group-remove-confirm"));
    expect(engine.callsTo("makeGroupAdmin")).toEqual([{ groupId: "group-1", key: ALICE }]);
    expect(engine.callsTo("removeGroupMember")).toEqual([{ groupId: "group-1", key: BOB }]);
  });

  it("asks before removing a member, naming them; Cancel and Escape remove nobody and keep the list open", async () => {
    const { user, engine, onClose } = members_(groupView({ status: "active", isAdmin: true, members }));
    engine.on("removeGroupMember", () => undefined);
    await user.click(within(row(BOB)).getByTestId("group-remove-member"));
    const ask = screen.getByTestId("group-remove-dialog");
    expect(ask).toHaveAccessibleName("Remove Bob?");
    expect(ask).toHaveAccessibleDescription("They won't get the group's new messages.");
    expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(engine.callsTo("removeGroupMember")).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("group-remove-dialog")).not.toBeInTheDocument();
    await user.click(within(row(ALICE)).getByTestId("group-remove-member"));
    expect(screen.getByTestId("group-remove-dialog")).toHaveAccessibleName("Remove Alice?");
    // Escape, as the browser says it to the topmost dialog: only the question closes.
    act(() => { screen.getByTestId("group-remove-dialog").dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(screen.queryByTestId("group-remove-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-members-dialog")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(engine.callsTo("removeGroupMember")).toEqual([]);
  });

  it("says, while the group's link works, that whoever is removed can join again with it until a new link", async () => {
    for (const profile of ["mesh", "community"] as const) {
      const { user, unmount } = members_(groupView({ status: "active", isAdmin: true, profile, members, entryLink: "https://app.ghostly.tools/#/join/group2/g/k" }));
      await user.click(within(row(BOB)).getByTestId("group-remove-member"));
      expect(screen.getByTestId("group-remove-dialog"), profile).toHaveAccessibleDescription("They won't get the group's new messages. They can still join again with the group's link: a new link keeps them out.");
      unmount();
    }
  });

  it("past 16 members with hubs, marks the hubs, says who is reached through one, and lets the admin choose", async () => {
    const many = Array.from({ length: 15 }, (_, i) => member({ key: `m${i}`.padEnd(52, "y"), viaHub: true, online: true }));
    const hub = member({ key: ALICE, nick: "Alice", online: true, hub: true, hubRole: "pin", edge: { linkId: "e1", state: "open", lastSeenAt: 1 } });
    const { user, engine } = members_(groupView({ status: "active", isAdmin: true, hubs: { hub: false }, members: [members[0], hub, member({ key: BOB, nick: "Bob", hubRole: "exclude" }), ...many] }));
    engine.on("setGroupHub", () => undefined);
    expect(within(row(ALICE)).getByTestId("group-member-hub")).toHaveTextContent("hub");
    expect(within(row(BOB)).queryByTestId("group-member-hub")).not.toBeInTheDocument();
    const reached = row(many[0].key);
    expect(within(reached).getByTestId("group-member-status")).toHaveTextContent("Through a hub");
    expect(within(reached).getByRole("img", { name: "reachable" })).toHaveClass("bg-accent");
    expect(within(row(ALICE)).getByTestId("group-member-hub-role")).toHaveTextContent("Always a hub");
    expect(within(row(BOB)).getByTestId("group-member-hub-role")).toHaveTextContent("Never a hub");
    await user.click(within(reached).getByTestId("group-member-hub-role"));
    await user.click(screen.getByRole("option", { name: "Always a hub" }));
    await user.click(within(row(ALICE)).getByTestId("group-member-hub-role"));
    await user.click(screen.getByRole("option", { name: "Hub if always on" }));
    expect(engine.callsTo("setGroupHub")).toEqual([{ groupId: "group-1", key: many[0].key, role: "pin" }, { groupId: "group-1", key: ALICE, role: null }]);
  });

  it("offers no hub choice in a group of 16 or fewer", () => {
    members_(groupView({ status: "active", isAdmin: true, members }));
    expect(screen.queryByTestId("group-member-hub-role")).not.toBeInTheDocument();
  });

  it("shows what the engine refused", async () => {
    const { user, engine } = members_(groupView({ status: "active", isAdmin: true, members }));
    engine.on("removeGroupMember", () => { throw new Error("Bob is not reachable"); });
    await user.click(within(row(BOB)).getByTestId("group-remove-member"));
    await user.click(screen.getByTestId("group-remove-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bob is not reachable");
  });

  it("follows the engine's roster while open", () => {
    const group = groupView({ status: "active", isAdmin: true, members });
    members_(group);
    expect(rows()).toHaveLength(3);
    act(() => fakeEngine.update({ groups: [{ ...group, members: members.slice(0, 2) }] }));
    expect(rows()).toHaveLength(2);
  });

  it("invites contacts whose apps can do groups, and says why the others cannot be", async () => {
    const group = groupView({ status: "active", isAdmin: true, members, invited: ["link-pending"], memberLinks: { "link-alice": ALICE } });
    const { user, engine } = members_(group, [
      paired({ id: "link-carol", label: "Carol" }),
      paired({ id: "link-pending", peerNick: "Dan" }),
      paired({ id: "link-old", peerNick: "Erin", groups: false, dataLink: "open" }),
      paired({ id: "link-away", peerNick: "Frank", groups: false, dataLink: "idle" }),
      paired({ id: "link-alice", peerNick: "Alice" }),
      linkView({ id: "link-legacy", peerNick: "Legacy" }),
    ]);
    engine.on("inviteToGroup", () => undefined);
    const contacts = screen.getAllByTestId("group-invite-contact");
    // Members and chats without the paired profile are not offered.
    expect(contacts.map(c => c.dataset.link)).toEqual(["link-carol", "link-pending", "link-old", "link-away"]);
    expect(contacts[1]).toHaveTextContent("Invited…");
    expect(contacts[2]).toHaveTextContent("Needs an updated Ghostly");
    expect(contacts[3]).toHaveTextContent("Not connected");
    expect(screen.getAllByTestId("group-invite")).toHaveLength(1);
    await user.click(within(contacts[0]).getByTestId("group-invite"));
    expect(engine.callsTo("inviteToGroup")).toEqual([{ groupId: "group-1", linkId: "link-carol" }]);
  });

  it("names an unnamed contact by their key", () => {
    members_(groupView({ status: "active", isAdmin: true, members }), [paired({ id: "link-x", peerPubKeyZ32: "k".repeat(52) })]);
    expect(screen.getByTestId("group-invite-contact")).toHaveTextContent("Contact · kkkkkk");
  });

  it("invites nobody once members and invitations make 32", () => {
    const most = Array.from({ length: 31 }, (_, i) => member({ key: String(i).padEnd(52, "y"), me: i === 0 }));
    members_(groupView({ status: "active", isAdmin: true, members: most, invited: ["link-pending"] }), [paired({ id: "link-carol" }), paired({ id: "link-pending" })]);
    expect(screen.getByTestId("group-invite")).toBeDisabled();
  });

  it("says when there is nobody left to invite", () => {
    members_(groupView({ status: "active", isAdmin: true, members }));
    expect(screen.getByText("Every paired contact is already in, or you have none yet.")).toBeInTheDocument();
  });

  it("offers no invitations once the admin is out of the group", () => {
    members_(groupView({ status: "removed", isAdmin: true, members }), [paired({})]);
    expect(screen.getByTestId("group-members-dialog")).toHaveTextContent("3 members · removed");
    expect(screen.queryByTestId("group-invite-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-link")).not.toBeInTheDocument();
  });

  it("closes from its button", async () => {
    const { user, onClose } = members_(groupView({ status: "active", members }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("GroupLinkPanel", () => {
  // A link decodes only with a real group id (22 characters) and a real entry key.
  const id = "AbCdEfGhIjKlMnOpQrStUv";
  const entryLink = encodeGroupEntryLink({ g: id, host: createIdentity().pubKeyZ32 });
  const admin = (patch: Partial<GroupView> = {}) => groupView({ id, status: "active", isAdmin: true, members, ...patch });

  it("creates the group's link", async () => {
    const { user, engine } = renderApp(<GroupLinkPanel group={admin()} />);
    engine.on("enableGroupLink", () => ({ link: entryLink }));
    expect(screen.getByText(/The link is off: nobody can join with it/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn on the link" }));
    expect(engine.callsTo("enableGroupLink")).toEqual([{ groupId: id }]);
  });

  it("cannot create a link for a full group", () => {
    const full = Array.from({ length: 32 }, (_, i) => member({ key: String(i).padEnd(52, "y") }));
    renderApp(<GroupLinkPanel group={admin({ members: full })} />);
    expect(screen.getByTestId("group-link-enable")).toHaveTextContent("The group is full");
    expect(screen.getByTestId("group-link-enable")).toBeDisabled();
  });

  it("shows the link as an address of this app, to copy", async () => {
    const { user } = renderApp(<GroupLinkPanel group={admin({ entryLink })} />);
    const url = screen.getByRole("textbox", { name: "Group link" });
    expect(url).toHaveValue(`${window.location.origin}/#/join/${entryLink}`);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByTestId("group-link-copy"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/join/${entryLink}`);
    expect(screen.getByTestId("group-link-copy")).toHaveTextContent("Copied");
  });

  it("says when copying did not work", async () => {
    const { user } = renderApp(<GroupLinkPanel group={admin({ entryLink })} />);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByTestId("group-link-copy"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copy did not work. Select the link and copy it.");
  });

  it("warns that nobody gets in while the group is full", () => {
    const full = Array.from({ length: 32 }, (_, i) => member({ key: String(i).padEnd(52, "y") }));
    renderApp(<GroupLinkPanel group={admin({ entryLink, members: full })} />);
    expect(screen.getByTestId("group-link-note")).toHaveTextContent("The group is full (32 of 32): nobody gets in through the link until someone leaves.");
  });

  it("replaces the link, or turns it off", async () => {
    const { user, engine } = renderApp(<GroupLinkPanel group={admin({ entryLink })} />);
    engine.on("enableGroupLink", () => ({ link: entryLink })).on("disableGroupLink", () => undefined);
    await user.click(screen.getByTestId("group-link-reset"));
    await user.click(screen.getByTestId("group-link-disable"));
    expect(engine.callsTo("enableGroupLink")).toEqual([{ groupId: id, reset: true }]);
    expect(engine.callsTo("disableGroupLink")).toEqual([{ groupId: id }]);
  });

  it("shows and hides the QR", async () => {
    const { user } = renderApp(<GroupLinkPanel group={admin({ entryLink })} />);
    const toggle = screen.getByRole("button", { name: "Show QR" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Hide QR" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows what the engine refused", async () => {
    const { user, engine } = renderApp(<GroupLinkPanel group={admin({ entryLink })} />);
    engine.on("disableGroupLink", () => { throw new Error("Only the admin can do that"); });
    await user.click(screen.getByTestId("group-link-disable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the admin can do that");
  });

  it("offers to create a link when the stored one does not read as a link", () => {
    renderApp(<GroupLinkPanel group={admin({ entryLink: "group1/garbage" })} />);
    expect(screen.getByTestId("group-link-enable")).toBeInTheDocument();
    expect(screen.queryByTestId("group-link-url")).not.toBeInTheDocument();
  });
});

describe("NewGroupDialog", () => {
  function open() {
    const onClose = vi.fn(), onCreated = vi.fn();
    return { ...renderApp(<NewGroupDialog onClose={onClose} onCreated={onCreated} />), onClose, onCreated };
  }

  it("creates a group under the name typed, trimmed", async () => {
    const { user, engine, onCreated } = open();
    engine.on("createGroup", () => ({ groupId: "new-group" }));
    const create = screen.getByTestId("new-group-create");
    expect(screen.getByTestId("new-group-name")).toHaveFocus();
    expect(create).toBeDisabled();
    await user.type(screen.getByTestId("new-group-name"), "   ");
    expect(create).toBeDisabled();
    await user.type(screen.getByTestId("new-group-name"), "Climbing  {Enter}");
    // A community is what a new group is unless the person picks Private.
    expect(engine.callsTo("createGroup")).toEqual([{ name: "Climbing", profile: "community" }]);
    expect(onCreated).toHaveBeenCalledWith("new-group");
  });

  it("makes a private group (up to 32, contacts or a link) when that kind is picked", async () => {
    const { user, engine, onCreated } = open();
    engine.on("createGroup", () => ({ groupId: "small" }));
    expect(screen.getByTestId("new-group-kind-community").querySelector("input")).toBeChecked();
    await user.click(screen.getByTestId("new-group-kind-mesh"));
    expect(screen.getByTestId("new-group-kind-mesh").querySelector("input")).toBeChecked();
    await user.type(screen.getByTestId("new-group-name"), "Family{Enter}");
    expect(engine.callsTo("createGroup")).toEqual([{ name: "Family", profile: "mesh" }]);
    expect(onCreated).toHaveBeenCalledWith("small");
  });

  it("shows why a group could not be created, and lets the user try again", async () => {
    const { user, engine, onCreated } = open();
    engine.on("createGroup", () => { throw new Error("Ghostly is still starting"); });
    await user.type(screen.getByTestId("new-group-name"), "Climbing");
    await user.click(screen.getByTestId("new-group-create"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ghostly is still starting");
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-group-create")).toBeEnabled();
  });

  it("on an app with no WebRTC, creates the group: its links go over Iroh or HyperDHT", async () => {
    // Ghostly Desktop on Linux (WISP 9xx § Transports): no WebRTC, but native transports carry its group links.
    const { user, engine } = open();
    act(() => engine.update({ transport: { protocol: "webrtc/1", relays: [], webrtc: false } }));
    expect(screen.queryByTestId("new-group-no-webrtc")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("new-group-name"), "Climbing");
    expect(screen.getByTestId("new-group-create")).toBeEnabled();
  });

  it("on an app with no transport for group links, says before creating that no member could be reached from here", async () => {
    // No WebRTC and no native transport: a group made here gets a link whose knocks this app sees but can never let
    // in (the joiner waits at "A member is letting you in" for good).
    const { user, engine, onCreated } = open();
    act(() => engine.update({ transport: { protocol: "webrtc/1", relays: [], webrtc: false, groupLinks: false } }));
    expect(screen.getByTestId("new-group-no-webrtc")).toHaveTextContent("this app has neither");
    await user.type(screen.getByTestId("new-group-name"), "Climbing");
    expect(screen.getByTestId("new-group-create")).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(engine.callsTo("createGroup")).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("cancels", async () => {
    const { user, engine, onClose } = open();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(engine.callsTo("createGroup")).toEqual([]);
  });
});
