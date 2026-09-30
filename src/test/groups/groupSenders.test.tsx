import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { readStatusCard } from "@ghostly/core";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { MessageBubble } from "../../components/MessageBubble";
import { memberText } from "../../lib/memberColors";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.member-colors

const ANA = "ana".padEnd(52, "y"), BO = "bo".padEnd(52, "y"), BOT = "bot".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const members = [member({ key: ME, me: true }), member({ key: ANA, nick: "Ana", role: "admin" }), member({ key: BO, nick: "Bo" }), member({ key: BOT, nick: "Builder" })];
const active = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, members, ...patch });
let n = 0;
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: `g${++n}`, text: "hi", sender: "peer", timestamp: 1_700_000_000_000 + n, via: "datalink", ...patch });

function openGroup(group: GroupView, history: StoredMessage[]) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

/** Each drawn message row: whose it is, and whether it has the picture, its empty place, or neither. */
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-message-row]")].map(row => {
  const nick = row.querySelector<HTMLElement>("[data-testid=message-nick]");
  const avatar = within(row).queryByTestId("sender-avatar") ? "avatar" : within(row).queryByTestId("sender-avatar-spacer") ? "spacer" : "-";
  return `${row.dataset.sender === "me" ? "me" : nick?.textContent}:${avatar}`;
});

describe("GroupChat: who wrote each message", () => {
  it("puts the picture beside the last bubble of each run, an empty place beside the others, none beside mine", async () => {
    openGroup(active(), [
      stored({ member: ANA, text: "one" }), stored({ member: ANA, text: "two" }), stored({ member: BO, text: "three" }),
      stored({ sender: "me", text: "four" }), stored({ member: BO, text: "five" }), stored({ member: BO, text: "six" }), stored({ member: ANA, text: "seven" }),
    ]);
    await screen.findByText("seven");
    expect(rows()).toEqual(["~Ana:spacer", "~Ana:avatar", "~Bo:avatar", "me:-", "~Bo:spacer", "~Bo:avatar", "~Ana:avatar"]);
  });

  it("a line of the group ends a run", async () => {
    openGroup(active(), [stored({ member: ANA, text: "before" }), stored({ event: "joined", member: BO, text: "Bo joined" }), stored({ member: ANA, text: "after" })]);
    await screen.findByText("after");
    expect(rows()).toEqual(["~Ana:avatar", "~Ana:avatar"]);
  });

  it("gives each member's name their colour, the same on every message of theirs", async () => {
    openGroup(active(), [stored({ member: ANA, text: "a" }), stored({ member: BO, text: "b" }), stored({ member: ANA, text: "c" })]);
    await screen.findByText("c");
    const nicks = screen.getAllByTestId("message-nick");
    expect(nicks.map(x => x.className.match(/text-member-\d+/)?.[0])).toEqual([memberText(ANA), memberText(BO), memberText(ANA)]);
    expect(nicks[0].className).not.toContain("text-accent-hover");
  });

  it("shows a contact's picture, else the initial in their colour, else a pattern of the key", async () => {
    const unnamed = "zed".padEnd(52, "y");
    openGroup(active({ members: [...members, member({ key: unnamed })], memberLinks: { "link-bo": BO } }),
      [stored({ member: BO, text: "b" }), stored({ member: ANA, text: "a" }), stored({ member: unnamed, text: "z" })]);
    fakeEngine.update({ links: [linkView({ id: "link-bo", peerPubKeyZ32: "bopeer", peerAvatar: PNG })] });
    await screen.findByText("z");
    const [bo, ana, zed] = screen.getAllByTestId("sender-avatar");
    expect(bo.querySelector("img")).toHaveAttribute("src", PNG);
    expect(ana).toHaveTextContent("A");
    expect(ana.querySelector("span")!.className).toContain(memberText(ANA));
    expect(within(zed).getByTestId("identicon")).toBeInTheDocument();
  });

  it("the avatar is out of the tab order and hidden from a screen reader; the name is the button, and both open the member", async () => {
    const { user } = openGroup(active(), [stored({ member: BO, text: "hello" })]);
    await screen.findByText("hello");
    const avatar = screen.getByTestId("sender-avatar");
    expect(avatar).toHaveAttribute("tabindex", "-1");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    const name = screen.getByRole("button", { name: "~Bo" });
    await user.click(name);
    const dialog = await screen.findByTestId("group-members-dialog");
    const marked = within(dialog).getAllByTestId("group-member").filter(li => li.dataset.focused);
    expect(marked.map(li => li.dataset.key)).toEqual([BO]);
    act(() => fireEvent.keyDown(dialog, { key: "Escape" }));
    fireEvent.click(avatar);
    expect(within(await screen.findByTestId("group-members-dialog")).getAllByTestId("group-member").find(li => li.dataset.focused)?.dataset.key).toBe(BO);
  });

  it("a bot's status card gets its colour and its picture like any message", async () => {
    const card = readStatusCard({ kind: "task", id: "t1", title: "Fix relay rotation", status: "running" })!;
    openGroup(active(), [stored({ member: BOT, text: "Fix relay rotation", card })]);
    await screen.findByTestId("message-nick");
    expect(screen.getByTestId("message-nick").className).toContain(memberText(BOT));
    expect(screen.getByTestId("sender-avatar")).toHaveAttribute("data-key", BOT);
  });

  it("a bot's routines folded into one row: its colour, and one picture per run, counting the row as one message", async () => {
    const routine = (id: string) => readStatusCard({ kind: "routine", id, name: `Routine ${id}`, schedule: "every hour", state: "active" })!;
    openGroup(active(), [
      stored({ member: BOT, text: "r1", card: routine("r1") }), stored({ member: BOT, text: "r2", card: routine("r2") }), stored({ member: BOT, text: "r3", card: routine("r3") }),
      stored({ member: BOT, text: "all set" }), stored({ member: ANA, text: "thanks" }),
      stored({ member: BOT, text: "r4", card: routine("r4") }), stored({ member: BOT, text: "r5", card: routine("r5") }), stored({ member: BOT, text: "r6", card: routine("r6") }),
    ]);
    await screen.findByText("thanks");
    const [first, last] = screen.getAllByTestId("routine-stack");
    const toggle = (stack: HTMLElement) => stack.firstElementChild as HTMLElement;
    // The first stack is followed by the bot's own text: an empty place; the last ends the timeline: the picture.
    expect(within(toggle(first)).getByTestId("sender-avatar-spacer")).toBeInTheDocument();
    expect(within(toggle(first)).queryByTestId("sender-avatar")).not.toBeInTheDocument();
    expect(within(toggle(last)).getByTestId("sender-avatar")).toHaveAttribute("data-key", BOT);
    expect(within(first).getByTestId("routine-stack-name").className).toContain(memberText(BOT));
    expect(rows()).toContain("~Builder:avatar");
    // Opened, the cards under it have their own places, the picture beside the last.
    const cards = [...first.querySelectorAll<HTMLElement>("[data-message-row]")];
    expect(cards.map(r => within(r).queryByTestId("sender-avatar") ? "avatar" : "spacer")).toEqual(["spacer", "spacer", "avatar"]);
    fireEvent.click(within(toggle(last)).getByTestId("sender-avatar"));
    expect(within(await screen.findByTestId("group-members-dialog")).getAllByTestId("group-member").find(li => li.dataset.focused)?.dataset.key).toBe(BOT);
  });

  it("colours a quote of a member's message and a mention of them in theirs, and mine keeps its own", async () => {
    const original = stored({ id: "orig", member: ANA, text: "lunch?" });
    openGroup(active(), [original,
      stored({ member: BO, text: "@Ana yes", mentions: [{ k: ANA, o: 0, l: 4 }], replyTo: { id: "orig", snippet: "lunch?", from: "peer", member: ANA, messageId: "orig" } }),
      stored({ member: BO, text: "and me?", replyTo: { id: "mine", snippet: "x", from: "me" } })]);
    await screen.findByText("and me?");
    const [theirs, mine] = screen.getAllByTestId("reply-quote-name");
    expect(theirs).toHaveTextContent("Ana");
    expect(theirs.className).toContain(memberText(ANA));
    expect(mine.className).toContain("text-accent-hover");
    expect(screen.getByTestId("mention").className).toContain(memberText(ANA));
  });

  it("names who is typing in their colours", async () => {
    openGroup(active({ typing: [{ key: ANA }, { key: BO }] }), []);
    const names = await screen.findAllByTestId("group-typing-name");
    expect(screen.getByTestId("group-typing")).toHaveTextContent("Ana and Bo are typing…");
    expect(names.map(x => [x.textContent, x.className.includes(memberText(x.dataset.key!))])).toEqual([["Ana", true], ["Bo", true]]);
  });
});

describe("a 1:1 chat is as it was", () => {
  it("no picture, no empty place, the name in the accent", () => {
    renderApp(<MessageBubble message={{ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" peerNick="Ana" />);
    expect(screen.queryByTestId("sender-avatar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sender-avatar-spacer")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-nick").className).toContain("text-accent-hover");
    expect(screen.getByTestId("message-nick").className).not.toMatch(/text-member-/);
    expect(screen.queryByRole("button", { name: "~Ana" })).not.toBeInTheDocument();
  });
});

describe("a very narrow chat", () => {
  // The stylesheet is not loaded here (vitest.ui.config.ts): what it says is read instead; e2e/web/group-senders.spec.ts sees it.
  const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");
  it("keeps the colours and leaves the pictures out, and a phone gets them smaller", () => {
    expect(css).toMatch(/@container message-list \(width < 22rem\) \{ \.sender-avatar \{ display: none; \} \}/);
    expect(css).toMatch(/@media \(width < 22rem\) \{ \.sender-avatar \{ display: none; \} \}/);
    expect(css).toMatch(/@container message-list \(width < 36rem\) \{ \.sender-avatar \{ width: 24px; height: 24px; \} \}/);
  });
});
