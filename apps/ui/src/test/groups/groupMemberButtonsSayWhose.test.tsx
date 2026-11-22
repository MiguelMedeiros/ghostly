import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, LinkView } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { shownInName } from "../labelInName";

// covers: groups.remove-member, groups.admin-change, groups.invite, app.i18n

/*
 * The admin's members list: each member's Hand over admin and Remove, and each contact's Invite, say whose they are to
 * a screen reader. They all read "Remove, button" (or "Hand over admin", "Invite") down the list, never whose. The
 * visible word stays short; the name each button is read by holds it and the member's (or contact's) name, isolated
 * (FSI … PDI) so a Latin name with a bracket keeps its own direction in an Arabic sentence.
 */

const ME = "me".padEnd(52, "y"), ANA = "ana".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const NAMES: Record<string, string> = { [ANA]: "Ana (work)", [BOB]: "Bob" };
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const members = [member({ key: ME, me: true, role: "admin" }), member({ key: ANA, nick: NAMES[ANA] }), member({ key: BOB, nick: NAMES[BOB] })];
const paired = (patch: Partial<LinkView>) => linkView({ profile: "paired-chat/1", groups: true, ...patch });
const CONTACTS: Record<string, string> = { "link-carol": "Carol", "link-dan": "Dan [home]" };

/** What a screen reader says of a button: its name and, after it, its description (what `aria-describedby` points at). */
function said(button: HTMLElement): string {
  const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
  expect(button).toHaveAccessibleName(name.trim());
  // Label in Name: a voice-control user says the word they see.
  expect(button).toHaveAccessibleName(shownInName(button));
  const described = (button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
  return `${name} ${described}`.trim();
}

const WORDS = {
  en: { remove: "Remove", makeAdmin: "Hand over admin", invite: "Invite" },
  ar: { remove: "إزالة", makeAdmin: "تسليم الإشراف", invite: "دعوة" },
} as const;

describe.each(["en", "ar"] as const)("in %s, the admin's members list says whose each button is", language => {
  function open() {
    const group = groupView({ status: "active", isAdmin: true, myKey: ME, members });
    const links = Object.entries(CONTACTS).map(([id, label]) => paired({ id, label }));
    fakeEngine.update({ groups: [group], links });
    renderApp(<GroupMembersDialog group={group} onClose={() => {}} />, { language });
  }
  const rowOf = (key: string) => screen.getAllByTestId("group-member").find(row => row.dataset.key === key)!;

  it.each([["group-remove-member", "remove"], ["group-make-admin", "makeAdmin"]] as const)("each member's %s", (testId, word) => {
    open();
    const spoken = [ANA, BOB].map(key => {
      const button = within(rowOf(key)).getByTestId(testId);
      // The visible word stays the short one.
      expect(button).toHaveTextContent(new RegExp(`^${WORDS[language][word]}$`));
      const text = said(button);
      expect(text, `${testId} of ${NAMES[key]}`).toContain(WORDS[language][word]);
      expect(text, `${testId} of ${NAMES[key]}`).toContain(`\u2068${NAMES[key]}\u2069`);
      return text;
    });
    expect(new Set(spoken).size, spoken.join(" | ")).toBe(2);
  });

  it("each contact's Invite", () => {
    open();
    const contacts = screen.getAllByTestId("group-invite-contact");
    expect(contacts.map(c => c.dataset.link)).toEqual(Object.keys(CONTACTS));
    const spoken = contacts.map(row => {
      const button = within(row).getByTestId("group-invite");
      expect(button).toHaveTextContent(new RegExp(`^${WORDS[language].invite}$`));
      const text = said(button), name = CONTACTS[row.dataset.link!];
      expect(text, `Invite of ${name}`).toContain(WORDS[language].invite);
      expect(text, `Invite of ${name}`).toContain(`\u2068${name}\u2069`);
      return text;
    });
    expect(new Set(spoken).size, spoken.join(" | ")).toBe(2);
  });
});

it("two members showing the same name: their buttons are told apart by the end of the key, as the questions are", () => {
  const ANA2 = "ana2".padEnd(52, "z");
  const group = groupView({ status: "active", isAdmin: true, myKey: ME, members: [members[0], member({ key: ANA, nick: "Ana" }), member({ key: ANA2, nick: "Ana" })] });
  fakeEngine.update({ groups: [group] });
  renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
  const removes = screen.getAllByTestId("group-remove-member");
  expect(removes.map(b => b.getAttribute("aria-label"))).toEqual([
    `Remove \u2068Ana \u2066(…${ANA.slice(-6)})\u2069\u2069`, `Remove \u2068Ana \u2066(…${ANA2.slice(-6)})\u2069\u2069`,
  ]);
});
