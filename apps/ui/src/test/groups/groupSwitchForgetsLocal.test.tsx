import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { GroupChat } from "../../pages/GroupChat";
import { mentionsNotify, mutedUntil, setChatMute, setMentionsNotify } from "../../lib/chatMute";
import { groupReadAt, markGroupRead } from "../../lib/groups";
import { getSessionDraft, setSessionDraft } from "../../lib/storage";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

/*
 * Switch takes another group under this one's id in its place, as Delete takes this one: what this device kept of the
 * group switched away from (draft, mute, read mark) goes with it. It used to stay, so the other group, of other people,
 * opened with this one's unsent text in its field, muted, and its messages from before the old read mark read.
 */
describe("Switch to another group under the same id", () => {
  const forgotten = () => ({ draft: getSessionDraft("group:group-1"), muted: mutedUntil("group:group-1") !== undefined, readAt: groupReadAt("group-1"), mentions: mentionsNotify("group:group-1") });

  function openWithOther() {
    setSessionDraft("group:group-1", "plan for the old group");
    setChatMute("group:group-1", "forever");
    markGroupRead("group-1", 4_000_000_000_000);
    setMentionsNotify("group:group-1", false);
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
      .update({ groups: [groupView({ others: [{ linkId: "chat-ab", contact: "Alice", name: "Family", members: 3 }] })] });
    return renderApp(<Routes><Route path="/" element={<p>Chat list</p>} /><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  }

  it("does not hand the old group's draft, mute and read mark to the other group", async () => {
    const { user, engine } = openWithOther();
    expect(await screen.findByDisplayValue("plan for the old group")).toBeInTheDocument();
    engine.on("switchGroup", () => {
      engine.update({ groups: [groupView({ name: "Family", canSend: false, invitation: { linkId: "chat-ab", contact: "Alice", admin: "a", members: 3, accepted: false } })] });
    });
    await user.click(within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(screen.queryByTestId("group-others")).not.toBeInTheDocument());
    // Past the field's own delayed save of what it holds.
    await act(async () => { await new Promise(r => setTimeout(r, 1_000)); });
    expect(forgotten()).toEqual({ draft: "", muted: false, readAt: 0, mentions: true });
    expect(screen.queryByDisplayValue("plan for the old group")).not.toBeInTheDocument();
  });

  it("keeps them when the switch did not go", async () => {
    const { user, engine } = openWithOther();
    engine.on("switchGroup", () => { throw new Error("the other group is gone"); });
    await user.click(within(screen.getAllByTestId("group-other")[0]).getByTestId("group-other-switch"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch" }));
    await act(async () => { await new Promise(r => setTimeout(r, 200)); });
    expect(forgotten()).toEqual({ draft: "plan for the old group", muted: true, readAt: 4_000_000_000_000, mentions: false });
  });
});
