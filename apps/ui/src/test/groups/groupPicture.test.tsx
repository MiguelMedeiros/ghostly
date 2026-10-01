import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MAX_GROUP_PICTURE_LENGTH } from "@ghostly/core";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { GroupShareDialog } from "../../components/GroupLinkPanel";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.picture.set

// The canvas work is the browser's (jsdom has none): the file becomes this, as `avatarFromFile` makes it.
const avatarFromFile = vi.hoisted(() => vi.fn(async () => "data:image/jpeg;base64,/9j/picked"));
vi.mock("../../lib/avatarImage", () => ({ avatarFromFile }));

const PICTURE = "data:image/jpeg;base64,/9j/shown";
const ALICE = "alice".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const admin = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: true, members: [member({ key: ME, me: true, role: "admin" }), member({ key: ALICE, nick: "Alice" })], ...patch });
const notAdmin = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: false, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })], ...patch });
const picture = (testId: string) => screen.getByTestId(testId);

describe("a group's picture in the app", () => {
  it("the admin adds one from a file, made small for a group, and removes it", async () => {
    fakeEngine.update({ groups: [admin()] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin()} onClose={() => {}} />);
    engine.on("setGroupPicture", () => undefined);
    expect(picture("group-members-avatar")).toHaveAttribute("data-picture", "none");
    expect(screen.getByText("Add a picture")).toBeInTheDocument();
    expect(screen.queryByTestId("group-picture-remove")).not.toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], "cat.png", { type: "image/png" });
    await user.upload(screen.getByTestId("group-picture-input"), file);
    await waitFor(() => expect(engine.callsTo("setGroupPicture")).toEqual([{ groupId: "group-1", picture: "data:image/jpeg;base64,/9j/picked" }]));
    expect(avatarFromFile).toHaveBeenCalledWith(file, MAX_GROUP_PICTURE_LENGTH);

    // The engine now says it has one.
    fakeEngine.update({ groups: [admin({ picture: PICTURE })] });
    await waitFor(() => expect(picture("group-members-avatar")).toHaveAttribute("data-picture", "set"));
    expect(picture("group-members-avatar").querySelector("img")).toHaveAttribute("src", PICTURE);
    expect(screen.getByText("Change picture")).toBeInTheDocument();
    await user.click(screen.getByTestId("group-picture-remove"));
    expect(engine.callsTo("setGroupPicture").slice(-1)[0]).toEqual({ groupId: "group-1", picture: null });
  });

  it("says what the engine refused", async () => {
    fakeEngine.update({ groups: [admin()] });
    const { user, engine } = renderApp(<GroupMembersDialog group={admin()} onClose={() => {}} />);
    engine.on("setGroupPicture", () => { throw new Error("Only the admin can change the group's picture"); });
    await user.upload(screen.getByTestId("group-picture-input"), new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the admin can change the group's picture");
  });

  it("a member sees it and cannot change it", () => {
    fakeEngine.update({ groups: [notAdmin({ picture: PICTURE })] });
    renderApp(<GroupMembersDialog group={notAdmin({ picture: PICTURE })} onClose={() => {}} />);
    expect(picture("group-members-avatar")).toHaveAttribute("data-picture", "set");
    expect(screen.queryByTestId("group-picture-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-picture-remove")).not.toBeInTheDocument();
  });

  it("shows in the chat list, the header and the share screen; the group glyph when there is none", () => {
    fakeEngine.update({ groups: [notAdmin({ picture: PICTURE }), notAdmin({ id: "group-2", name: "Plain" })] });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const rows = screen.getAllByTestId("group-row");
    const avatarOf = (id: string) => within(rows.find(r => r.dataset.group === id)!).getByTestId("group-row-avatar");
    expect(avatarOf("group-1")).toHaveAttribute("data-picture", "set");
    expect(avatarOf("group-1").querySelector("img")).toHaveAttribute("src", PICTURE);
    expect(avatarOf("group-2")).toHaveAttribute("data-picture", "none");
    expect(avatarOf("group-2").querySelector("svg")).toBeInTheDocument();
  });

  it("in the header, and a line when someone changes or removes it, named as the roster knows them", async () => {
    const history: StoredMessage[] = [
      { linkId: "group:group-1", id: "e1", text: "Member aliceyyy changed the group's picture", sender: "peer", event: "picture", member: ALICE, timestamp: 1, via: "datalink" },
      { linkId: "group:group-1", id: "e2", text: "Member aliceyyy removed the group's picture", sender: "peer", event: "picture", member: ALICE, timestamp: 2, via: "datalink" },
    ];
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [notAdmin({ picture: PICTURE })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(picture("group-avatar")).toHaveAttribute("data-picture", "set");
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual(["Alice changed the group's picture", "Alice removed the group's picture"]);
  });

  it("on the share screen", () => {
    renderApp(<GroupShareDialog group={notAdmin({ picture: PICTURE, profile: "community", entryLink: `group2/${"A".repeat(22)}/${ALICE}` })} onClose={() => {}} />);
    expect(picture("group-share-avatar").querySelector("img")).toHaveAttribute("src", PICTURE);
  });
});
