import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { FIRST_ROWS } from "../../hooks/useListWindow";
import { createFolder } from "../../lib/chatFolders";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * A long chat list draws the rows near its view, the others are a space of their height: everything that restyles the
 * whole page (Light/Dark, a Text size step, a window crossing a width breakpoint) paid for every chat in it, on screen
 * or not. Laid out here by hand (the test's DOM lays nothing out): rows 72 px tall one under the other, a view 800 px.
 */

const ROW = 72, VIEW = 800, CHATS = 300;
const NOW = Date.now();
const chat = (i: number): ChatSession => ({
  id: `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: String(i).padStart(4, "0").repeat(13), encKeyB64: "enc",
  // The newest first in the list: chat 0 on top.
  messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - i * 60_000 }], createdAt: NOW - i * 60_000, lastSyncAt: NOW - i * 60_000, nick: `Chat ${i}`,
});

let scrolled = 0;
const list = () => screen.getByTestId("chat-list");
const drawnRows = () => screen.queryAllByTestId("chat-row").map(row => row.dataset.chat);
const spaces = () => document.querySelectorAll("[data-row-space]");

describe("a chat list of 300 chats", () => {
  beforeEach(() => {
    scrolled = 0;
    for (let i = 0; i < CHATS; i++) saveSession(chat(i));
    fakeEngine.update({ groups: [] });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this.closest<HTMLElement>('[data-testid="chat-list"]');
      if (!box) return new DOMRect();
      if (this === box) return new DOMRect(0, 0, 400, VIEW);
      const at = [...box.querySelectorAll("[data-row-space],[data-chat],[data-group]")].indexOf(this);
      return at < 0 ? new DOMRect() : new DOMRect(0, at * ROW - scrolled, 400, ROW);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const scrollTo = async (row: number) => {
    scrolled = row * ROW;
    await act(async () => {
      list().dispatchEvent(new Event("scroll"));
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
  };

  it("draws the rows near its view, and a space of the same height for each of the others", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const rows = drawnRows();
    // The view and a view's height past each of its edges: rows 0 to 22.
    expect(rows).toHaveLength(Math.floor((VIEW * 2) / ROW) + 1);
    expect(rows[0]).toBe("c-0");
    expect(rows.length + spaces().length).toBe(CHATS);
    expect([...spaces()].every(space => (space as HTMLElement).style.height === `${ROW}px`)).toBe(true);
  });

  it("draws the rows a scroll brings near and lets the ones it took away go", async () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await scrollTo(200);
    const rows = drawnRows();
    expect(rows).toContain("c-200");
    expect(rows).toContain("c-210");
    expect(rows).not.toContain("c-0");
    expect(rows.length).toBeLessThan(40);
    expect(rows.length + spaces().length).toBe(CHATS);
  });

  it("with folders, a space is one of the rows a dragged row is put in order among: the place it is let go at counts every row", () => {
    createFolder("Work");
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const others = screen.getByTestId("chat-folder-others-rows");
    expect(others.querySelectorAll("[data-row-space]").length).toBeGreaterThan(200);
    expect(others.querySelectorAll("[data-reorder-id]")).toHaveLength(CHATS);
  });

  it("while it is not laid out (behind an open chat on a phone) draws its first rows only, not every row", () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(() => new DOMRect());
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(drawnRows()).toHaveLength(FIRST_ROWS);
  });

  it("always draws the open chat's row, however far from the view", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { route: "/chat/c-250" });
    expect(drawnRows()).toContain("c-250");
    expect(drawnRows().length).toBeLessThan(40);
  });
});
