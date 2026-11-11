import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { sanitizeNick } from "@ghostly/core";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { authorName, othersName } from "../../lib/groups";
import { groupPayTitle } from "../../lib/groupPayments";
import { reactionNoteText } from "../../lib/reactions";
import { saveSession } from "../../lib/storage";
import { translatorFor, loadLocale } from "../../locales";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.reactions, chat.replies, groups.member-colors

/*
 * A contact's or a member's name is whatever they say it is (WISP 401 § Name and picture): "You" and "Você" are names
 * like any other. The lines that have a twin of mine starting with the app's word for me ("You removed Bob", "You
 * reacted ❤️ to …", a reply's "You") are never made by such a name: there it is quoted.
 */

vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** Each language's words for me, as its strings say them: `group.member.you`, `chat.reply.you` and the others. */
const groupAreas = import.meta.glob<{ member: { you: string } }>("../../locales/*/group.json", { eager: true, import: "default" });
const chatAreas = import.meta.glob<{ reply: { you: string } }>("../../locales/*/chat.json", { eager: true, import: "default" });
const savedAreas = import.meta.glob<{ you: string }>("../../locales/*/saved.json", { eager: true, import: "default" });
const payAreas = import.meta.glob<{ group: { you: string } }>("../../locales/*/payments.json", { eager: true, import: "default" });
const myWords = [
  ...Object.values(groupAreas).map(a => a.member.you), ...Object.values(chatAreas).map(a => a.reply.you),
  ...Object.values(savedAreas).map(a => a.you), ...Object.values(payAreas).map(a => a.group.you),
];

describe("a name that is the app's word for me", () => {
  it("is quoted in every language's word, whatever its case, spacing or accents; any other name stays as it is", () => {
    expect(myWords.length).toBeGreaterThanOrEqual(32);
    for (const word of myWords) {
      const name = sanitizeNick(word)!;
      expect(othersName(name)).toBe(`“${name}”`);
      expect(othersName(` ${name.toUpperCase()}  `)).toBe(`“ ${name.toUpperCase()}  ”`);
    }
    for (const name of ["Voce", "VOCÊ", "you", "Y‍ou", "ｙｏｕ", "انت", "Tu"]) expect(othersName(name)).toBe(`“${name}”`);
    for (const name of ["Youssef", "Your mom", "Alice", "Tu Anh", "Me"]) expect(othersName(name)).toBe(name);
  });

  it("the chat list's reaction line of a contact named so is not mine", async () => {
    const note = (by: "me" | "peer") => ({ at: 1, by, emoji: "❤️", snippet: "hi", mine: true });
    const en = translatorFor("en");
    expect(reactionNoteText(note("peer"), "You", en)).toBe("“You” reacted ❤️ to \"hi\"");
    expect(reactionNoteText(note("me"), "Ana", en)).toBe("You reacted ❤️ to \"hi\"");
    await loadLocale("pt");
    const pt = translatorFor("pt");
    expect(reactionNoteText(note("peer"), "Você", pt)).not.toBe(reactionNoteText(note("me"), "Ana", pt));
    expect(reactionNoteText(note("peer"), "Você", pt)).toContain("“Você”");
  });
});

const ME = "me".padEnd(52, "y");
const ADMIN = "admin".padEnd(46, "y") + "adm1n0";
const OTHER = "other".padEnd(46, "y") + "0th3r9";
const BOB = "bob".padEnd(46, "y") + "b0bb0b";
const member = (key: string, nick: string | undefined, role: GroupMemberView["role"] = "member", me = false): GroupMemberView =>
  ({ key, role, me, online: true, missing: 0, ...(nick !== undefined && { nick }) });
const line = (id: string, from: string, event: StoredMessage["event"], text: string, at: number, by?: string): StoredMessage =>
  ({ linkId: "group:group-1", id, text, sender: "peer", member: from, timestamp: 1_700_000_000_000 + at * 600_000, via: "datalink", event, ...(by && { by }) });

function openGroup(group: Partial<GroupView>, messages: StoredMessage[], language?: "pt") {
  fakeEngine.on("groupMessages", () => messages).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, myKey: ME, ...group })] });
  renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", ...(language && { language }) });
}

describe("a group whose admin or member is named as the app calls me", () => {
  const roster = (admin: string, other: string) => ({
    members: [member(ME, undefined, "member", true), member(ADMIN, sanitizeNick(admin), "admin"), member(OTHER, sanitizeNick(other))],
    formerNames: { [BOB]: "Bob" },
  });
  const history = [
    line("e1", BOB, "gone", "Bob is no longer a member", 0, ADMIN),
    line("e2", BOB, "gone", "Bob is no longer a member", 1, ME),
    line("e3", OTHER, "joined", "you joined", 2),
    line("e4", ADMIN, "renamed", "You renamed the group to “Pay me”", 3),
    line("e5", ME, "renamed", "You renamed the group to “Pay me”", 4),
  ];

  it("says their removal, join and rename with the name quoted; mine read as they did", async () => {
    openGroup(roster("You", "VOCÊ"), history);
    const lines = (await screen.findAllByTestId("group-event")).map(l => l.textContent);
    expect(lines).toEqual([
      "“You” removed Bob", "You removed Bob", "“VOCÊ” joined", "“You” admin renamed the group to “Pay me”", "You renamed the group to “Pay me”",
    ]);
  });

  it("in Portuguese, an admin named \"Você\" removing Bob is not my removal of him", async () => {
    openGroup(roster("Você", "Carol"), history.slice(0, 2), "pt");
    const lines = (await screen.findAllByTestId("group-event")).map(l => l.textContent);
    expect(lines).toEqual(["“Você” removeu Bob do grupo", "Você removeu Bob do grupo"]);
  });

  it("names them quoted wherever a group names its author: a reply's quote, a reaction, a payment", () => {
    const group = groupView({ myKey: ME, ...roster("you", "Carol") });
    expect(authorName(group, ADMIN)).toBe("“you”");
    expect(authorName(group, ME)).toBe("You");
    expect(authorName({ ...group, formerNames: { [BOB]: "You" } }, BOB)).toBe("“You”");
    expect(groupPayTitle({ kind: "payment", id: "p", from: ADMIN, to: OTHER } as never, group)).toBe("“you” sent Carol");
  });
});

describe("a 1:1 contact named as the app calls me", () => {
  const PEER = "peer".padEnd(52, "p"), LINK = "link-you", WIRE = "W".repeat(22);
  const own: StoredMessage = { linkId: LINK, id: `peer_${WIRE}`, text: "I will pay you 1 BTC", sender: "peer", timestamp: Date.now() - 180_000, via: "datalink" };
  const quoting: StoredMessage = { linkId: LINK, id: `peer_${"Q".repeat(22)}`, text: "as I said", sender: "peer", timestamp: Date.now() - 120_000, via: "datalink",
    replyTo: { id: own.id, snippet: own.text, from: "peer" } };

  it("quotes their own message under their name in quotes, never under mine", async () => {
    saveSession({ id: "you", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: Date.now() - 600_000 });
    const utils = renderApp(<Chat sessionId="you" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/you" });
    utils.engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
      .update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", peerNick: sanitizeNick("You"), pairing: { status: "ready" } } as never)] });
    utils.engine.messages(LINK, [own, quoting]);
    await act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));
    const row = (await screen.findByText(quoting.text)).closest<HTMLElement>("[data-message-row]")!;
    expect(within(row).getByTestId("reply-quote-name")).toHaveTextContent(/^“You”$/);
    // A name is still theirs to choose: the header says it as they do.
    expect(screen.getByTestId("chat-name")).toHaveTextContent(/^You$/);
  });
});
