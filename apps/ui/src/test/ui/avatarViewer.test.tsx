import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { AvatarOpener } from "../../components/AvatarViewer";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: profiles.picture.viewer

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PHOTO = "data:image/jpeg;base64,/9j/alice", GROUP_PICTURE = "data:image/jpeg;base64,/9j/group";
const viewer = () => screen.queryByTestId("avatar-viewer");
const Face = () => <img src={PHOTO} alt="" />;

/** A contact's or a group's picture, large: opened from an avatar, closed by Escape, a click outside or its button. */
describe("the picture viewer", () => {
  it("opens on a click, shows the picture as it arrived and the name, and gives the focus back on Escape", async () => {
    const { user } = renderApp(<AvatarOpener src={PHOTO} name="Alice" testId="opener"><Face /></AvatarOpener>);
    const opener = screen.getByRole("button", { name: "View photo of Alice" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Alice" });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByTestId("avatar-viewer-image")).toHaveAttribute("src", PHOTO);
    await user.keyboard("{Escape}");
    expect(viewer()).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("opens from the keyboard, and closes on a click outside the picture but not on it", async () => {
    const { user } = renderApp(<AvatarOpener src={PHOTO} name="Alice"><Face /></AvatarOpener>);
    await user.tab();
    const opener = screen.getByRole("button", { name: "View photo of Alice" });
    expect(opener).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(viewer()).toBeInTheDocument();
    await user.click(screen.getByTestId("avatar-viewer-image"));
    expect(viewer()).toBeInTheDocument();
    await user.click(screen.getByTestId("avatar-viewer-backdrop"));
    expect(viewer()).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(viewer()).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("has nothing to open without a picture: the initial is not a button", () => {
    renderApp(<AvatarOpener src={undefined} name="Alice"><span>A</span></AvatarOpener>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("closes when the picture goes while it is open, and a new one does not open by itself", async () => {
    const { user, rerender } = renderApp(<AvatarOpener src={PHOTO} name="Alice"><Face /></AvatarOpener>);
    await user.click(screen.getByRole("button", { name: "View photo of Alice" }));
    expect(viewer()).toBeInTheDocument();
    rerender(<AvatarOpener src={undefined} name="Alice"><span>A</span></AvatarOpener>);
    expect(viewer()).not.toBeInTheDocument();
    rerender(<AvatarOpener src={PHOTO} name="Alice"><Face /></AvatarOpener>);
    expect(viewer()).not.toBeInTheDocument();
  });

  it("opens from a chat's header with the contact's picture", async () => {
    const PEER = "peer".padEnd(52, "p");
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    act(() => { engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", peerNick: "Alice", peerAvatar: PHOTO })] }); });
    await user.click(await screen.findByRole("button", { name: "View photo of Alice" }));
    expect(within(screen.getByRole("dialog", { name: "Alice" })).getByTestId("avatar-viewer-image")).toHaveAttribute("src", PHOTO);
  });

  it("from a contact's identities panel, Escape closes the viewer and leaves the panel open", async () => {
    const onClose = vi.fn();
    fakeEngine.update({ links: [linkView({ peerAvatar: PHOTO })] });
    const { user } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "View photo of Alice" }));
    expect(viewer()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(viewer()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "View photo of Alice" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("in a contact's identities panel, no picture means no button", () => {
    fakeEngine.update({ links: [linkView()] });
    renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /View photo/ })).not.toBeInTheDocument();
  });

  describe("in a group", () => {
    const ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
    const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
    const group = (patch: Partial<GroupView> = {}) => groupView({ status: "active", members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" }), member({ key: BOB, nick: "Bob" })],
      memberLinks: { "link-1": ALICE }, ...patch });

    it("the header's avatar opens the group's picture; without one, it opens the members", async () => {
      fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
      fakeEngine.update({ groups: [group({ picture: GROUP_PICTURE })] });
      const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
      const opener = screen.getByRole("button", { name: "View photo of Friends" });
      await user.click(opener);
      expect(within(screen.getByRole("dialog", { name: "Friends" })).getByTestId("avatar-viewer-image")).toHaveAttribute("src", GROUP_PICTURE);
      await user.keyboard("{Escape}");
      expect(viewer()).not.toBeInTheDocument();
      expect(opener).toHaveFocus();

      act(() => { fakeEngine.update({ groups: [group()] }); });
      await user.click(screen.getByRole("button", { name: "Members" }));
      expect(viewer()).not.toBeInTheDocument();
      expect(screen.getByTestId("group-members-dialog")).toBeInTheDocument();
    });

    it("the members list opens a contact's picture and the group's, over the members, which stay open", async () => {
      fakeEngine.update({ groups: [group({ picture: GROUP_PICTURE })], links: [linkView({ peerPubKeyZ32: "alice-z32", peerAvatar: PHOTO })] });
      const onClose = vi.fn();
      const { user } = renderApp(<GroupMembersDialog group={group({ picture: GROUP_PICTURE })} onClose={onClose} />);
      const rows = screen.getAllByTestId("group-member");
      const row = (key: string) => rows.find(r => r.dataset.key === key)!;
      // Bob is not a contact: no picture, no button. Alice sent hers in our chat.
      expect(within(row(BOB)).queryByRole("button", { name: /View photo/ })).not.toBeInTheDocument();
      const alice = within(row(ALICE)).getByRole("button", { name: "View photo of Alice" });
      await user.click(alice);
      expect(within(screen.getByRole("dialog", { name: "Alice" })).getByTestId("avatar-viewer-image")).toHaveAttribute("src", PHOTO);
      await user.keyboard("{Escape}");
      expect(viewer()).not.toBeInTheDocument();
      expect(alice).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "View photo of Friends" }));
      expect(within(screen.getByTestId("avatar-viewer")).getByTestId("avatar-viewer-image")).toHaveAttribute("src", GROUP_PICTURE);
      await user.click(screen.getByTestId("avatar-viewer-backdrop"));
      expect(viewer()).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
