import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupTypingView, GroupView } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.typing

const ANA = "ana".padEnd(52, "y"), BO = "bo".padEnd(52, "y"), CY = "cy".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const members = [member({ key: ME, me: true }), member({ key: ANA, nick: "Ana", role: "admin" }), member({ key: BO, nick: "Bo" }), member({ key: CY, nick: "Cy" })];
const active = (typing?: GroupTypingView[], patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, members, ...(typing ? { typing } : {}), ...patch });

function openGroup(group: GroupView) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({ groups: [group] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}
const line = () => screen.getByTestId("group-typing");

describe("GroupChat: who is typing", () => {
  it("names one, two, or counts them, in the header's place of the member count", async () => {
    openGroup(active());
    expect(await screen.findByTestId("group-members")).toHaveTextContent("4 members");
    expect(screen.queryByTestId("group-typing")).not.toBeInTheDocument();
    act(() => fakeEngine.update({ groups: [active([{ key: ANA }])] }));
    expect(line()).toHaveTextContent("Ana is typing…");
    expect(screen.getByTestId("group-members")).not.toHaveTextContent("4 members");
    act(() => fakeEngine.update({ groups: [active([{ key: ANA }, { key: BO }])] }));
    expect(line()).toHaveTextContent("Ana and Bo are typing…");
    act(() => fakeEngine.update({ groups: [active([{ key: ANA }, { key: BO }, { key: CY }])] }));
    expect(line()).toHaveTextContent("3 people are typing…");
    act(() => fakeEngine.update({ groups: [active()] }));
    expect(screen.queryByTestId("group-typing")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-members")).toHaveTextContent("4 members");
  });

  it("says recording and thinking the same way, plain typing when they differ, and a bot's status after its name", async () => {
    openGroup(active([{ key: ANA, kind: "recording" }]));
    expect(await screen.findByTestId("group-typing")).toHaveTextContent("Ana is recording audio…");
    act(() => fakeEngine.update({ groups: [active([{ key: ANA, kind: "thinking" }, { key: BO, kind: "thinking" }])] }));
    expect(line()).toHaveTextContent("Ana and Bo are thinking…");
    expect(line()).toHaveAttribute("data-kind", "thinking");
    act(() => fakeEngine.update({ groups: [active([{ key: ANA, kind: "thinking" }, { key: BO }])] }));
    expect(line()).toHaveTextContent("Ana and Bo are typing…");
    act(() => fakeEngine.update({ groups: [active([{ key: BO, kind: "thinking", status: "Reading the thread" }])] }));
    expect(line()).toHaveTextContent("Bo: Reading the thread");
    expect(screen.getByTestId("group-typing-status").tagName).toBe("BDI");
  });

  it("names someone the roster does not know by their key", async () => {
    openGroup(active([{ key: "zed".padEnd(52, "y") }]));
    expect(await screen.findByTestId("group-typing")).toHaveTextContent("Member zedyyyyy is typing…");
  });

  it("speaks the app's language", async () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
    fakeEngine.update({ groups: [active([{ key: ANA }, { key: BO }])] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    expect(await screen.findByTestId("group-typing")).toHaveTextContent("Ana e Bo estão digitando…");
  });

  it("tells the engine while this side types, and stops when the message goes", async () => {
    const { user, engine } = openGroup(active());
    engine.on("sendGroupMessage", () => ({ error: null }));
    await user.type(screen.getByRole("textbox"), "hi");
    expect(engine.callsTo("setGroupTyping")[0]).toEqual({ groupId: "group-1", typing: true });
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(engine.callsTo("setGroupTyping").at(-1)).toEqual({ groupId: "group-1", typing: false });
  });

  it("a community says nothing yet", async () => {
    const { user, engine } = openGroup(active(undefined, { profile: "community", community: { hub: false, hubs: 1, connected: 1 } }));
    await user.type(screen.getByRole("textbox"), "hi");
    expect(engine.callsTo("setGroupTyping")).toEqual([]);
  });
});
