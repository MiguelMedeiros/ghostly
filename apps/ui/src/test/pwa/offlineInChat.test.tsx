import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "../../components/OfflineBanner";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.pwa.offline

/**
 * Offline in an open chat on a phone: the list's notice is on another screen, and the header's icon alone says it only
 * to a screen reader or after a tap. The same sentence shows under the chat's header. Wider, the list beside the chat
 * has it, and the chat does not say it twice.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const SENTENCE = "Offline · Your chats are here. Nothing goes out until you're back online.";
afterEach(() => vi.restoreAllMocks());

const offline = () => vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

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

describe("offline, in an open chat", () => {
  it("on a phone, says it under the chat's header, in words", async () => {
    windowIs(true);
    offline();
    openChat();
    const banner = await screen.findByTestId("chat-offline-banner");
    expect(banner).toHaveTextContent(SENTENCE);
    expect(banner).toHaveAttribute("role", "status");
  });

  it("on a phone, in a group too", async () => {
    windowIs(true);
    offline();
    openGroup();
    expect(await screen.findByTestId("chat-offline-banner")).toHaveTextContent(SENTENCE);
  });

  it("online, says nothing", async () => {
    windowIs(true);
    openChat();
    await screen.findByTestId("chat-options");
    expect(screen.queryByTestId("chat-offline-banner")).not.toBeInTheDocument();
  });

  it("wider than a phone, leaves it to the chat list beside the chat", async () => {
    windowIs(false);
    offline();
    openChat();
    await screen.findByTestId("chat-options");
    expect(screen.queryByTestId("chat-offline-banner")).not.toBeInTheDocument();
  });
});

describe("the chat list's offline notice", () => {
  // At 1280 px the 420 px list cut it to "… Nothing goes out until you're bac…", with no way to read the rest.
  it("wraps its sentence rather than cutting it", () => {
    offline();
    renderApp(<OfflineBanner />);
    const banner = screen.getByTestId("offline-banner");
    expect(banner).toHaveTextContent(SENTENCE);
    for (const el of [banner, ...banner.querySelectorAll("*")]) {
      expect(el.className, el.tagName).not.toMatch(/\b(truncate|whitespace-nowrap|line-clamp-\d|text-ellipsis)\b/);
    }
  });
});
