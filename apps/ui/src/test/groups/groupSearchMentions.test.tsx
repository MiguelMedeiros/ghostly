import { act, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { SEARCH_DEBOUNCE_MS } from "../../hooks/useChatSearch";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
// Alice went by "Alice" when Bob mentioned her; she goes by "Alicia" now.
const members = [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alicia", role: "admin" }), member({ key: BOB, nick: "Bob" })];
const active = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, members, ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

function openGroup(group: GroupView, history: StoredMessage[] = []) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const count = () => screen.getByTestId("chat-search-count").textContent;
const type = async (text: string) => {
  fireEvent.change(screen.getByTestId("chat-search-input"), { target: { value: text } });
  await act(async () => { await new Promise(r => setTimeout(r, SEARCH_DEBOUNCE_MS + 20)); });
};

/*
 * A group's search finds a message by its mentions as the bubble shows them: "@" and the member's name now, which
 * may not be the name typed when it was sent. It used to search the text as typed, so the name on screen found
 * nothing and the old one, shown nowhere, found "1 of 1" with nothing marked.
 */
describe("a group's search and a mention of a member who goes by another name now", () => {
  it("finds the message by the name its bubble shows, not by the name no longer shown", async () => {
    const { user } = openGroup(active(), [stored({ id: "g1", member: BOB, text: "@Alice lunch?", mentions: [{ k: ALICE, o: 0, l: 6 }] })]);
    // The bubble shows the mention by the name she goes by now.
    expect(await screen.findByTestId("mention")).toHaveTextContent("@Alicia");
    expect(screen.getByTestId("message-text")).toHaveTextContent("@Alicia lunch?");
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-search-open"));
    await type("lunch");
    expect(count()).toBe("1 of 1");
    await type("Alicia");
    expect(count()).toBe("1 of 1");
  });

  it("does not count a match for words its bubble no longer shows", async () => {
    const { user } = openGroup(active(), [stored({ id: "g1", member: BOB, text: "@Alice lunch?", mentions: [{ k: ALICE, o: 0, l: 6 }] })]);
    expect(await screen.findByTestId("message-text")).toHaveTextContent("@Alicia lunch?");
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-search-open"));
    await type("Alice lunch");
    // The words "Alice lunch" are nowhere on screen.
    expect(count()).toBe("No results");
  });
});
