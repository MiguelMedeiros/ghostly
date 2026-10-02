import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { COMMUNITY_LIMITS, GROUP_LIMITS, GROUP_READ_NOTE, GROUP_READ_NOTE_COMMUNITY } from "@ghostly/core";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { idCard } from "../../components/identities/idCard";
import { english } from "../../lib/english";
import { Identities } from "../../pages/Identities";
import { GroupChat } from "../../pages/GroupChat";
import type { Language } from "../../lib/settings";
import { engineState, fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { proofView } from "../identities/views";
import { LOCALES, SECTIONS, flatten, lookup } from "./locales";

// covers: app.i18n

/** Groups and identities in Portuguese and in Arabic (right to left): their words come from the locale, none left in English. */

const ME = "me".padEnd(52, "y"), ANA = "ana".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });
const t = (language: Language, key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce((text, [k, v]) => text.split(`{{${k}}}`).join(String(v)), lookup(language, key)!);
const RAW_KEY = new RegExp(`\\b(?:${SECTIONS.join("|")})(?:\\.[a-zA-Z]+)+\\b`);

function openGroup(language: Language, group: GroupView, history: StoredMessage[] = []) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language });
}

describe.each(["pt", "ar"] as const)("in %s", (language) => {
  it("a group's header, its membership lines and the engine's own lines are translated", async () => {
    const { container } = openGroup(language, groupView({
      status: "active", isAdmin: true, entryLink: "x",
      members: [member({ key: ME, me: true, online: true, role: "admin" }), member({ key: ANA, nick: "Ana", online: true })],
    }), [
      stored({ id: "e1", event: "joined", member: ANA, text: "Ana joined" }),
      stored({ id: "e2", event: "rotated", text: "Keys rotated: a fresh epoch" }),
      stored({ id: "e3", event: "gone", text: "Bia is no longer a member" }),
    ]);

    expect(screen.getByTestId("group-share")).toHaveAccessibleName(t(language, "group.chat.shareLink"));
    expect(screen.getByTestId("group-members")).toHaveTextContent(
      t(language, "group.chat.reachable", { members: t(language, "group.chat.memberCount", { count: 2 }), reachable: 1, total: 1 }));
    const lines = (await screen.findAllByTestId("group-event")).map(e => e.textContent);
    expect(lines).toEqual([
      t(language, "group.event.joined", { name: "Ana" }),
      t(language, "group.event.rotated"),
      t(language, "group.event.gone", { name: "Bia" }),
    ]);
    expect(lines.join(" ")).not.toMatch(/joined|rotated|no longer/);
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it("the membership lines of a member who has left are translated too, with the name the group last knew", async () => {
    const BIA = "bia".padEnd(52, "y");
    openGroup(language, groupView({
      status: "active", formerNames: { [BIA]: "Bia" },
      members: [member({ key: ME, me: true, online: true }), member({ key: ANA, nick: "Ana", online: true, role: "admin" })],
    }), [
      stored({ id: "e1", event: "joined", member: BIA, text: "Bia joined" }),
      stored({ id: "e2", event: "admin", member: BIA, text: "Bia is now the admin" }),
      stored({ id: "e3", event: "renamed", member: BIA, text: "Bia renamed the group to “Amigos”" }),
      stored({ id: "e4", event: "picture", member: BIA, text: "Bia removed the group's picture" }),
      stored({ id: "e5", event: "gone", member: BIA, text: "Bia is no longer a member" }),
    ]);
    const lines = (await screen.findAllByTestId("group-event")).map(e => e.textContent);
    expect(lines).toEqual([
      t(language, "group.event.joined", { name: "Bia" }),
      t(language, "group.event.admin", { name: "Bia" }),
      t(language, "group.event.renamed", { name: "Bia", group: "Amigos" }),
      t(language, "group.event.pictureRemoved", { name: "Bia" }),
      t(language, "group.event.gone", { name: "Bia" }),
    ]);
    expect(lines.join(" ")).not.toMatch(/joined|now the admin|renamed|picture|no longer/);
  });

  it("a line about a member who never said a name, and has left, names it in the interface's words", async () => {
    const GONE = "46ishssi".padEnd(52, "y");
    // As the engine stores them: "Member" and the start of the key, in English.
    openGroup(language, groupView({
      status: "active", profile: "community",
      members: [member({ key: ME, me: true, online: true }), member({ key: ANA, nick: "Ana", online: true, role: "admin" })],
    }), [
      stored({ id: "e1", event: "joined", member: GONE, text: "Member 46ishssi joined" }),
      stored({ id: "e2", event: "renamed", member: GONE, text: "Member 46ishssi renamed the group to “Amigos”" }),
      stored({ id: "e3", event: "gone", member: GONE, text: "Member 46ishssi is no longer a member" }),
      // A name someone chose stays as written, whatever it looks like.
      stored({ id: "e4", event: "gone", text: "Member of Parliament is no longer a member" }),
    ]);
    const unnamed = t(language, "group.member.unnamed", { key: "46ishssi" });
    const lines = (await screen.findAllByTestId("group-event")).map(e => e.textContent);
    expect(lines).toEqual([
      t(language, "group.event.joined", { name: unnamed }),
      t(language, "group.event.renamed", { name: unnamed, group: "Amigos" }),
      t(language, "group.event.gone", { name: unnamed }),
      t(language, "group.event.gone", { name: "Member of Parliament" }),
    ]);
    expect(lines.slice(0, 3).join(" ")).not.toMatch(/Member /);
  });

  it("joining through a link says each step in the interface's language", () => {
    const { container } = openGroup(language, groupView({ name: "Amigos", profile: "community", invitation: { viaLink: true, stage: "answered" } as GroupView["invitation"] }));
    const joining = screen.getByTestId("group-joining");
    expect(within(joining).getByRole("heading")).toHaveTextContent(t(language, "group.join.answeredTitleCommunity"));
    expect(joining).toHaveTextContent(t(language, "group.join.answeredCommunity"));
    expect(within(screen.getByTestId("group-joining-steps")).getAllByRole("listitem").map(li => li.textContent!.replace("✓", ""))).toEqual([
      t(language, "group.join.step.knockedCommunity"), t(language, "group.join.step.answeredCommunity"),
      t(language, "group.join.step.admitted"), t(language, "group.join.step.inCommunity"),
    ]);
    expect(screen.getByTestId("group-joining-cancel")).toHaveTextContent(t(language, "group.join.cancel"));
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it("the Identities page and an identity's card are translated", async () => {
    fakeEngine.update(engineState({ identityProofs: [proofView({ id: "p1" })] }));
    const { container } = renderApp(<Identities />, { language });
    expect(await screen.findByText(t(language, "identities.page.intro"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: t(language, "identities.mine.title") })).toBeInTheDocument();
    expect(screen.getAllByText(t(language, "identities.card.kind"), { exact: false }).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(RAW_KEY);
    // No identity word of this page left in English where this language has its own.
    const english = [...flatten(LOCALES.en)].filter(([key]) => /^identities\.(page|mine|card)\./.test(key) && lookup(language, key) !== lookup("en", key));
    const texts = new Set([...container.querySelectorAll("*")].flatMap(el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue!.trim())));
    expect(english.map(([, text]) => text).filter(text => texts.has(text as string))).toEqual([]);
  });
});

describe("the English words stay what they were", () => {
  it("the read notes are the engine's own, word for word", () => {
    expect(english("group.readNote", { count: GROUP_LIMITS.relay })).toBe(GROUP_READ_NOTE);
    expect(english("group.readNoteCommunity", { count: COMMUNITY_LIMITS.store })).toBe(GROUP_READ_NOTE_COMMUNITY);
  });

  it("a card worked out without the app's translator is in English", () => {
    const card = idCard(proofView({ sharedWith: 2 }));
    expect(card).toMatchObject({ statusLabel: "Verified", category: "Your own key", shared: "Shared in 2 chats" });
  });
});
