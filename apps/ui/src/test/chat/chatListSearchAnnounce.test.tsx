import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.search

/*
 * The chat list's search, as the search inside a chat: a name a screen reader says once the placeholder is gone, a
 * polite line that says how many chats it found (or that it found none), and Escape to clear it.
 */

const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const chat = (id: string, nick: string, text: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [{ id: `m-${id}`, text, sender: "peer", timestamp: NOW }], createdAt: NOW, lastSyncAt: NOW, nick });

describe("the chat list's search", () => {
  beforeEach(() => {
    saveSession(chat("a", "Alice", "first hello"));
    saveSession(chat("b", "Bob", "second hello"));
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: key("a") }), linkView({ id: "link-b", peerPubKeyZ32: key("b") })] });
  });

  it("is a search field named apart from its placeholder", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const box = screen.getByRole("searchbox", { name: "Search chats" });
    expect(box).toBe(screen.getByPlaceholderText("Search chats..."));
  });

  it("says politely how many chats it found, and that it found none", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const status = screen.getByTestId("chat-list-search-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(/^$/);
    const box = screen.getByPlaceholderText("Search chats...");
    await user.type(box, "hello");
    expect(status).toHaveTextContent("2 chats found");
    await user.clear(box);
    await user.type(box, "second");
    expect(status).toHaveTextContent("1 chat found");
    await user.type(box, "zzzqqq");
    expect(status).toHaveTextContent("No results found");
    await user.clear(box);
    expect(status).toHaveTextContent(/^$/);
  });

  it("clears with Escape, the focus staying in the field, and lets a second Escape through", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const box = screen.getByPlaceholderText("Search chats...");
    await user.type(box, "zzzqqq");
    expect(screen.queryAllByTestId("chat-row")).toHaveLength(0);
    let outside = 0;
    const count = (e: KeyboardEvent) => { if (e.key === "Escape") outside++; };
    document.addEventListener("keydown", count);
    try {
      await user.keyboard("{Escape}");
      expect(box).toHaveValue("");
      expect(box).toHaveFocus();
      expect(screen.getAllByTestId("chat-row")).toHaveLength(2);
      expect(outside).toBe(0);
      await user.keyboard("{Escape}");
      expect(outside).toBe(1);
    } finally {
      document.removeEventListener("keydown", count);
    }
  });
});
