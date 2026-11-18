import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.invite

const CLIMBING = "Climbing", FAMILY_AR = "العائلة";
type Patch = Partial<NonNullable<GroupView["invitation"]>>;
const invitation = (id: string, name: string, patch: Patch) =>
  groupView({ id, name, canSend: false, invitation: { linkId: `link-${id}`, contact: "Alice", admin: "a".padEnd(52, "y"), members: 3, accepted: false, ...patch } });

const KINDS: [string, Patch, string[]][] = [
  ["an invitation", {}, ["group-accept", "group-decline"]],
  ["a link nobody answered", { accepted: true, viaLink: true, admin: "", stage: "knocked", unanswered: true }, ["group-link-retry"]],
  ["a taken-back invitation", { takenBack: true }, ["group-taken-back-delete"]],
];

/**
 * Accept, Decline, Try again and Delete sit outside the row's open button, so they don't take its name: with two
 * invitations in the list, a screen reader moving by buttons heard "Accept", "Accept", with no group to tell them apart.
 */
describe("An invitation row's buttons say which group they answer", () => {
  for (const language of ["en", "ar"] as const) {
    for (const [kind, patch, buttons] of KINDS) {
      it(`${kind}'s ${buttons.join(" and ")} (${language})`, () => {
        fakeEngine.update({ groups: [invitation("group-1", CLIMBING, patch), invitation("group-2", FAMILY_AR, patch)] });
        renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language });
        const row = (id: string) => screen.getAllByTestId("group-row").find(r => r.dataset.group === id)!;
        for (const testId of buttons) {
          // Described by its own row's name, and only by it: each Accept tells its group apart from the other's.
          expect(within(row("group-1")).getByTestId(testId)).toHaveAccessibleDescription(CLIMBING);
          expect(within(row("group-2")).getByTestId(testId)).toHaveAccessibleDescription(FAMILY_AR);
        }
      });
    }
  }
});
