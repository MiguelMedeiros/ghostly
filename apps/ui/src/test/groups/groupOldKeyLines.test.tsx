import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.edit, groups.remove-member

/*
 * Removed from a private group and invited back, I come in with a new member key: the group knows my lines from
 * before by the old one, and refuses their edits and deletions. Their ⋮ offers neither, and ↑ in an empty composer
 * edits my last line under the key I hold now. Before, both showed and looked done here while nobody got them.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const BEFORE = "before".padEnd(52, "y"), ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (): GroupView => groupView({ status: "active", epoch: 3, myKey: ME, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })] });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

const OLD = `${BEFORE}:1:0`, NOW = `${ME}:3:0`;
const old = stored({ id: OLD, text: "heron note 8812" });
const now = stored({ id: NOW, text: "egret note 4471", timestamp: 1_700_000_001_000 });

function openGroup(rows: StoredMessage[]) {
  fakeEngine.on("groupMessages", () => rows).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group()] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);

describe("my lines in a private group written under the key I had before I was invited back", () => {
  it("offer no Edit or Delete for everyone; my lines under the key I hold now still do", async () => {
    const { user } = openGroup([old, now]);
    await screen.findByText("heron note 8812");
    await user.click(within(row(OLD)!).getByTestId("message-options"));
    expect(screen.getByTestId("message-reply")).toBeInTheDocument();
    expect(screen.queryByTestId("message-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-delete-everyone")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(row(NOW)!).getByTestId("message-options"));
    expect(screen.getByTestId("message-edit")).toBeInTheDocument();
    expect(screen.getByTestId("message-delete-everyone")).toBeInTheDocument();
  });

  it("↑ in an empty composer edits nothing when my only lines are from before", async () => {
    const { user } = openGroup([old]);
    await screen.findByText("heron note 8812");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{ArrowUp}");
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
