import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { PageHeader } from "../../components/layout/Page";
import { ChatAppPanel } from "../../components/apps/ChatAppPanel";
import { setChatApp } from "../../lib/apps/running";
import type { RunningApp } from "../../lib/apps/broker";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.i18n

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const ID = "AbCdEfGhIjKlMnOpQrStUv";

/** The arrow in the Back button `testId`: mirrored where the app reads right to left, as the other arrows are. */
const mirrored = (testId: string) => screen.getByTestId(testId).querySelector("svg")?.classList.contains("rtl:-scale-x-100");

afterEach(() => setChatApp("link-1", null));

describe("Back arrows in a right-to-left language point to the start edge", () => {
  it("a page's header", () => {
    renderApp(<PageHeader title="Apps" />);
    expect(mirrored("page-back")).toBe(true);
  });

  it("a chat's header", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    await screen.findByTestId("chat-back");
    expect(mirrored("chat-back")).toBe(true);
  });

  it("a group's header", async () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ id: ID, status: "active", epoch: 1, isAdmin: true, members: [] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: `/group/${ID}` });
    await screen.findByTestId("chat-back");
    expect(mirrored("chat-back")).toBe(true);
  });

  it("a mini-app over its chat on a phone", () => {
    windowIs(true);
    renderApp(<div className="chat-pane"><div className="chat-column" /><ChatAppPanel linkId="link-1" sessionId="s1" contact={{ name: "Ana", named: true }} peerKey={PEER} /></div>);
    act(() => setChatApp("link-1", { ref: "k/chess", title: "Chess", shown: true, wide: false, view: "chat", running: { stop: () => {} } as unknown as RunningApp }));
    expect(mirrored("mini-app-back")).toBe(true);
  });
});
