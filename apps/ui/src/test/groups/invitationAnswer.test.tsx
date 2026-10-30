import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GroupChat } from "../../pages/GroupChat";
import { problemText } from "../../lib/problemText";
import { translatorFor } from "../../locales";
import { fakeEngine, groupView } from "../fakeEngine";
import { LANGUAGES } from "../i18n/locales";
import { renderApp } from "../render";

// covers: groups.invite

const ALICE = "alice".padEnd(52, "y");
/** The engine's refusals of an answer this app cannot give now (packages/browser/src/engine/node.ts). */
const OFFLINE = "Go online to join a group";
const LIMITED_MODE_ERROR = "Ghostly could not check which device is active yet. This works once it can.";

async function answer(language: (typeof LANGUAGES)[number], button: "group-accept" | "group-decline", error: string) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
    .update({ groups: [groupView({ canSend: false, invitation: { linkId: "link-1", contact: "Ana", admin: ALICE, members: 3, accepted: false } })] });
  const { user, engine } = renderApp(<Routes><Route path="/" element={<p>Chat list</p>} /><Route path="/group/:groupId" element={<GroupChat />} /></Routes>,
    { route: "/group/group-1", language });
  engine.on("acceptGroupInvitation", () => { throw new Error(error); }).on("declineGroupInvitation", () => { throw new Error(error); });
  await user.click(within(screen.getByTestId("group-invitation")).getByTestId(button));
  return { line: await screen.findByTestId("group-answer-refused"), user };
}

/**
 * An answer refused for this app's own state (offline, or limited mode) says so, as problemText does for every other
 * group action: it blamed the inviter ("Ana is not connected yet") or said only "That did not go through. Try again."
 */
describe("An invitation's answer this app cannot give now", () => {
  const cases = [["offline", "group-accept", OFFLINE], ["limited mode", "group-accept", LIMITED_MODE_ERROR], ["limited mode", "group-decline", LIMITED_MODE_ERROR]] as const;
  for (const language of LANGUAGES) {
    for (const [state, button, error] of cases) {
      it(`${state}, ${button === "group-accept" ? "Accept" : "Decline"} says this app's state, not the inviter's (${language})`, async () => {
        const t = translatorFor(language);
        const { line } = await answer(language, button, error);
        const problem = problemText(new Error(error), t);
        expect(line).toHaveTextContent(problem.title);
        expect(line).toHaveTextContent(problem.next!);
        expect(line).not.toHaveTextContent("Ana");
        expect(line).not.toHaveTextContent(t("sidebar.group.answerFailed"));
        expect(within(line).queryByRole("button") !== null).toBe(problem.detail !== undefined);
      });
    }
  }

  it("an error nothing knows keeps its words behind the ⓘ", async () => {
    const { line, user } = await answer("en", "group-accept", "The admin is gone");
    expect(line).toHaveTextContent("That did not go through. Try again.");
    await user.click(within(line).getByRole("button"));
    expect(line).toHaveTextContent("The admin is gone");
  });
});
