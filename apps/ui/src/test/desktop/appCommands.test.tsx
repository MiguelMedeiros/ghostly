import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: desktop.window

const tauri = vi.hoisted(() => ({
  /** The page's `app-command` listener, once it listens. */
  heard: undefined as ((event: { payload: unknown }) => void) | undefined,
  locked: false,
  created: vi.fn(async () => "fresh-chat"),
}));
// The UI suite points every @tauri-apps/api module at one stand-in (packages/browser/src/platform/tauri.ts).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => { if (name === "app-command") tauri.heard = handler; return () => {}; },
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
vi.mock("../../lib/pairedChat", () => ({ createPairedChat: tauri.created }));
vi.mock("../../contexts/LockScreenContext", () => ({ useLockScreen: () => ({ isLocked: tauri.locked }) }));

import { listenForAppCommands } from "../../desktop/host";
import { useAppCommands } from "../../hooks/useAppCommands";
import { APP_COMMAND_EVENT, appCommandForKey, sendAppCommand, type AppCommand } from "../../lib/appCommands";
import { renderApp } from "../render";

/*
 * New Chat and Settings from Desktop's menu (Cmd+N, Cmd+, on a Mac) and, where Desktop has no menu bar (Linux,
 * Windows), from Ctrl+N and Ctrl+, in the window. Rust sends the menu's as `app-command` (apps/desktop/src/app_window.rs).
 */

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("the keys", () => {
  it("are Ctrl+N and Ctrl+, alone, not held down", () => {
    expect(appCommandForKey(key({ key: "n", code: "KeyN", ctrlKey: true }))).toBe("new");
    expect(appCommandForKey(key({ key: ",", code: "Comma", ctrlKey: true }))).toBe("settings");
    // Another layout's letter on the same key, or the same letter elsewhere: both are Ctrl+N.
    expect(appCommandForKey(key({ key: "n", code: "KeyB", ctrlKey: true }))).toBe("new");
    for (const other of [
      key({ key: "n", code: "KeyN" }),
      key({ key: "n", code: "KeyN", ctrlKey: true, shiftKey: true }),
      key({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }),
      key({ key: "n", code: "KeyN", metaKey: true }),
      key({ key: "n", code: "KeyN", ctrlKey: true, repeat: true }),
      key({ key: "f", code: "KeyF", ctrlKey: true }),
    ]) expect(appCommandForKey(other)).toBeNull();
  });
});

describe("the Desktop host", () => {
  const sent: AppCommand[] = [];
  const record = (event: Event) => sent.push((event as CustomEvent<AppCommand>).detail);
  beforeEach(() => {
    sent.length = 0;
    tauri.heard = undefined;
    window.addEventListener(APP_COMMAND_EVENT, record);
  });
  afterEach(() => window.removeEventListener(APP_COMMAND_EVENT, record));

  it("passes the menu's commands on, and nothing else Rust might send", async () => {
    listenForAppCommands("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    await waitFor(() => expect(tauri.heard).toBeDefined());
    tauri.heard!({ payload: "settings" });
    tauri.heard!({ payload: "new" });
    tauri.heard!({ payload: "quit" });
    expect(sent).toEqual(["settings", "new"]);
  });

  it("on a Mac leaves the keys to the menu, so a press runs once", async () => {
    listenForAppCommands("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    const press = key({ key: "n", code: "KeyN", ctrlKey: true });
    window.dispatchEvent(press);
    expect(sent).toEqual([]);
    expect(press.defaultPrevented).toBe(false);
  });

  it("on Linux takes Ctrl+N and Ctrl+, itself", () => {
    listenForAppCommands("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    const press = key({ key: "n", code: "KeyN", ctrlKey: true });
    window.dispatchEvent(press);
    window.dispatchEvent(key({ key: ",", code: "Comma", ctrlKey: true }));
    window.dispatchEvent(key({ key: "a", code: "KeyA", ctrlKey: true }));
    expect(sent).toEqual(["new", "settings"]);
    expect(press.defaultPrevented).toBe(true);
  });
});

describe("the app running them", () => {
  function Where() {
    useAppCommands();
    return <p data-testid="where">{useLocation().pathname}</p>;
  }
  const render = () => renderApp(<Routes><Route path="*" element={<Where />} /></Routes>, { route: "/wallet" });

  beforeEach(() => {
    tauri.locked = false;
    tauri.created.mockClear();
  });

  it("opens Settings", async () => {
    render();
    act(() => sendAppCommand("settings"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/settings"));
  });

  it("starts a chat as the chat list's New does, and opens it", async () => {
    render();
    act(() => sendAppCommand("new"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/chat/fresh-chat"));
    expect(tauri.created).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the app is locked", async () => {
    tauri.locked = true;
    render();
    act(() => { sendAppCommand("new"); sendAppCommand("settings"); });
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.getByTestId("where")).toHaveTextContent("/wallet");
    expect(tauri.created).not.toHaveBeenCalled();
  });
});
