import { screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { markGroupRead } from "../../lib/groups";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.invite, groups.create

const member = (key: string): GroupMemberView => ({ key: key.padEnd(52, "y"), role: "member", me: false, online: true, missing: 0 });
const invitation = (patch: Partial<NonNullable<GroupView["invitation"]>> = {}) =>
  groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: "a".padEnd(52, "y"), members: 3, accepted: false, ...patch } });

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** The chat list with these groups in it, and where the router is. */
function sidebar(groups: GroupView[]) {
  fakeEngine.update({ groups });
  return renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>);
}
const row = (id = "group-1") => screen.getAllByTestId("group-row").find(r => r.dataset.group === id)!;

describe("Sidebar: groups in the chat list", () => {
  it("shows an invitation with who sent it and how big the group is, to accept", async () => {
    const { user, engine } = sidebar([invitation()]);
    engine.on("acceptGroupInvitation", () => undefined);
    expect(row()).toHaveTextContent("Invited by Alice · 3 members");
    await user.click(within(row()).getByTestId("group-accept"));
    expect(engine.callsTo("acceptGroupInvitation")).toEqual([{ groupId: "group-1" }]);
    // Answering does not open the group.
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("declines an invitation", async () => {
    const { user, engine } = sidebar([invitation({ contact: "", members: 1 })]);
    engine.on("declineGroupInvitation", () => undefined);
    expect(row()).toHaveTextContent("Invited by a contact · 1 member");
    await user.click(within(row()).getByTestId("group-decline"));
    expect(engine.callsTo("declineGroupInvitation")).toEqual([{ groupId: "group-1" }]);
  });

  it("keeps the invitation's buttons after an answer the engine refused", async () => {
    const { user, engine } = sidebar([invitation()]);
    engine.on("acceptGroupInvitation", () => { throw new Error("The admin is gone"); });
    await user.click(within(row()).getByTestId("group-accept"));
    expect(within(row()).getByTestId("group-accept")).toBeEnabled();
  });

  it.each([
    ["an accepted invitation", invitation({ accepted: true }), "Joining…"],
    ["a link waiting for the admin", invitation({ accepted: true, viaLink: true, admin: "" }), "Waiting for the admin's app…"],
    ["a link the admin answered", invitation({ accepted: true, viaLink: true }), "Joining…"],
  ])("says it is joining for %s, with nothing to answer", (_, group, status) => {
    sidebar([group]);
    expect(row()).toHaveTextContent(status);
    expect(within(row()).queryByTestId("group-accept")).not.toBeInTheDocument();
    expect(within(row()).queryByTestId("group-decline")).not.toBeInTheDocument();
  });

  it("counts a group's members, and says why a group I am out of is over", () => {
    sidebar([
      groupView({ id: "g-active", name: "Climbing", status: "active", members: [member("a"), member("b")] }),
      groupView({ id: "g-removed", name: "Old", status: "removed", statusReason: "You were removed from this group" }),
      groupView({ id: "g-left", name: "", status: "left" }),
    ]);
    expect(row("g-active")).toHaveTextContent("Climbing2 members");
    expect(row("g-removed")).toHaveTextContent("You were removed from this group");
    expect(row("g-left")).toHaveTextContent("A groupleft");
  });

  it("opens a group", async () => {
    const { user } = sidebar([groupView({ status: "active" })]);
    await user.click(row());
    expect(screen.getByTestId("where")).toHaveTextContent("/group/group-1");
  });

  it("marks a group with messages newer than when it was last read", () => {
    markGroupRead("g-read", 2_000);
    sidebar([
      groupView({ id: "g-new", status: "active", lastMessageAt: 1_000 }),
      groupView({ id: "g-read", status: "active", lastMessageAt: 1_000 }),
    ]);
    expect(within(row("g-new")).getByText("Friends")).toHaveClass("font-semibold");
    expect(within(row("g-read")).getByText("Friends")).not.toHaveClass("font-semibold");
  });

  it("finds groups by name", async () => {
    const { user } = sidebar([groupView({ id: "g-a", name: "Climbing", status: "active" }), groupView({ id: "g-b", name: "Chess", status: "active" })]);
    await user.type(screen.getByPlaceholderText("Search chats..."), "clim");
    expect(screen.getAllByTestId("group-row").map(r => r.dataset.group)).toEqual(["g-a"]);
  });

  it("creates a group from New, and opens it", async () => {
    const { user, engine } = sidebar([]);
    engine.on("createGroup", () => ({ groupId: "fresh" }));
    await user.click(screen.getByTestId("sidebar-new-more"));
    await user.click(screen.getByTestId("new-group"));
    await user.type(screen.getByTestId("new-group-name"), "Book club{Enter}");
    expect(engine.callsTo("createGroup")).toEqual([{ name: "Book club" }]);
    expect(await screen.findByText("/group/fresh")).toBeInTheDocument();
    expect(screen.queryByTestId("new-group-dialog")).not.toBeInTheDocument();
  });
});
