import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.replies, groups.edit

/*
 * A group's reply and edit bars follow the message as the group has it, as a 1:1 chat's do: one deleted meanwhile (for
 * everyone, by its author on another device or an admin, or from its own ⋮ here) closes the reply bar, and ends the
 * edit with the draft set aside given back. What is sent next answers and edits nothing.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (): GroupView => groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })] });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

const LUNCH = `${ALICE}:1:0`, MINE = `${ME}:1:0`;
const lunch = stored({ id: LUNCH, text: "lunch at noon?", member: ALICE });
const mine = stored({ id: MINE, text: "heron note 8812", sender: "me", timestamp: 1_700_000_001_000 });

function openGroup() {
  fakeEngine.on("groupMessages", () => [lunch, mine]).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }))
    .on("editMessage", () => ({ error: "Only your own text messages can be edited", refused: true }))
    // The engine takes it off the list it sends, as a removal does.
    .on("removeMessage", ({ messageId }: { messageId: string }) => {
      setTimeout(() => gone(messageId));
      return { error: null };
    });
  fakeEngine.update({ groups: [group()] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
/** The group's list without `id`: deleted for everyone, from here or elsewhere. */
const gone = (id: string) => act(() => fakeEngine.messages("group:group-1", [lunch, mine].filter(m => m.id !== id), [id]));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
const field = () => screen.getByRole<HTMLTextAreaElement>("textbox");
const deleteForEveryone = async (user: ReturnType<typeof openGroup>["user"], id: string) => {
  await user.click(within(row(id)!).getByTestId("message-options"));
  await user.click(screen.getByTestId("message-delete-everyone"));
  await user.click(screen.getByTestId("message-delete-confirm"));
};

describe("a group's bars on a message deleted meanwhile", () => {
  it("the edit ends, its words with it, the draft comes back, and Enter sends the draft", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("heron note 8812");
    fireEvent.change(field(), { target: { value: "my draft" } });
    await user.click(within(row(MINE)!).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    expect(screen.getByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("heron note 8812");
    fireEvent.change(field(), { target: { value: "heron note 8813" } });

    gone(MINE);
    expect(row(MINE)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("my draft");

    await user.type(field(), "{Enter}");
    expect(engine.callsTo("editMessage")).toEqual([]);
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "my draft" }]);
  });

  it("deleted for everyone from its own ⋮ while it is edited: the edit ends as Cancel would", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("heron note 8812");
    await user.click(within(row(MINE)!).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();

    await deleteForEveryone(user, MINE);
    await act(() => new Promise(resolve => setTimeout(resolve)));
    expect(engine.callsTo("removeMessage")).toEqual([{ linkId: "group:group-1", messageId: MINE }]);
    expect(row(MINE)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  it("the reply bar closes, and the next message answers nothing", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("lunch at noon?");
    await user.click(within(row(LUNCH)!).getByTestId("message-reply-action"));
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");

    gone(LUNCH);
    expect(row(LUNCH)).toBeNull();
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    await user.type(field(), "ok{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "ok" }]);
  });

  it("deleted for everyone from its own ⋮ while it is answered: the reply bar closes", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("heron note 8812");
    await user.click(within(row(MINE)!).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-reply"));
    expect(screen.getByTestId("composer-reply")).toBeInTheDocument();

    await deleteForEveryone(user, MINE);
    await act(() => new Promise(resolve => setTimeout(resolve)));
    expect(row(MINE)).toBeNull();
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    await user.type(field(), "ok{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "ok" }]);
  });
});
