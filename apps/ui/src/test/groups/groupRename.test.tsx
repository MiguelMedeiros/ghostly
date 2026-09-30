import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.rename

const ALICE = "alice".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const admin = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: true, members: [member({ key: ME, me: true, role: "admin" }), member({ key: ALICE, nick: "Alice" })], ...patch });
const notAdmin = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: false, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })], ...patch });

describe("renaming a group in the app", () => {
  it("the admin renames it from the members panel; the new name shows once the engine has it", async () => {
    fakeEngine.update({ groups: [admin({ name: "Friends" })] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin({ name: "Friends" })} onClose={() => {}} />);
    engine.on("renameGroup", () => undefined);
    await user.click(screen.getByTestId("group-rename"));
    const input = screen.getByTestId("group-rename-input");
    expect(input).toHaveValue("Friends");
    expect(input).toHaveFocus();
    await user.clear(input);
    expect(screen.getByTestId("group-rename-save")).toBeDisabled();
    await user.type(input, "Book club{Enter}");
    await waitFor(() => expect(engine.callsTo("renameGroup")).toEqual([{ groupId: "group-1", name: "Book club" }]));
    fakeEngine.update({ groups: [admin({ name: "Book club" })] });
    expect(await screen.findByTestId("group-members-name")).toHaveTextContent("Book club");
  });

  it("the same name is no call; Escape and Cancel keep the name", async () => {
    fakeEngine.update({ groups: [admin({ name: "Friends" })] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin({ name: "Friends" })} onClose={() => {}} />);
    engine.on("renameGroup", () => undefined);
    await user.click(screen.getByTestId("group-rename"));
    await user.click(screen.getByTestId("group-rename-save"));
    expect(screen.getByTestId("group-members-name")).toHaveTextContent("Friends");
    await user.click(screen.getByTestId("group-rename"));
    await user.type(screen.getByTestId("group-rename-input"), " and more{Escape}");
    expect(screen.getByTestId("group-members-name")).toHaveTextContent("Friends");
    await user.click(screen.getByTestId("group-rename"));
    await user.click(screen.getByTestId("group-rename-cancel"));
    expect(engine.callsTo("renameGroup")).toEqual([]);
  });

  it("says what the engine refused, and keeps what was typed", async () => {
    fakeEngine.update({ groups: [admin()] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin()} onClose={() => {}} />);
    engine.on("renameGroup", () => { throw new Error("A group's name is 1 to 64 characters"); });
    await user.click(screen.getByTestId("group-rename"));
    await user.type(screen.getByTestId("group-rename-input"), "‮{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 64 characters");
    expect(screen.getByTestId("group-rename-input")).toBeInTheDocument();
  });

  it("a member cannot rename it", () => {
    fakeEngine.update({ groups: [notAdmin()] });
    renderApp(<GroupMembersDialog group={notAdmin()} onClose={() => {}} />);
    expect(screen.queryByTestId("group-rename")).not.toBeInTheDocument();
  });

  it("the new name in the chat list, and a line naming who renamed it as the roster knows them", async () => {
    fakeEngine.update({ groups: [notAdmin({ name: "Book club" })] });
    const { unmount } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(within(screen.getAllByTestId("group-row").find(r => r.dataset.group === "group-1")!).getByText("Book club")).toBeInTheDocument();
    unmount();

    const history: StoredMessage[] = [
      { linkId: "group:group-1", id: "e1", text: "Member aliceyyy renamed the group to “Book club”", sender: "peer", event: "renamed", member: ALICE, timestamp: 1, via: "datalink" },
    ];
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(screen.getByTestId("group-name")).toHaveTextContent("Book club");
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual(["Alice renamed the group to “Book club”"]);
  });
});
