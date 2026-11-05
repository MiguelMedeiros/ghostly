import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.invite, groups.link.join

const LINK = `group1/${"g".repeat(22)}/${"k".repeat(52)}`;

function open() {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
    .update({ groups: [groupView({ others: [{ linkId: "chat-ab", contact: "Alice", name: "Family", members: 3 }, { link: LINK }] })] });
  return renderApp(<Routes><Route path="/" element={<p>Chat list</p>} /><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

/** Another group came under the id of one held: the page says so and the person picks the real one. */
describe("another group under this group's id", () => {
  it("is shown on the group's page, each with Switch, and Keep this one", async () => {
    const { user, engine } = open();
    const band = screen.getByTestId("group-others");
    expect(band).toHaveTextContent("Another group has this group's id");
    const others = within(band).getAllByTestId("group-other");
    expect(others[0]).toHaveTextContent("Alice invited you to Family (3 members)");
    expect(others[1]).toHaveTextContent("A group link you opened");
    const keep = vi.fn(), change = vi.fn();
    engine.on("keepGroup", keep).on("switchGroup", change);
    await user.click(within(others[1]).getByTestId("group-other-switch"));
    expect(change).toHaveBeenCalledWith({ groupId: "group-1", to: LINK });
    await user.click(within(band).getByTestId("group-others-keep"));
    expect(keep).toHaveBeenCalledWith({ groupId: "group-1" });
  });

  it("a switch the engine refuses says why on the page", async () => {
    const { user, engine } = open();
    engine.on("switchGroup", () => { throw new Error("You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first."); });
    await user.click(within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch"));
    expect(await screen.findByTestId("group-notice")).toHaveTextContent(/admin/i);
  });
});
