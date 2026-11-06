import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
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

describe("a group's members with one name", () => {
  it("are each told apart by the end of their key, whatever case, width or spacing tells them apart", () => {
    const roster = [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, " ａｌｉｃｅ  ")];
    const same = sameNamed(roster);
    expect(memberName(roster[1]!, undefined, same)).toBe("Alice (…adm1n0)");
    expect(memberName(roster[2]!, undefined, same)).toBe(" ａｌｉｃｅ   (…0th3r9)");
    expect(authorName({ members: roster }, ADMIN)).toBe("Alice (…adm1n0)");
    // A name that already shows a key's end is the same name.
    expect(sameNamed([member(ADMIN, "Alice", "admin"), member(OTHER, "Alice (…adm1n0)")]).has(OTHER)).toBe(true);
    // Mine counts: a member who takes my name is told apart from me.
    expect([...sameNamed([member(ME, undefined, "member", true), member(OTHER, "Bob")], "bob")]).toEqual([ME, OTHER]);
    expect(sameNamed([member(ADMIN, "Alice", "admin"), member(OTHER, "Alicia")]).size).toBe(0);
    // In a community, a member gone since, by the name the group knew them by: told apart from a member who has it now.
    const community = { profile: "community" as const, members: roster };
    expect(authorName({ ...community, formerNames: { [GONE]: "alice" } }, GONE)).toBe("alice (…g0n3ab)");
    expect(formerName(community, GONE, "Carol")).toBe("Carol");
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
    expect(authorName(clash, ADMIN)).toBe("Alice (…adm1n0)");
    expect(authorName(clash, OTHER)).toBe("alice (…0th3r9)");
    // In a community, a name a former member went by is told apart from a member who shows it now.
    const community = { ...mesh, profile: "community" as const };
    expect(authorName(community, CAROL_THEN)).toBe("Carol (…c4r0l1)");
    expect(formerName(community, CAROL_THEN, "Carol")).toBe("Carol (…c4r0l1)");
  });

  it("in a community, the admin's messages and those of a member who took the admin's name read apart, the admin's marked", async () => {
    openChat({ profile: "community", members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Alice")] },
      [said("g1", ADMIN, "from the admin", 0), said("g2", OTHER, "send the deposit here", 1)]);
    const admin = await rowOf("from the admin"), other = await rowOf("send the deposit here");
    // The mark is beside the name, never in it: the name is only what the member says it is.
    expect(within(admin).getByTestId("message-nick")).toHaveTextContent(/^~Alice \(…adm1n0\)$/);
    expect(within(admin).getByTestId("message-nick-admin")).toHaveTextContent("admin");
    expect(within(other).getByTestId("message-nick")).toHaveTextContent(/^~Alice \(…0th3r9\)$/);
    expect(within(other).queryByTestId("message-nick-admin")).toBeNull();
  });

  it("in a private group, the lines that name the admin carry the mark, and a former member's name stays as it was", async () => {
    openChat({ profile: "mesh", formerNames: { [GONE]: "Alice" }, members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Bob")] }, [
      line("e1", ADMIN, "admin", "Alice is now the admin", 0),
      line("e2", ADMIN, "renamed", "Alice renamed the group to “Book club”", 1),
      line("e3", GONE, "left", "Alice left", 2),
      line("e4", OTHER, "renamed", "Bob renamed the group to “Book club”", 3),
      said("g1", ADMIN, "from the admin", 4), said("g2", OTHER, "from Bob", 5),
    ]);
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual([
      "Alice admin is now the admin", "Alice admin renamed the group to “Book club”", "Alice left", "Bob renamed the group to “Book club”",
    ]);
    expect(lines.map(l => !!within(l).queryByTestId("group-event-admin"))).toEqual([true, true, false, false]);
    // A roster with no two of one name: the names stay as they are, the admin's still marked.
    expect(within(await rowOf("from the admin")).getByTestId("message-nick")).toHaveTextContent(/^~Alice$/);
    expect(within(await rowOf("from the admin")).getByTestId("message-nick-admin")).toBeInTheDocument();
    expect(within(await rowOf("from Bob")).queryByTestId("message-nick-admin")).toBeNull();
  });

  it("in a community, a member who took a former member's name reads apart from what the former member wrote", async () => {
    openChat({ profile: "community", formerNames: { [GONE]: "Carol" }, members: [member(ME, undefined, "member", true), member(ADMIN, "Alice", "admin"), member(OTHER, "Carol")] }, [
      said("g1", GONE, "carol before", 0), line("e1", GONE, "left", "Carol left", 1), said("g2", OTHER, "carol now", 2),
    ]);
    expect(within(await rowOf("carol before")).getByTestId("message-nick")).toHaveTextContent(/^~Carol \(…g0n3ab\)$/);
    expect(within(await rowOf("carol now")).getByTestId("message-nick")).toHaveTextContent(/^~Carol$/);
    expect((await screen.findAllByTestId("group-event")).map(l => l.textContent)).toEqual(["Carol (…g0n3ab) left"]);
  });
});
