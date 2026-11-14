import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { sanitizeNick } from "@ghostly/core";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { authorName, formerName, memberName, sameNamed } from "../../lib/groups";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.member-colors

// A member's name is what their own messages say it is: nothing makes it unique, and anyone with a community's link
// can take its admin's.
const ME = "me".padEnd(52, "y");
const ADMIN = "admin".padEnd(46, "y") + "adm1n0";
const OTHER = "other".padEnd(46, "y") + "0th3r9";
const GONE = "gone".padEnd(46, "y") + "g0n3ab";
const member = (key: string, nick: string | undefined, role: GroupMemberView["role"] = "member", me = false): GroupMemberView =>
  ({ key, role, me, online: true, missing: 0, ...(nick !== undefined && { nick }) });
const said = (id: string, from: string, text: string, at: number): StoredMessage =>
  ({ linkId: "group:group-1", id, text, sender: "peer", member: from, timestamp: 1_700_000_000_000 + at * 600_000, via: "datalink" });
const line = (id: string, from: string, event: StoredMessage["event"], text: string, at: number): StoredMessage => ({ ...said(id, from, text, at), event });

function openChat(group: Partial<GroupView>, messages: StoredMessage[]) {
  fakeEngine.on("groupMessages", () => messages).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, myKey: ME, ...group })] });
  renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}
const rowOf = async (text: string) => (await screen.findByText(text)).closest<HTMLElement>("[data-message-row]")!;
/** A name told apart by its key's end, as shown: the end isolated left to right (LRI … PDI). */
const apart = (name: string, end: string) => `${name} \u2066(…${end})\u2069`;
/** A message's name, as its whole text: "~" before a name that is no contact's. */
const nickOf = (row: HTMLElement) => within(row).getByTestId("message-nick").textContent;

describe("a group's members with one name", () => {
  it("are each told apart by the end of their key, whatever case, width or spacing tells them apart", () => {
    const roster = [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, " ａｌｉｃｅ  ")];
    const same = sameNamed(roster);
    expect(memberName(roster[1]!, undefined, same)).toBe(apart("Alice", "adm1n0"));
    expect(memberName(roster[2]!, undefined, same)).toBe(apart("ａｌｉｃｅ", "0th3r9"));
    expect(authorName({ members: roster }, ADMIN)).toBe(apart("Alice", "adm1n0"));
    // A name that already shows a key's end is the same name, isolated as shown or not.
    expect(sameNamed([member(ADMIN, "Alice", "admin"), member(OTHER, "Alice (…adm1n0)")]).has(OTHER)).toBe(true);
    expect(sameNamed([member(ADMIN, "Alice", "admin"), member(OTHER, apart("Alice", "adm1n0"))]).has(OTHER)).toBe(true);
    // Mine counts: a member who takes my name is told apart from me.
    expect([...sameNamed([member(ME, undefined, "member", true), member(OTHER, "Bob")], "bob")]).toEqual([ME, OTHER]);
    expect(sameNamed([member(ADMIN, "Alice", "admin"), member(OTHER, "Alicia")]).size).toBe(0);
    // In a community, a member gone since, by the name the group knew them by: told apart from a member who has it now.
    const community = { profile: "community" as const, members: roster };
    expect(authorName({ ...community, formerNames: { [GONE]: "alice" } }, GONE)).toBe(apart("alice", "g0n3ab"));
    expect(formerName(community, GONE, "Carol")).toBe("Carol");
  });

  it("an Arabic name's key end still reads \"…k1p0aa\": the end is isolated left to right, so the name's direction cannot turn it", () => {
    // Plain "محمد (…adm1n0)" is laid out right to left as a whole: the "…" lands after the key, which then reads as its start.
    const roster = [member(ME, undefined, "member", true), member(ADMIN, "محمد", "admin"), member(OTHER, "محمد")];
    const same = sameNamed(roster);
    expect(memberName(roster[1]!, undefined, same)).toBe("محمد \u2066(…adm1n0)\u2069");
    expect(memberName(roster[2]!, undefined, same)).toBe("محمد \u2066(…0th3r9)\u2069");
    expect(formerName({ profile: "community", members: roster }, GONE, "محمد")).toBe("محمد \u2066(…g0n3ab)\u2069");
  });

  it("are told apart whatever a name adds that draws nothing: a filler, a selector, a joiner, a blank", () => {
    // Shown beside its key's end without the blanks it was padded with; the joiners and selectors a name needs stay.
    const unseen: [nick: string, shown: string][] = [
      ["Anaㅤ", "Ana"], ["Anaﾠ", "Ana"], ["Anaᅟ", "Ana"], ["Anaᅠ", "Ana"], ["Ana͏", "Ana"], ["Ana︀", "Ana︀"],
      ["Ana\u{e0100}", "Ana\u{e0100}"], ["Ana᠋", "Ana᠋"], ["Ana឵", "Ana"], ["A‍na", "A‍na"], ["An‌a", "An‌a"], ["Ana⠀", "Ana"],
      ["Ana️", "Ana️"], ["ㅤAna (…adm1n0)", "Ana"],
    ];
    for (const [nick, shown] of unseen) {
      // A name a receiver keeps as it came, and one the name step lets a person type.
      expect(sanitizeNick(nick)).toBe(nick);
      const roster = [member(ADMIN, "Ana", "admin"), member(OTHER, nick)];
      expect([...sameNamed(roster)], nick).toEqual([ADMIN, OTHER]);
      expect(authorName({ members: roster }, OTHER)).toBe(apart(shown, "0th3r9"));
      expect([...sameNamed([member(ME, undefined, "member", true), member(OTHER, nick)], "Ana")], nick).toEqual([ME, OTHER]);
    }
    // Names that read apart stay apart, and a name that needs its joiners shows them as it came.
    expect(sameNamed([member(ADMIN, "Ana", "admin"), member(OTHER, "Anna")]).size).toBe(0);
    expect(sameNamed([member(ADMIN, "क्षमा", "admin"), member(OTHER, "क्षमता")]).size).toBe(0);
    expect(sameNamed([member(ADMIN, "می‌خواهم", "admin"), member(OTHER, "مریم")]).size).toBe(0);
    const persian = [member(ADMIN, "می‌خواهم", "admin"), member(OTHER, "میخواهم")];
    expect(memberName(persian[0]!, undefined, sameNamed(persian))).toBe("می‌خواهم \u2066(…adm1n0)\u2069");
    expect(memberName(member(OTHER, "👩‍💻 Ana"), undefined, sameNamed([member(ADMIN, "Bob", "admin"), member(OTHER, "👩‍💻 Ana")]))).toBe("👩‍💻 Ana");
  });

  it("are told apart whatever letter of another alphabet that looks the same a name swaps in", () => {
    // Cyrillic А, Greek Α, Cyrillic е, і and с, Greek ι, all capital Greek and Cyrillic (Greek Ϲ too, which NFKC
    // makes Σ), a mathematical Greek 𝚨, Cyrillic ё with its dots.
    const lookalikes = ["Аlice", "Αlice", "Alicе", "Аlісе", "Alιce", "ΑLICΕ", "АLІСЕ", "ΑLΙϹΕ", "𝚨lice", "Alicё"];
    for (const nick of lookalikes) {
      expect(sanitizeNick(nick)).toBe(nick);
      const roster = [member(ADMIN, nick === "Alicё" ? "Alicë" : "Alice", "admin"), member(OTHER, nick)];
      expect([...sameNamed(roster)], nick).toEqual([ADMIN, OTHER]);
      // Shown as chosen, told apart by the key's end.
      expect(authorName({ members: roster }, OTHER)).toBe(apart(nick, "0th3r9"));
      expect([...sameNamed([member(ME, undefined, "member", true), member(OTHER, nick)], roster[0]!.nick)], nick).toEqual([ME, OTHER]);
    }
    // A name all in another alphabet reads as it is, apart from any Latin one.
    expect(sameNamed([member(ADMIN, "Алиса", "admin"), member(OTHER, "Alice")]).size).toBe(0);
    expect(sameNamed([member(ADMIN, "Δημήτρης", "admin"), member(OTHER, "Dimitris")]).size).toBe(0);
    expect(sameNamed([member(ADMIN, "Алиса", "admin"), member(OTHER, "Алиса")]).size).toBe(2);
  });

  it("a name that copies another member's key end shows only its own, right after the name, however it is padded", async () => {
    // The admin's key ends "adm1n0": a member named "Alice (…adm1n0)" padded with blank Braille to the 64-character cap
    // had its own key's end pushed past where the line above its messages is cut.
    const fakes = [
      "Alice (…adm1n0)", `Alice (…adm1n0)${"⠀".repeat(49)}`, `Alice${"⠀".repeat(20)} (…adm1n0)${"ㅤ".repeat(20)}`,
      "Alice （…adm1n0）", "Alice (...adm1n0)",
    ];
    for (const fake of fakes) {
      expect(sanitizeNick(fake), fake).toBe(fake);
      const roster = [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, fake)];
      expect(authorName({ profile: "mesh", members: roster }, OTHER), fake).toBe(apart("Alice", "0th3r9"));
      expect(authorName({ profile: "mesh", members: roster }, ADMIN), fake).toBe(apart("Alice", "adm1n0"));
    }
    openChat({ profile: "mesh", members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, fakes[1])] },
      [said("g1", ADMIN, "from the admin", 0), said("g2", OTHER, "send the deposit here", 1)]);
    expect(nickOf(await rowOf("send the deposit here"))).toBe(`~${apart("Alice", "0th3r9")}`);
    expect(nickOf(await rowOf("from the admin"))).toBe(`~${apart("Alice", "adm1n0")}`);
  });

  it("in a private group, a member removed and invited again is named as before, her old key's messages as her new key's", () => {
    // Carol's key before her removal is a former member's; her new one is in the roster. Only the admin invites in a
    // private group: no stranger came in by a link to take her name.
    const CAROL_THEN = "carolthen".padEnd(46, "y") + "c4r0l1", CAROL_NOW = "carolnow".padEnd(46, "y") + "c4r0l2";
    const roster = [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(CAROL_NOW, "Carol")];
    const mesh = { profile: "mesh" as const, members: roster, formerNames: { [CAROL_THEN]: "Carol" } };
    expect(authorName(mesh, CAROL_THEN)).toBe("Carol");
    expect(authorName(mesh, CAROL_NOW)).toBe("Carol");
    expect(formerName(mesh, CAROL_THEN, "Carol")).toBe("Carol");
    // Two members in the roster now with one name are still told apart there, the admin's too.
    const clash = { profile: "mesh" as const, members: [...roster, member(OTHER, "alice")] };
    expect(authorName(clash, ADMIN)).toBe(apart("Alice", "adm1n0"));
    expect(authorName(clash, OTHER)).toBe(apart("alice", "0th3r9"));
    // In a community, a name a former member went by is told apart from a member who shows it now.
    const community = { ...mesh, profile: "community" as const };
    expect(authorName(community, CAROL_THEN)).toBe(apart("Carol", "c4r0l1"));
    expect(formerName(community, CAROL_THEN, "Carol")).toBe(apart("Carol", "c4r0l1"));
  });

  it("in a community, the admin's messages and those of a member who took the admin's name read apart, the admin's marked", async () => {
    openChat({ profile: "community", members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Alice")] },
      [said("g1", ADMIN, "from the admin", 0), said("g2", OTHER, "send the deposit here", 1)]);
    const admin = await rowOf("from the admin"), other = await rowOf("send the deposit here");
    // The mark is beside the name, never in it: the name is only what the member says it is.
    expect(nickOf(admin)).toBe(`~${apart("Alice", "adm1n0")}`);
    expect(within(admin).getByTestId("message-nick-admin")).toHaveTextContent("admin");
    expect(nickOf(other)).toBe(`~${apart("Alice", "0th3r9")}`);
    expect(within(other).queryByTestId("message-nick-admin")).toBeNull();
  });

  it("in a private group, the lines that name the admin carry the mark (but the one that says they are the admin), and a former member's name stays as it was", async () => {
    openChat({ profile: "mesh", formerNames: { [GONE]: "Alice" }, members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Bob")] }, [
      line("e1", ADMIN, "admin", "Alice is now the admin", 0),
      line("e2", ADMIN, "renamed", "Alice renamed the group to “Book club”", 1),
      line("e3", GONE, "left", "Alice left", 2),
      line("e4", OTHER, "renamed", "Bob renamed the group to “Book club”", 3),
      said("g1", ADMIN, "from the admin", 4), said("g2", OTHER, "from Bob", 5),
    ]);
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual([
      "Alice is now the admin", "Alice admin renamed the group to “Book club”", "Alice left", "Bob renamed the group to “Book club”",
    ]);
    // The line that hands her the role says it already: a mark there would only say "admin" twice.
    expect(lines.map(l => !!within(l).queryByTestId("group-event-admin"))).toEqual([false, true, false, false]);
    // A roster with no two of one name: the names stay as they are, the admin's still marked.
    expect(within(await rowOf("from the admin")).getByTestId("message-nick")).toHaveTextContent(/^~Alice$/);
    expect(within(await rowOf("from the admin")).getByTestId("message-nick-admin")).toBeInTheDocument();
    expect(within(await rowOf("from Bob")).queryByTestId("message-nick-admin")).toBeNull();
  });

  it("in a community, the line that hands the admin the role names them once, told apart from a member of the same name, and their other lines keep the mark", async () => {
    openChat({ profile: "community", members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Alice")] }, [
      line("e1", OTHER, "joined", "Alice joined", 0),
      line("e2", ADMIN, "admin", "Alice is now the admin", 1),
      line("e3", ADMIN, "renamed", "Alice renamed the group to “Book club”", 2),
    ]);
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual([
      `${apart("Alice", "0th3r9")} joined`, `${apart("Alice", "adm1n0")} is now the admin`, `${apart("Alice", "adm1n0")} admin renamed the group to “Book club”`,
    ]);
    expect(lines.map(l => !!within(l).queryByTestId("group-event-admin"))).toEqual([false, false, true]);
  });

  it("in a community, a member who took a former member's name reads apart from what the former member wrote", async () => {
    openChat({ profile: "community", formerNames: { [GONE]: "Carol" }, members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Carol")] }, [
      said("g1", GONE, "carol before", 0), line("e1", GONE, "left", "Carol left", 1), said("g2", OTHER, "carol now", 2),
    ]);
    expect(nickOf(await rowOf("carol before"))).toBe(`~${apart("Carol", "g0n3ab")}`);
    expect(within(await rowOf("carol now")).getByTestId("message-nick")).toHaveTextContent(/^~Carol$/);
    expect((await screen.findAllByTestId("group-event")).map(l => l.textContent)).toEqual([`${apart("Carol", "g0n3ab")} left`]);
  });
});
