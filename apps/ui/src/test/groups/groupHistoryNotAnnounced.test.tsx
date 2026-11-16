import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { ANNOUNCE_WINDOW_MS } from "../../components/chat/MessageAnnouncer";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, groups.send

/**
 * A group opened for the first time in a session draws before its history comes (the engine answers it a moment
 * later): the messages that history brings were there before, and a screen reader is told nothing of them. One that
 * comes after it is news, and is said.
 */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const members = [member({ key: ME, me: true, role: "admin", nick: "Me" }), member({ key: ALICE, nick: "Alice" }), member({ key: BOB, nick: "Bob" })];
const line = (id: string, from: string, text: string, at: number): StoredMessage =>
  ({ linkId: "group:group-1", id, text, sender: "peer", member: from, timestamp: 1_700_000_000_000 + at, via: "datalink" });
const HISTORY = [line("m1", ALICE, "Morning all", 1), line("m2", BOB, "Coffee at ten?", 2)];

/** Past the window in which messages that come together are read out as one line. */
const pastWindow = () => act(() => new Promise(resolve => setTimeout(resolve, ANNOUNCE_WINDOW_MS + 200)));

function openGroup() {
  fakeEngine.on("groupMessages", () => HISTORY).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, myKey: ME, members, lastMessageAt: 1_700_000_000_002 })] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

describe("GroupChat: a history that comes after the group opened", () => {
  it("is not read out as new messages; one that comes after it is", { timeout: 10_000 }, async () => {
    const view = openGroup();
    expect(await screen.findByText("Coffee at ten?")).toBeInTheDocument();
    await pastWindow();
    expect(screen.getByTestId("chat-announcement")).toBeEmptyDOMElement();
    act(() => view.engine.messages("group:group-1", [...HISTORY, line("m3", ALICE, "See you there", 3)]));
    await pastWindow();
    expect(screen.getByTestId("chat-announcement")).toHaveTextContent(/^Alice: See you there$/);
  });
});
