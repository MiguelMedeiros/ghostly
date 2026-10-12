import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.mobile-layout, app.menus

/**
 * A chat's header on a phone held upright: the name, a voice call and ⋮. The connection, the video call and the
 * contact's identities were buttons and marks beside the name, which was cut to eight letters; they are rows of ⋮ now.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
/** How wide the window is, as matchMedia reads it. */
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
afterEach(() => viewport(1024, 768));

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Cérebro (Mac)", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const MOVED = ["call-video", "connection-options", "chat-identity-badges"];

describe("a chat's header on a phone", () => {
  it("keeps the name, a voice call and ⋮, and has the rest as rows of ⋮", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    expect(screen.getByTestId("chat-name")).toHaveTextContent("Cérebro (Mac)");
    expect(screen.getByTestId("call-audio")).toBeInTheDocument();
    for (const id of MOVED) expect(screen.queryByTestId(id), id).not.toBeInTheDocument();

    await user.click(options);
    const menu = within(screen.getByTestId("chat-options-menu"));
    for (const id of MOVED) expect(menu.getByTestId(id), id).toHaveAttribute("data-menu-item");
    // The connection's row says its state in words, and the identities' row the contact's key.
    expect(menu.getByTestId("connection-options")).toHaveAccessibleName(/^Connection options: ./);
    expect(menu.getByTestId("chat-identity-badges")).toHaveTextContent("Identities with Cérebro (Mac)");
  });

  it("opens the connection's panel from its row, and gives the focus back to ⋮ as it closes", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    await user.click(options);
    await user.click(screen.getByTestId("connection-options"));
    expect(screen.queryByTestId("chat-options-menu")).not.toBeInTheDocument();
    const panel = screen.getByTestId("connection-menu");
    expect(panel).toHaveAttribute("open");
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(panel).not.toHaveAttribute("open");
    expect(document.activeElement).toBe(options);
  });

  it("wider than a phone, every button is in the header as before", async () => {
    viewport(1024, 768);
    openChat();
    await screen.findByTestId("chat-options");
    for (const id of ["call-audio", ...MOVED]) expect(screen.getByTestId(id), id).toBeInTheDocument();
  });
});
