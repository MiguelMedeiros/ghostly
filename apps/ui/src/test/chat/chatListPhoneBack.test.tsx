import { act, fireEvent, screen } from "@testing-library/react";
import { useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.mobile-layout

/*
 * On a phone the open chat takes the chat list's place, and the list is `display: none` meanwhile (App.tsx). A browser
 * drops the scroll of a box that is not drawn: Back from a chat opened far down a long list came to the list's top,
 * and the person scrolled down again to the chat they had come from, every time. The list is put back where it was.
 * The test's DOM lays nothing out: a box is 600 px tall unless it is inside `hidden`, and the drop is done by hand.
 */

const NOW = Date.now();
const chat = (i: number): ChatSession => ({
  id: `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: String(i).padStart(4, "0").repeat(13), encKeyB64: "enc",
  messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - i * 60_000 }], createdAt: NOW - i * 60_000, lastSyncAt: NOW - i * 60_000, nick: `Chat ${i}`,
});

/** App.tsx's phone layout, in short: the list's wrapper is hidden while anything else is open; Back goes home. */
function Phone() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return <>
    <div className={pathname === "/" ? "flex-1 flex min-h-0" : "hidden"}><Sidebar /></div>
    {pathname !== "/" && <button type="button" onClick={() => navigate("/")}>Back</button>}
  </>;
}

describe("a long chat list on a phone", () => {
  beforeEach(() => {
    windowIs(true);
    for (let i = 0; i < 40; i++) saveSession(chat(i));
    fakeEngine.update({ groups: [] });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.closest(".hidden") ? 0 : 600; });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("is where it was when Back comes from a chat opened far down it", async () => {
    renderApp(<UpdateProvider><Phone /></UpdateProvider>);
    const list = screen.getByTestId("chat-list");
    await screen.findByText("Chat 30");
    list.scrollTop = 2000;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByText("Chat 30"));
    await screen.findByRole("button", { name: "Back" });
    expect(list.closest(".hidden")).not.toBeNull();
    // What the browser does to the list while it is not drawn.
    list.scrollTop = 0;
    fireEvent.scroll(list);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back" })); });
    expect(list.closest(".hidden")).toBeNull();
    expect(list.scrollTop).toBe(2000);
  });

  it("stays at the top the person scrolled it to", async () => {
    renderApp(<UpdateProvider><Phone /></UpdateProvider>);
    const list = screen.getByTestId("chat-list");
    await screen.findByText("Chat 3");
    list.scrollTop = 2000;
    fireEvent.scroll(list);
    list.scrollTop = 0;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByText("Chat 3"));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Back" })); });
    expect(list.scrollTop).toBe(0);
  });
});
