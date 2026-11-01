import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import type { CardIndexRow, SavedMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSettings } from "../../lib/settings";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: chats.list.rail

const key = (c: string) => c.repeat(52);
const NOW = Date.now();
const message = (over: Partial<ChatMessage>): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW, ...over });
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, ...over });
const stored = () => JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}").chatListCollapsed;
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const list = () => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>);
const rail = () => screen.getByTestId("chat-rail");

afterEach(() => vi.restoreAllMocks());

describe("the stored choice", () => {
  it("is the full list until chosen, and only `true` folds it", () => {
    expect(loadSettings().chatListCollapsed).toBe(false);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: "yes" }));
    expect(loadSettings().chatListCollapsed).toBe(false);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    expect(loadSettings().chatListCollapsed).toBe(true);
  });

  it("opens folded where it was folded, and the list's button unfolds it again", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    saveSession(chat("a", { nick: "Ana" }));
    const { user } = list();
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByTestId("chat-list")).not.toBeInTheDocument();
    await user.click(within(rail().parentElement!).getByRole("button", { name: "Expand chat list" }));
    expect(screen.getByTestId("chat-list")).toBeInTheDocument();
    expect(stored()).toBe(false);
  });
});

describe("the rail", () => {
  it("shows every chat's and group's picture in the list's order, names in the tooltips, unread marks on the pictures", async () => {
    saveSession(chat("a", { nick: "Ana", messages: [message({}), message({})] }));
    saveSession(chat("b", { nick: "Bea" }));
    act(() => fakeEngine.update({ groups: [groupView({ id: "g1", name: "Climbing", status: "active", lastMessageAt: NOW })] }));
    const { user } = list();
    const toggle = screen.getByTestId("chat-list-toggle");
    expect(toggle).toHaveAccessibleName("Collapse chat list");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+L");
    const listOrder = [...screen.getAllByTestId(/^(chat|group)-row$/)].map(r => r.getAttribute("data-chat") ?? `group:${r.getAttribute("data-group")}`);

    await user.click(toggle);
    expect(stored()).toBe(true);
    expect(screen.getByTestId("sidebar")).toHaveStyle({ width: "72px" });
    expect(screen.queryByTestId("chat-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-resize")).not.toBeInTheDocument();
    const items = within(rail()).getAllByRole("button");
    expect(items.map(b => b.getAttribute("data-chat"))).toEqual(listOrder);
    expect(rail()).toHaveAccessibleName("Chats");

    const ana = items.find(b => b.getAttribute("data-chat") === "a")!;
    expect(ana).toHaveAttribute("title", "Ana");
    expect(ana).toHaveAccessibleName("Ana, 2 unread messages");
    expect(within(ana).getByTestId("chat-rail-unread")).toHaveTextContent("2");
    const bea = items.find(b => b.getAttribute("data-chat") === "b")!;
    expect(bea).toHaveAccessibleName("Bea");
    expect(within(bea).queryByTestId("chat-rail-unread")).not.toBeInTheDocument();
    const group = within(rail()).getByTestId("chat-rail-group");
    expect(group).toHaveAttribute("title", "Climbing");
    expect(group).toHaveAccessibleName("Climbing, unread messages");
    expect(within(group).getByTestId("chat-rail-unread")).toBeInTheDocument();

    // The focus goes to the button that unfolds it, in the rail's place of the one clicked.
    const expand = screen.getByTestId("chat-list-toggle");
    expect(expand).toHaveFocus();
    expect(expand).toHaveAccessibleName("Expand chat list");
    expect(expand).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a chat or a group from its picture and stays a rail, the open one marked", async () => {
    saveSession(chat("a", { nick: "Ana", messages: [message({})] }));
    act(() => fakeEngine.update({ groups: [groupView({ id: "g1", name: "Climbing", status: "active", lastMessageAt: NOW })] }));
    const { user } = list();
    await user.click(screen.getByTestId("chat-list-toggle"));

    await user.click(within(rail()).getByRole("button", { name: "Ana, 1 unread message" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/a");
    expect(rail()).toBeInTheDocument();
    const ana = within(rail()).getByRole("button", { name: "Ana" });
    expect(ana).toHaveAttribute("aria-current", "page");
    expect(within(ana).getByTestId("chat-rail-active")).toBeInTheDocument();

    await user.click(within(rail()).getByTestId("chat-rail-group"));
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
    expect(within(rail()).getByTestId("chat-rail-group")).toHaveAttribute("aria-current", "page");
    expect(stored()).toBe(true);
  });

  it("unfolds with its button, the focus back on the list's own", async () => {
    saveSession(chat("a", { nick: "Ana" }));
    const { user } = list();
    await user.click(screen.getByTestId("chat-list-toggle"));
    await user.click(screen.getByTestId("chat-list-toggle"));
    expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-list")).toBeInTheDocument();
    const collapse = screen.getByTestId("chat-list-toggle");
    expect(collapse).toHaveAccessibleName("Collapse chat list");
    expect(collapse).toHaveFocus();
    expect(stored()).toBe(false);
  });

  it("folds and unfolds with Alt+Shift+L, leaving the focus where it was outside the list", () => {
    saveSession(chat("a", { nick: "Ana" }));
    list();
    const field = document.body.appendChild(document.createElement("textarea"));
    field.focus();
    fireEvent.keyDown(window, { code: "KeyL", key: "L", altKey: true, shiftKey: true });
    expect(screen.getByTestId("chat-rail")).toBeInTheDocument();
    expect(field).toHaveFocus();
    fireEvent.keyDown(window, { code: "KeyL", key: "L", ctrlKey: true, altKey: true, shiftKey: true });
    expect(screen.getByTestId("chat-rail")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyL", key: "L", altKey: true, shiftKey: true });
    expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
    expect(field).toHaveFocus();
    field.remove();
  });

  it("stays as it is with Alt+Shift+L while a dialog is open, so the dialog gives the focus back to its opener", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    saveSession(chat("a", { nick: "Ana" }));
    const { user } = list();
    const join = within(screen.getByTestId("chat-rail-actions")).getByRole("button", { name: "Join chat" });
    await user.click(join);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { code: "KeyL", key: "L", altKey: true, shiftKey: true });
    expect(screen.getByTestId("chat-rail")).toBeInTheDocument();
    expect(stored()).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Close join" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(join).toHaveFocus();
  });

  it("stays as it is with Alt+Shift+L behind the lock screen", () => {
    saveSession(chat("a", { nick: "Ana" }));
    list();
    // The lock screen: a modal panel over the whole app (LockScreen.tsx).
    const lock = document.body.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }));
    lock.setAttribute("aria-modal", "true");
    try {
      fireEvent.keyDown(window, { code: "KeyL", key: "L", altKey: true, shiftKey: true });
      expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
      expect(stored()).not.toBe(true);
    } finally { lock.remove(); }
  });

  it("says its buttons in the app's language", async () => {
    saveSession(chat("a", { nick: "Ana", messages: [message({})] }));
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "pt" });
    await user.click(screen.getByRole("button", { name: "Recolher lista de conversas" }));
    expect(screen.getByRole("button", { name: "Expandir lista de conversas" })).toHaveAttribute("title", "Expandir lista de conversas (Alt+Shift+L)");
    expect(within(rail()).getByRole("button", { name: "Ana, 1 mensagem não lida" })).toBeInTheDocument();
  });
});

describe("the rail's top", () => {
  const folded = () => localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
  const actions = () => screen.getByTestId("chat-rail-actions");
  const savedOne: SavedMessage = { savedAt: NOW, message: { linkId: "link-1", id: "peer_1", text: "keep", sender: "peer", timestamp: NOW, via: "datalink" } };
  const running: CardIndexRow = { linkId: "link-1", id: "m1", sender: "peer", timestamp: NOW,
    card: readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" }) as TaskCard };

  it("keeps New chat and Join, a profile with no chat yet too, and no Saved or Tasks with nothing in them", async () => {
    folded();
    fakeEngine.on("savedMessages", () => []).on("statusCardIndex", () => []);
    const { user } = list();
    await waitFor(() => expect(fakeEngine.callsTo("savedMessages").length).toBeGreaterThan(0));
    expect(within(actions()).getAllByRole("button").map(b => [b.getAttribute("aria-label"), b.getAttribute("title")])).toEqual([["New chat", "New chat"], ["Join chat", "Join chat"]]);
    expect(within(rail()).queryAllByRole("button")).toEqual([]);

    await user.click(within(actions()).getByRole("button", { name: "Join chat" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  });

  it("starts a chat with New chat and stays a rail", async () => {
    folded();
    const { user } = list();
    await user.click(within(actions()).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/chat\/./));
    expect(screen.getByTestId("chat-rail")).toBeInTheDocument();
  });

  it("keeps Saved and Tasks while they have something, with what the list's rows say, and opens them", async () => {
    folded();
    fakeEngine.on("savedMessages", () => [savedOne]).on("statusCardIndex", () => [running]);
    const { user } = list();
    const saved = await within(actions()).findByTestId("rail-saved");
    expect(saved).toHaveAccessibleName("Saved messages, 1");
    expect(saved).toHaveAttribute("title", "Saved messages");
    const tasks = await within(actions()).findByTestId("rail-tasks");
    await waitFor(() => expect(tasks).toHaveAccessibleName("Tasks, 1 active"));
    expect(tasks).toHaveAttribute("title", "Tasks");
    expect(within(tasks).getByTestId("rail-tasks-count")).toHaveTextContent("1");

    await user.click(saved);
    expect(screen.getByTestId("where")).toHaveTextContent("/saved");
    expect(within(actions()).getByTestId("rail-saved")).toHaveAttribute("aria-current", "page");
    await user.click(within(actions()).getByTestId("rail-tasks"));
    expect(screen.getByTestId("where")).toHaveTextContent("/tasks");
    expect(within(actions()).getByTestId("rail-tasks")).toHaveAttribute("aria-current", "page");
    expect(stored()).toBe(true);
  });

  it("says them in the app's language", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true, language: "pt" }));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(within(actions()).getAllByRole("button").map(b => b.getAttribute("aria-label"))).toEqual(["Nova conversa", "Entrar"]);
  });
});

describe("on a phone", () => {
  it("has no button to fold the list, nor the shortcut, and a choice made on a wide window leaves its list whole", () => {
    windowIs(true);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    saveSession(chat("a", { nick: "Ana" }));
    list();
    expect(screen.queryByTestId("chat-list-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-list")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyL", key: "L", altKey: true, shiftKey: true });
    expect(screen.queryByTestId("chat-rail")).not.toBeInTheDocument();
    expect(stored()).toBe(true);
  });
});
