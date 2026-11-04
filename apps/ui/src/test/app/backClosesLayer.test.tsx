import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteChatDialog } from "../../components/DeleteChatDialog";
import { I18nProvider } from "../../contexts/I18nContext";
import { SettingsProvider } from "../../contexts/SettingsContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useBackCloses, useOutsideDismiss } from "../../hooks/useDismiss";
import { reloadIntoGate } from "../../lib/devices";
import { adoptEntry } from "../../lib/layerHistory";

// covers: app.navigation.back

/** A ⋮ menu (dismissed like every menu and sheet) whose row opens a dialog as the menu closes. */
function ChatMenu({ onClose, onDelete }: { onClose(): void; onDelete(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, true, onClose);
  return <div ref={ref} data-testid="menu"><button onClick={() => { onClose(); onDelete(); }}>Delete chat</button></div>;
}

/** A dialog still busy: Back leaves it open. */
function Busy({ onClose }: { onClose(): void }) {
  useBackCloses(() => {});
  return <div role="dialog" data-testid="busy"><button onClick={onClose}>Done</button></div>;
}

/** A panel over the chat that answers Back only (no Escape, no tap outside). */
function Panel({ onClose }: { onClose(): void }) {
  useBackCloses(onClose);
  return <div data-testid="panel" />;
}

function Chat() {
  const nav = useAppNavigation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false);
  return (
    <>
      <h1>Chat</h1>
      <button onClick={() => setPanel(true)}>Panel</button>
      {panel && <Panel onClose={() => setPanel(false)} />}
      <button onClick={() => setMenu(true)}>More</button>
      <button onClick={() => setAsking(true)}>Ask</button>
      <button onClick={() => setBusy(true)}>Send</button>
      <button onClick={() => navigate("/settings")}>Settings</button>
      {menu && <ChatMenu onClose={() => setMenu(false)} onDelete={() => setAsking(true)} />}
      {asking && <DeleteChatDialog name="Bob" onClose={() => setAsking(false)} onConfirm={() => { setAsking(false); nav.home(); }} />}
      {busy && <Busy onClose={() => setBusy(false)} />}
    </>
  );
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function App() {
  const nav = useAppNavigation();
  return (
    <>
      <Where />
      <Routes>
        <Route path="/" element={<button onClick={() => nav.conversation("/chat/s1")}>Bob</button>} />
        <Route path="/chat/:id" element={<Chat />} />
        <Route path="/settings" element={<h1>Settings</h1>} />
      </Routes>
    </>
  );
}

const where = () => screen.getByTestId("where").textContent;
const layerEntry = () => typeof (history.state as Record<string, unknown> | null)?.ghostlyLayer === "number";
/** The browser's Back, or Android's back gesture. */
const back = () => act(() => { history.back(); });

/** Home, then Bob's chat opened from the list, as a person gets there. */
async function inChat() {
  history.replaceState(null, "", "#/");
  const user = userEvent.setup();
  render(<HashRouter><SettingsProvider><I18nProvider><App /></I18nProvider></SettingsProvider></HashRouter>);
  await user.click(screen.getByRole("button", { name: "Bob" }));
  await waitFor(() => expect(where()).toBe("/chat/s1"));
  return user;
}

afterEach(async () => {
  // A traversal a test left on its way lands before the next starts (each starts on an entry of its own: `inChat`).
  await new Promise((resolve) => setTimeout(resolve, 100));
});

describe("Back with a layer open", () => {
  it("closes the dialog and leaves the chat under it; the next Back goes up as before", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(layerEntry()).toBe(true));

    await back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(where()).toBe("/chat/s1");
    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();

    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("closed by Cancel, the dialog leaves its entry, but Back then goes home at once", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(where()).toBe("/chat/s1");

    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("a menu closes alone, and a dialog its row opens takes the menu's place: one Back closes it", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await back();
    await waitFor(() => expect(screen.queryByTestId("menu")).toBeNull());
    expect(where()).toBe("/chat/s1");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(where()).toBe("/chat/s1");
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("the app's own move from a dialog counts the pages only: Delete lands on the list", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await user.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(where()).toBe("/"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(layerEntry()).toBe(false);
  });

  it("a dialog Back cannot close yet keeps its place: the next Back still does not leave the chat", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await back();
    await waitFor(() => expect(layerEntry()).toBe(true));
    expect(screen.getByTestId("busy")).toBeInTheDocument();
    expect(where()).toBe("/chat/s1");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("busy")).toBeNull());
    expect(where()).toBe("/chat/s1");
    // Its entry stays (closed another way than Back), and Back from it leaves the chat in one press.
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("Back from the entry a menu closed by Escape left, over a layer still open, goes to that layer, not out of the chat", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Panel" }));
    await user.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect((history.state as Record<string, unknown>).ghostlyLayer).toBe(2));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("menu")).toBeNull());
    expect(screen.getByTestId("panel")).toBeInTheDocument();

    await back();
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull());
    expect(where()).toBe("/chat/s1");
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("a page opened over an open layer: Back from it lands on the chat with the layer closed, and the next leaves it", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    // A page of the app's opened by something else than a tap outside the menu (a notification, a link in it).
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(where()).toBe("/settings"));

    await back();
    await waitFor(() => expect(where()).toBe("/chat/s1"));
    expect(screen.queryByTestId("menu")).toBeNull();
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("a page reloaded with a dialog open starts on its entry as the page's own: the app's next move runs at once", async () => {
    // As a takeover reloads the page from its open dialog: the entry still carries the layer's mark, nothing is open.
    history.replaceState({ ghostlyLayer: 1 }, "", "#/profile");
    vi.resetModules();
    const { afterLayers } = await import("../../lib/layerHistory");
    const moved = vi.fn();
    afterLayers(moved);
    expect(moved).toHaveBeenCalledOnce();
    expect(location.hash).toBe("#/profile");
    expect(layerEntry()).toBe(false);
  });

  it("a layer closed another way than Back (Escape, Cancel) starts no traversal: a reload right after it is never cancelled", async () => {
    await inChat();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    const go = vi.spyOn(history, "go");
    // Escape closes the menu, and the browser's reload starts before any timer of the page runs: on Chromium a
    // traversal of the page's that lands then cancels the reload (net::ERR_ABORTED) or drops it (page.reload hangs).
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("menu")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
    // Its entry stays, a mark over the chat: Back from it still leaves the chat in one press.
    expect(where()).toBe("/chat/s1");
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("a page reloaded on the entry a closed layer left: the app's move back goes over the page's entries from before the reload", async () => {
    let user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // The browser's reload: the page starts again on that entry, the chat's own entry from before it under it.
    cleanup();
    adoptEntry();
    expect(layerEntry()).toBe(false);
    user = userEvent.setup();
    render(<HashRouter><SettingsProvider><I18nProvider><App /></I18nProvider></SettingsProvider></HashRouter>);
    expect(where()).toBe("/chat/s1");

    // Deleted from a dialog: the list, not the chat's entry from before the reload.
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(where()).toBe("/"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(where()).toBe("/");
  });

  it("a layer opened on the entry one closed another way left takes it: Back closes it, the next leaves the chat", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const push = vi.spyOn(history, "pushState");
    await user.click(screen.getByRole("button", { name: "More" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();

    await back();
    await waitFor(() => expect(screen.queryByTestId("menu")).toBeNull());
    expect(where()).toBe("/chat/s1");
    await back();
    await waitFor(() => expect(where()).toBe("/"));
  });

  // Last: the page is on its way out after it, and the history stays as it is.
  it("a reload into the gate as the dialog under it goes (a move's last step) goes back over its entry first, never after the reload", async () => {
    const user = await inChat();
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(layerEntry()).toBe(true));
    const go = vi.spyOn(history, "go");
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    // The page under the dialog gives way to the standby screen, whose reload starts at once.
    cleanup();
    await reloadIntoGate();
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await waitFor(() => expect(layerEntry()).toBe(false));
    // A traversal after the reload started cancels it: the device stayed on "Moving to another device".
    expect(go).toHaveBeenCalledOnce();
    expect(go.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
    go.mockRestore();
    reload.mockRestore();
  });
});
