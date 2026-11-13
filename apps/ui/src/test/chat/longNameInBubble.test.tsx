import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { readStatusCard } from "@ghostly/core";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.nickname-sync, groups.member-colors

/**
 * A received message's name line with a very long one-word name (30 letters, the longest a contact's name takes). It
 * had no rule to wrap or cut it: on a 320 px phone it ran from 19 to 381 px, past its bubble and the screen's edge.
 * Now it is one line cut with an ellipsis inside the bubble, the whole name in its tooltip, the name still read whole
 * by a screen reader. jsdom has no layout, so these check the rules that do it; e2e/web/chat-header-phone.spec.ts
 * measures it on a 320 px phone.
 */
const LONG = "W".repeat(30);

/** One line, cut with an ellipsis, and allowed to shrink below its word inside a flex row (beside the admin mark). */
function cutToItsBox(nick: HTMLElement, whole: string) {
  expect(nick).toHaveClass("min-w-0", "truncate");
  expect(nick).toHaveAttribute("title", whole);
  expect(nick).toHaveTextContent(whole);
  // The name stays one isolated run (a right-to-left chat drew a Latin name "Carol~" without it).
  expect(nick.querySelector("bdi")).toHaveTextContent(whole);
}

describe("a 1:1 chat: the contact's long one-word name over their message", () => {
  const key = (c: string) => c.repeat(52);
  const chat = (over: Partial<ChatSession>): ChatSession => ({
    id: "h", profile: "paired-chat/1", mySeedB64: "seed-h", peerPubKeyB64: key("h"), encKeyB64: "enc", createdAt: 1,
    messages: [{ id: "m1", ref: "r1", sender: "peer", timestamp: 1_700_000_000_000, text: "Task done", nick: "Botty" }], ...over,
  });

  it("is cut inside the bubble, the whole name in its tooltip", async () => {
    saveSession(chat({ nick: "Botty", nickSource: "profile", label: LONG }));
    const utils = renderApp(<Chat sessionId="h" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-h" })).on("setActiveLink", () => undefined);
    act(() => utils.engine.update({ links: [linkView({ id: "link-h", peerPubKeyZ32: key("h"), profile: "paired-chat/1", peerNick: "Botty" })] }));

    const nick = await screen.findByTestId("message-nick");
    cutToItsBox(nick, LONG);
    // Its box is the bubble's, which is no wider than its column, and the column shrinks within the row.
    const bubble = nick.closest<HTMLElement>("[data-message-bubble]")!;
    expect(bubble).toHaveClass("max-w-full");
    expect(bubble.parentElement).toHaveClass("min-w-0");
  });
});

describe("a group: a member's own long one-word name over their run", () => {
  const ME = "me".padEnd(52, "y"), BO = "bo".padEnd(52, "y"), AD = "ad".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const members = [member({ key: ME, me: true }), member({ key: BO, nick: LONG }), member({ key: AD, nick: `A${LONG.slice(1)}`, role: "admin" })];
  let n = 0;
  const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: `g${++n}`, text: "hi", sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink", ...patch });
  function openGroup(history: StoredMessage[]) {
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, members })] });
    return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  }
  const rowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-message-row]")!;

  it("is cut inside the bubble, its button too, and the button keeps the whole name", async () => {
    openGroup([stored({ member: BO, text: "hello" })]);
    await screen.findByText("hello");
    const nick = within(rowOf("hello")).getByTestId("message-nick");
    cutToItsBox(nick, `~${LONG}`);
    expect(nick.closest("[data-message-bubble]")).toHaveClass("max-w-full");
    // The tap target that opens who they are: a block no wider than the line, cut the same way, named in full.
    const open = within(nick).getByTestId("message-nick-open");
    expect(open).toHaveClass("block", "max-w-full", "truncate");
    expect(open).toHaveAccessibleName(`~${LONG}`);
  });

  it("the admin's long name shrinks beside the admin mark, which stays whole", async () => {
    openGroup([stored({ member: AD, text: "from the admin" })]);
    await screen.findByText("from the admin");
    const row = rowOf("from the admin");
    const nick = within(row).getByTestId("message-nick");
    cutToItsBox(nick, `~A${LONG.slice(1)}`);
    expect(nick.parentElement).toHaveClass("flex");
    expect(within(row).getByTestId("message-nick-admin")).toHaveClass("shrink-0");
  });

  it("over a bot's card, the name is cut within the card's width", async () => {
    const card = readStatusCard({ kind: "task", id: "t1", title: "Fix relay rotation", status: "running" })!;
    openGroup([stored({ member: BO, text: "Fix relay rotation", card })]);
    const nick = await screen.findByTestId("message-nick");
    cutToItsBox(nick, `~${LONG}`);
    expect(nick.parentElement).toHaveClass("max-w-full");
    expect(nick.parentElement!.parentElement).toHaveClass("min-w-0");
  });
});
