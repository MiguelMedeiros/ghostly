import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.saved

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

/** ⋮ Save / Unsave: a message saved on this device from its menu, which says Unsave once it is. */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });
const LUNCH = `${ALICE}:1:0`, MINE = `${ME}:1:0`;
const history = [stored({ id: LUNCH, text: "lunch at noon?", member: ALICE }), stored({ id: MINE, text: "count me in", sender: "me", member: ME, timestamp: 1_700_000_001_000 })];

function openGroup() {
  let saved: SavedMessage[] = [];
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("savedMessages", () => saved).on("saveMessage", ({ linkId, messageId, remove }) => {
    saved = remove ? saved.filter((s) => s.message.id !== messageId) : [{ savedAt: Date.now(), message: history.find((m) => m.id === messageId && m.linkId === linkId)! }, ...saved];
    return { error: null };
  });
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })] })] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;

describe("Save from a message's ⋮", () => {
  it("saves someone's message and one of mine, then says Unsave and unsaves", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("lunch at noon?");
    await user.click(within(row(LUNCH)).getByTestId("message-options"));
    expect(screen.getByTestId("message-save")).toHaveTextContent("Save");
    await user.click(screen.getByTestId("message-save"));
    expect(engine.callsTo("saveMessage")).toEqual([{ linkId: "group:group-1", messageId: LUNCH }]);

    await user.click(within(row(MINE)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-save"));
    expect(engine.callsTo("saveMessage")[1]).toEqual({ linkId: "group:group-1", messageId: MINE });

    // The list read again: the menu now says Unsave, and unsaves.
    await waitFor(() => expect(engine.callsTo("savedMessages").length).toBeGreaterThanOrEqual(3));
    await user.click(within(row(LUNCH)).getByTestId("message-options"));
    expect(screen.getByTestId("message-save")).toHaveTextContent("Unsave");
    await user.click(screen.getByTestId("message-save"));
    expect(engine.callsTo("saveMessage")[2]).toEqual({ linkId: "group:group-1", messageId: LUNCH, remove: true });
  });
});
