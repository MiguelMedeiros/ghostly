import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupShareDialog } from "../../components/GroupLinkPanel";
import { LeaveGroupDialog } from "../../components/LeaveGroupDialog";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A group's, a member's or an inviter's name in a group's titles and lines, in a language of the other direction: each
 * isolated, as the membership lines' names are (groupEventNamesIsolated). Put in plainly, the punctuation or emoji at a
 * name's end took the sentence's direction and was drawn on the other side: "مغادرة !Club؟" in Arabic.
 */

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const LINK = encodeGroupEntryLink({ g: ID, host: createIdentity().pubKeyZ32 });
const ME = "me".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const admin = (patch: Partial<GroupView> = {}) => groupView({
  id: ID, status: "active", epoch: 1, isAdmin: true, name: "Club!", entryLink: LINK,
  members: [member({ key: ME, me: true, role: "admin" }), member({ key: BOB, nick: "Bob!" })], ...patch,
});
/** The name between FSI and PDI, as a string with no room for a <bdi> holds it. */
const iso = (name: string) => `⁨${name}⁩`;
/** The <bdi>s holding exactly this name inside the element. */
const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].filter(bdi => bdi.textContent === name).length;

function openGroup(group: GroupView) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/" element={<p>Chat list</p>} /><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: `/group/${ID}`, language: "ar" });
}

describe("names in a group's titles and lines, in Arabic, each isolated", () => {
  it.each([false, true])("Leave and Delete name the group and the next admin isolated (forget: %s)", (forget) => {
    renderApp(<LeaveGroupDialog group={admin()} forget={forget} onClose={() => {}} onConfirm={async () => {}} />, { language: "ar" });
    const dialog = screen.getByTestId("group-leave-dialog");
    expect(isolated(within(dialog).getByRole("heading"), "Club!")).toBe(1);
    // The next admin, twice: they become the admin, and they can share a new link.
    expect(isolated(within(dialog).getByTestId("group-leave-successor"), "Bob!")).toBe(2);
  });

  it.each([false, true])("the Share dialog's title names the group isolated (created: %s)", (created) => {
    renderApp(<GroupShareDialog group={admin()} created={created} onClose={() => {}} />, { language: "ar" });
    expect(isolated(within(screen.getByTestId("group-share-dialog")).getByRole("heading"), "Club!")).toBe(1);
  });

  it("the link handed to the share sheet is titled with the group's name isolated", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      const { user } = renderApp(<GroupShareDialog group={admin()} onClose={() => {}} />, { language: "ar" });
      await user.click(screen.getByTestId("group-link-share"));
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: `انضم إلى ${iso("Club!")} على Ghostly` }));
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it("an invitation's header, card and Delete dialog name the inviter and the group isolated", async () => {
    const { user } = openGroup(groupView({ id: ID, name: "Club!", canSend: false, invitation: { linkId: "link-1", contact: "Alice!", admin: ALICE, members: 3, accepted: false } }));
    expect(screen.getByTestId("group-members").textContent).toBe(`دعوة من ${iso("Alice!")}`);
    expect(screen.getByTestId("group-invitation").textContent).toContain(iso("Alice!"));
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("group-forget"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(`حذف ${iso("Club!")}؟`);
    expect(dialog.textContent).toContain(`سيعرف ${iso("Alice!")} أنك رفضتها.`);
  });

  it("an invitation taken back names who took it back and the group isolated", () => {
    openGroup(groupView({ id: ID, name: "Club!", canSend: false, invitation: { linkId: "link-1", contact: "Alice!", admin: ALICE, members: 3, accepted: false, takenBack: true } }));
    const page = screen.getByTestId("group-chat").textContent!;
    expect(page).toContain(iso("Alice!"));
    expect(page).toContain(iso("Club!"));
  });

  it("another group under this one's id names its inviter and its name isolated", () => {
    openGroup(admin({ others: [{ linkId: "chat-ab", contact: "Alice!", name: "Family ⚽", members: 3 }] }));
    const [other] = within(screen.getByTestId("group-others")).getAllByTestId("group-other");
    expect(other.textContent).toContain(`دعاك ${iso("Alice!")} إلى ${iso("Family ⚽")}`);
  });
});
