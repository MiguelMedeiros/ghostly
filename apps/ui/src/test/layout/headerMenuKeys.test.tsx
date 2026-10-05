import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.menus, app.keyboard, groups.leave

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const members: GroupMemberView[] = [
  { key: ME, role: "admin", me: true, online: true, missing: 0 },
  { key: ALICE, role: "member", me: false, nick: "Alice", online: true, missing: 0 },
];

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

function openGroup(group: GroupView = groupView({ id: ID, status: "active", epoch: 1, isAdmin: true, members })) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: `/group/${ID}` });
}

const rows = (menu: string) => [...screen.getByTestId(menu).querySelectorAll<HTMLElement>("[data-menu-item]:not(:disabled)")];

describe("a chat's and a group's ⋮ with the keys", () => {
  for (const [what, open, button, menu] of [
    ["a chat", openChat, "chat-options", "chat-options-menu"],
    ["a group", () => openGroup(), "group-options", "group-options-menu"],
  ] as const) {
    it(`${what}: Enter or Space moves the focus to the first row, the arrows between rows, and ↓ on ⋮ opens it too`, async () => {
      const { user } = open();
      const options = await screen.findByTestId(button);
      for (const key of ["{Enter}", " ", "{ArrowDown}"]) {
        options.focus();
        await user.keyboard(key);
        expect(screen.getByTestId(menu)).toBeInTheDocument();
        const list = rows(menu);
        expect(list.length).toBeGreaterThan(1);
        expect(document.activeElement, key).toBe(list[0]);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(list[1]);
        await user.keyboard("{Escape}");
        expect(screen.queryByTestId(menu)).not.toBeInTheDocument();
        expect(document.activeElement).toBe(options);
      }
    });
  }
});

describe("a group's dialogs give the focus back as they close", () => {
  const cancel = (id: string) => act(() => { screen.getByTestId(id).dispatchEvent(new Event("cancel", { cancelable: true })); });

  it("Members, from ⋮: back on ⋮, by Escape or by its ✕", async () => {
    const { user } = openGroup();
    const options = await screen.findByTestId("group-options");
    for (const how of ["escape", "close"] as const) {
      options.focus();
      await user.keyboard("{Enter}");
      screen.getByRole("button", { name: "Members…" }).focus();
      await user.keyboard("{Enter}");
      const dialog = screen.getByTestId("group-members-dialog");
      if (how === "escape") cancel("group-members-dialog");
      else await user.click(screen.getAllByRole("button", { name: "Close" }).find(b => dialog.contains(b))!);
      expect(screen.queryByTestId("group-members-dialog")).not.toBeInTheDocument();
      expect(document.activeElement, how).toBe(options);
    }
  });

  it("Members, from the header: back on the header's button", async () => {
    const { user } = openGroup();
    const header = await screen.findByTestId("group-members");
    await user.click(header);
    cancel("group-members-dialog");
    expect(document.activeElement).toBe(header);
  });

  it("Leave, cancelled: back on ⋮, by Escape or by Cancel", async () => {
    const { user } = openGroup();
    const options = await screen.findByTestId("group-options");
    for (const how of ["escape", "cancel"] as const) {
      options.focus();
      await user.keyboard("{Enter}");
      screen.getByTestId("group-leave").focus();
      await user.keyboard("{Enter}");
      expect(screen.getByTestId("group-leave-dialog")).toContainElement(document.activeElement as HTMLElement);
      if (how === "escape") cancel("group-leave-dialog");
      else await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByTestId("group-leave-dialog")).not.toBeInTheDocument();
      expect(document.activeElement, how).toBe(options);
    }
  });
});
