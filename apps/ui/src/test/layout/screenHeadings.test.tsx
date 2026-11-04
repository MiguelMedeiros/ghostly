import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { Home } from "../../pages/Home";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.mobile-layout

/**
 * The screens used most have a heading a screen reader's heading keys find, as the menu pages have (layout/Page.tsx):
 * the open chat's or group's name is the h1 of its header, the home screen's "Ghostly" its h1, and the chat list is
 * named by a heading: an h1 on a phone, where it is the whole screen, an h2 beside the open chat on a wide window.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p"), ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
afterEach(() => viewport(1024, 768));

const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });

describe("the headings of the messaging screens", () => {
  it("a 1:1 chat's name is the h1 of its header, and still the button that renames it", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Cérebro (Mac)", messages: [], createdAt: 1_700_000_000_000 });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName("Cérebro (Mac)");
    expect(heading).toContainElement(screen.getByTestId("chat-name"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("a group's name is the h1 of its header", () => {
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 2, name: "Book club", members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })] })] });
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName("Book club");
    expect(heading).toHaveAttribute("data-testid", "group-name");
  });

  it("the home screen's name is its h1", () => {
    renderApp(<Home />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("Ghostly");
  });

  it("the chat list is named by an h1 on a phone, where it is the whole screen", () => {
    viewport(375, 667);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("Chats");
  });

  it("beside the open chat on a wide window, by an h2: the chat's name is the window's h1", () => {
    viewport(1280, 800);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveAccessibleName("Chats");
  });

  it("in Arabic too", () => {
    viewport(375, 667);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "ar" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("المحادثات");
  });
});
