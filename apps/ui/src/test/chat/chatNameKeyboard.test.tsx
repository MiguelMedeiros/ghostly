import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rename, app.keyboard

/**
 * A 1:1 chat's name in its header is the only way to rename the chat. It was a clickable line of text: Tab never
 * reached it, a screen reader read it as text, and after Enter or Escape the focus fell to the page.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

describe("a chat's name in its header", () => {
  it("is a button the keyboard reaches, and Enter opens the field with the name in it", async () => {
    const { user } = openChat();
    const name = await screen.findByRole("button", { name: "Ana" });
    expect(name).toContainElement(screen.getByTestId("chat-name"));
    name.focus();
    expect(document.activeElement).toBe(name);
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    expect(field).toHaveValue("Ana");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("gives the focus back to the name after Enter saves it", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await user.clear(field);
    await user.type(field, "Bea{Enter}");
    const name = await screen.findByRole("button", { name: "Bea" });
    expect(document.activeElement).toBe(name);
    expect(loadSession("chat-1")?.label).toBe("Bea");
  });

  it("gives the focus back to the name after Escape, and keeps the name it had", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await user.type(field, "x{Escape}");
    const name = await screen.findByRole("button", { name: "Ana" });
    expect(document.activeElement).toBe(name);
    expect(loadSession("chat-1")?.label).toBe("Ana");
  });

  it("spends the Escape that cancels it: a notice at the top that also answers Escape stays", async () => {
    const { user } = openChat();
    (await screen.findByRole("button", { name: "Ana" })).focus();
    await user.keyboard("{Enter}");
    const field = await screen.findByPlaceholderText("Set a name...");
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    // What the "No room for a new chat" notice hears (Root.tsx): an Escape on the window, closed only when not spent.
    const heard: boolean[] = [];
    const notice = (e: KeyboardEvent) => { if (e.key === "Escape") heard.push(e.defaultPrevented); };
    window.addEventListener("keydown", notice);
    try {
      await user.type(field, "x{Escape}");
    } finally { window.removeEventListener("keydown", notice); }
    expect(heard).toEqual([true]);
    expect(await screen.findByRole("button", { name: "Ana" })).toBeInTheDocument();
  });
});
