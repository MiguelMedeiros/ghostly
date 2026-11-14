import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.replies, groups.edit, groups.remove-member

/*
 * A group that no longer takes my messages (I was removed, or left on another device) offers no Reply, as it offers no
 * Edit or React, and a reply or edit bar open when that came closes: the composer under it is off. The draft stays in
 * the field. A group still active whose composer is off for a moment (a join or removal past 16 members) keeps them.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (patch: Partial<GroupView> = {}): GroupView => groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })], ...patch });
const removed = (): GroupView => group({ status: "removed", canSend: false, statusReason: "You were removed from this group" });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

const LUNCH = `${ALICE}:1:0`, MINE = `${ME}:1:0`;
const lunch = stored({ id: LUNCH, text: "lunch at noon?", member: ALICE });
const mine = stored({ id: MINE, text: "heron note 8812", sender: "me", timestamp: 1_700_000_001_000 });

function openGroup(view: GroupView = group()) {
  fakeEngine.on("groupMessages", () => [lunch, mine]).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }));
  fakeEngine.update({ groups: [view] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const becomes = (view: GroupView) => act(() => fakeEngine.update({ groups: [view] }));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
const field = () => screen.getByRole<HTMLTextAreaElement>("textbox");

describe("a group's bars when it no longer takes my messages", () => {
  it("removed with the reply bar open: the bar closes and the draft stays", async () => {
    const { user } = openGroup();
    await screen.findByText("lunch at noon?");
    await user.click(within(row(LUNCH)!).getByTestId("message-reply-action"));
    expect(screen.getByTestId("composer-reply")).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "my words" } });

    becomes(removed());
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(field()).toHaveValue("my words");
  });

  it("removed while editing: the edit ends", async () => {
    const { user } = openGroup();
    await screen.findByText("heron note 8812");
    await user.click(within(row(MINE)!).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();

    becomes(removed());
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
  });

  it("a removed member is offered no Reply, from the row or its ⋮", async () => {
    const { user } = openGroup(removed());
    await screen.findByText("lunch at noon?");
    expect(within(row(LUNCH)!).queryByTestId("message-reply-action")).not.toBeInTheDocument();
    await user.click(within(row(LUNCH)!).getByTestId("message-options"));
    expect(screen.getByTestId("message-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("message-reply")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-forward")).toBeInTheDocument();
  });

  it("an active group whose composer is off for a moment keeps the reply bar", async () => {
    const { user } = openGroup();
    await screen.findByText("lunch at noon?");
    await user.click(within(row(LUNCH)!).getByTestId("message-reply-action"));
    becomes(group({ canSend: false }));
    becomes(group());
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
  });
});
