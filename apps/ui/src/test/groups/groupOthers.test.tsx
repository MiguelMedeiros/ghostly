import { act, screen, within } from "@testing-library/react";
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
  it("is shown on the group's page, each with Switch, and Keep this one in one tap", async () => {
    const { user, engine } = open();
    const band = screen.getByTestId("group-others");
    expect(band).toHaveTextContent("Another group has this group's id");
    const others = within(band).getAllByTestId("group-other");
    expect(others[0]).toHaveTextContent("Alice invited you to Family (3 members)");
    expect(others[1]).toHaveTextContent("A group link you opened");
    const keep = vi.fn();
    engine.on("keepGroup", keep);
    await user.click(within(band).getByTestId("group-others-keep"));
    expect(keep).toHaveBeenCalledWith({ groupId: "group-1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Switching leaves the group held here and deletes it from this device, as Delete does: asked first, as Delete is.
  it("Switch asks first, naming the other picked; only Switch in the dialog switches", async () => {
    const { user, engine } = open();
    const change = vi.fn();
    engine.on("switchGroup", change);
    await user.click(within(screen.getAllByTestId("group-other")[1]).getByTestId("group-other-switch"));
    expect(change, "one tap does not switch").not.toHaveBeenCalled();
    const ask = screen.getByRole("dialog");
    expect(ask).toHaveAccessibleName("Switch to the other group?");
    expect(ask).toHaveAccessibleDescription("A group link you opened. This group is left and deleted from this device with its history, and that one takes its place.");
    expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(ask).getByRole("button", { name: "Switch" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ groupId: "group-1", to: LINK });
  });

  it("with several others, the dialog names the one whose Switch was pressed", async () => {
    const { user, engine } = open();
    const change = vi.fn();
    engine.on("switchGroup", change);
    await user.click(within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch"));
    const ask = screen.getByRole("dialog");
    expect(ask).toHaveAccessibleDescription(/^Alice invited you to Family \(3 members\)\. This group is left/);
    expect(ask).not.toHaveAccessibleDescription(/group link/);
    await user.click(within(ask).getByRole("button", { name: "Switch" }));
    expect(change).toHaveBeenCalledWith({ groupId: "group-1", to: "chat-ab" });
  });

  it("Cancel and Escape switch to nothing and give the focus back to that Switch", async () => {
    const { user, engine } = open();
    const change = vi.fn();
    engine.on("switchGroup", change);
    const first = within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch");
    await user.click(first);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(first).toHaveFocus();
    const second = within(screen.getAllByTestId("group-other")[1]).getByTestId("group-other-switch");
    await user.click(second);
    // Escape, as the browser says it to the dialog.
    act(() => { screen.getByRole("dialog").dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(second).toHaveFocus();
    expect(change).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("group-other")).toHaveLength(2);
  });

  it("a switch the engine refuses says why on the page", async () => {
    const { user, engine } = open();
    engine.on("switchGroup", () => { throw new Error("You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first."); });
    await user.click(within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));
    expect(await screen.findByTestId("group-notice")).toHaveTextContent(/admin/i);
  });
});
