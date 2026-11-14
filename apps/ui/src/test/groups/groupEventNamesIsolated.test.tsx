import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A member's or the group's name in a group's membership line, in a language of the other direction: each its own
 * <bdi>, as the admin's name already was. Put in plainly, the punctuation or emoji at a name's end took the sentence's
 * direction and was drawn on the other side: "!Bob", ".J.R", "🎉 Bob" in Arabic.
 */

const ME = "me".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), CAROL = "carol".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const event = (id: string, patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id, text: "", sender: "peer", timestamp: Number(id.slice(1)), via: "datalink", ...patch });

/** The <bdi> holding exactly this name inside the element, if any. */
const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].some((bdi) => bdi.textContent === name);

describe("names in a group's membership lines, in Arabic, each isolated", () => {
  it("a member's, the group's, and a removed member's with the admin who removed them", async () => {
    fakeEngine.update({ groups: [groupView({
      status: "active", epoch: 2, isAdmin: false, name: "Club!",
      members: [member({ key: ME, me: true }), member({ key: BOB, nick: "Bob!" }), member({ key: "admin".padEnd(52, "y"), nick: "Ana 🎉", role: "admin" })],
      formerNames: { [CAROL]: "J.R." },
    })] });
    const history: StoredMessage[] = [
      event("e1", { text: "Bob! joined", event: "joined", member: BOB }),
      event("e2", { text: "Bob! renamed the group to “Club!”", event: "renamed", member: BOB }),
      event("e3", { text: "Bob! changed the group's picture", event: "picture", member: BOB }),
      event("e4", { text: "J.R. left", event: "left", member: CAROL }),
      event("e5", { text: "J.R. is no longer a member", event: "gone", member: CAROL, by: "admin".padEnd(52, "y") }),
    ];
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "ar" });
    const lines = await screen.findAllByTestId("group-event");
    expect(lines.map(l => l.textContent)).toEqual([
      "انضمام Bob! إلى المجموعة",
      "تغيير Bob! اسم المجموعة إلى «Club!»",
      "تغيير Bob! صورة المجموعة",
      "مغادرة J.R. المجموعة",
      "إزالة Ana 🎉 J.R. من المجموعة",
    ]);
    for (const [i, names] of [["Bob!"], ["Bob!", "Club!"], ["Bob!"], ["J.R."], ["Ana 🎉", "J.R."]].entries()) {
      for (const name of names) expect(isolated(lines[i], name), `${name} in line ${i + 1}`).toBe(true);
    }
  });

  it("the admin's name keeps its mark, and the group's name beside it is isolated too", async () => {
    const ADMIN = "admin".padEnd(52, "y");
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 2, isAdmin: false, name: "Club!", members: [member({ key: ME, me: true }), member({ key: ADMIN, nick: "Ana 🎉", role: "admin" })] })] });
    const history = [event("e1", { text: "Ana 🎉 renamed the group to “Club!”", event: "renamed", member: ADMIN })];
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "ar" });
    const [line] = await screen.findAllByTestId("group-event");
    expect(line).toHaveTextContent("تغيير Ana 🎉 مشرف اسم المجموعة إلى «Club!»");
    expect(screen.getByTestId("group-event-admin")).toBeInTheDocument();
    expect(isolated(line, "Ana 🎉")).toBe(true);
    expect(isolated(line, "Club!")).toBe(true);
  });
});
