import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: extension.reconnecting

/**
 * An extension tab that lost its peer, with a chat open on a phone width: the list's "Reconnecting…" is on another
 * screen, and the chat looked live while what was sent stayed in the field. The same sentence shows under the chat's
 * header, as the offline one does. Wider, the list beside the chat has it, and the chat does not say it twice.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const SENTENCE = "Reconnecting… · This tab lost Ghostly and keeps trying. New messages show here once it's back.";

afterEach(async () => {
  fakeEngine.refuse = null;
  await engine.connect();
  vi.restoreAllMocks();
});

/** The peer goes away and does not come back: the page's tries to reach it fail from the first one on. */
function losePeer() {
  fakeEngine.refuse = new Error("The offscreen document did not start");
  fakeEngine.drop();
}

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

function openGroup() {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1 })] });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

describe("reconnecting, in an open chat", () => {
  it("on a phone, says it under the chat's header, and goes once the page is connected again", async () => {
    windowIs(true);
    openChat();
    await screen.findByTestId("chat-options");
    expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument();
    losePeer();
    const banner = await screen.findByTestId("chat-reconnecting-banner", {}, { timeout: 3000 });
    expect(banner).toHaveTextContent(SENTENCE);
    expect(banner).toHaveAttribute("role", "status");
    fakeEngine.refuse = null;
    await vi.waitFor(() => expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it("on a phone, in a group too", async () => {
    windowIs(true);
    openGroup();
    losePeer();
    expect(await screen.findByTestId("chat-reconnecting-banner", {}, { timeout: 3000 })).toHaveTextContent(SENTENCE);
  });

  it("wider than a phone, leaves it to the chat list beside the chat", async () => {
    windowIs(false);
    openChat();
    await screen.findByTestId("chat-options");
    losePeer();
    await vi.waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
    expect(screen.queryByTestId("chat-reconnecting-banner")).not.toBeInTheDocument();
  });
});
