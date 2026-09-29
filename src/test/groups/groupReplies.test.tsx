import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.replies

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), GONE = "gone".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (): GroupView => groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" })] });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

const LUNCH = `${ALICE}:1:0`;
const history = [
  stored({ id: LUNCH, text: "lunch at noon?", member: ALICE }),
  stored({ id: `${BOB}:1:0`, text: "count me in", member: BOB, timestamp: 1_700_000_001_000, replyTo: { id: LUNCH, snippet: "lunch at noon?", from: "peer", member: ALICE, messageId: LUNCH } }),
  stored({ id: `${BOB}:1:1`, text: "what about this?", member: BOB, timestamp: 1_700_000_002_000, replyTo: { id: `${GONE}:0:4`, snippet: "an old plan", from: "peer", member: GONE } }),
];

function openGroup() {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }));
  fakeEngine.update({ groups: [group()] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1" });
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;

describe("replies in a group", () => {
  it("a reply's quote names the member; one whose original is not here is marked", async () => {
    openGroup();
    await screen.findByText("count me in");
    const quote = within(row(`${BOB}:1:0`)).getByTestId("message-quote");
    expect(quote).toHaveAttribute("data-state", "found");
    expect(within(quote).getByTestId("reply-quote-name")).toHaveTextContent("Alice");
    expect(within(quote).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
    const other = within(row(`${BOB}:1:1`)).getByTestId("message-quote");
    expect(other).toHaveAttribute("data-state", "unverified");
    expect(within(other).getByTestId("reply-quote-name")).toHaveTextContent(`Member ${GONE.slice(0, 8)}`);
  });

  it("Reply from a message's ⋮, with a mention: the engine gets both, and the bar goes once it is sent", async () => {
    const { user, engine } = openGroup();
    await screen.findByText("count me in");
    await user.click(within(row(LUNCH)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-reply"));
    const bar = screen.getByTestId("composer-reply");
    expect(within(bar).getByTestId("reply-quote-name")).toHaveTextContent("Alice");
    expect(within(bar).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
    await user.type(screen.getByRole("textbox"), "@bo");
    await user.keyboard("{Enter}");
    await user.type(screen.getByRole("textbox"), "you too?{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "@Bob you too?", mentions: [{ k: BOB, o: 0, l: 4 }], replyTo: LUNCH }]);
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
  });

  it("a refused send keeps the bar, and the next message answers nothing once it is cancelled", async () => {
    const { user, engine } = openGroup();
    engine.on("sendGroupMessage", () => ({ error: "You are not in this group yet" }));
    await screen.findByText("count me in");
    await user.click(within(row(LUNCH)).getByTestId("message-reply-action"));
    await user.type(screen.getByRole("textbox"), "ok{Enter}");
    expect(screen.getByTestId("composer-reply")).toBeInTheDocument();
    await user.click(screen.getByTestId("composer-reply-cancel"));
    engine.on("sendGroupMessage", () => ({ error: null }));
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(engine.callsTo("sendGroupMessage").slice(-1)[0]).toEqual({ groupId: "group-1", text: "ok" });
  });
});
