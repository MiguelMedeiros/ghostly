import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.accessibility, chats.list.rail

/*
 * The chat list is a landmark of its own, "Chats", as the account bar and the open page are: a screen reader's landmark
 * keys reach its New and Join, its search and its rows, folded to a rail or not, on a wide screen and on a phone. Only
 * the rail was one before; the full list, a new profile's first screen, was in none.
 */

const NOW = Date.now();
const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", messages: [], createdAt: NOW, nick });
const list = () => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
const chats = () => screen.getByRole("navigation", { name: "Chats" });

afterEach(() => vi.restoreAllMocks());

describe("the chat list's landmark", () => {
  it("holds a new profile's New, Join, search and empty list on a wide screen, and is the only one named Chats", () => {
    windowIs(false);
    list();
    const nav = chats();
    expect(nav).toBe(screen.getByTestId("sidebar"));
    expect(within(nav).getByTestId("sidebar-new-chat")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Join chat" })).toBeInTheDocument();
    expect(within(nav).getByRole("searchbox", { name: "Search chats" })).toBeInTheDocument();
    expect(within(nav).getByText("It's quiet here...")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Chats" })).toHaveLength(1);
  });

  it("holds the rows, and stays the one landmark when the list is folded to a rail", () => {
    windowIs(false);
    saveSession(chat("a", "Ana"));
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    list();
    const nav = chats();
    expect(nav).toHaveAttribute("data-collapsed", "true");
    expect(within(nav).getByTestId("chat-rail")).toBeInTheDocument();
    expect(within(nav).getByTestId("sidebar-new-chat")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Chats" })).toHaveLength(1);
  });

  it("is the list's landmark on a phone too", () => {
    windowIs(true);
    saveSession(chat("a", "Ana"));
    list();
    const nav = chats();
    expect(within(nav).getByRole("heading", { level: 1, name: "Chats" })).toBeInTheDocument();
    expect(within(nav).getByTestId("chat-list")).toHaveTextContent("Ana");
  });
});
