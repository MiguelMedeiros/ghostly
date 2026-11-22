import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createFolder } from "../../lib/chatFolders";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * A long chat list keeps every row in the page and leaves the ones off screen to the browser (index.css
 * `.chat-list-row`: `content-visibility: auto`): what restyles the whole page skips them, and a scroll costs no script.
 * A list that drew only the rows near its view in script re-drew the list and mounted rows at every row scrolled, 4-10
 * times the scroll's main thread at 300 chats. Laid out here by hand (the test's DOM lays nothing out): rows 72 px tall
 * one under the other, a view 800 px.
 */

const ROW = 72, VIEW = 800, CHATS = 300;
const NOW = Date.now();
const chat = (i: number): ChatSession => ({
  id: `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: String(i).padStart(4, "0").repeat(13), encKeyB64: "enc",
  // The newest first in the list: chat 0 on top.
  messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - i * 60_000 }], createdAt: NOW - i * 60_000, lastSyncAt: NOW - i * 60_000, nick: `Chat ${i}`,
});

let scrolled = 0;
let commits = 0;
const list = () => screen.getByTestId("chat-list");
const rows = () => screen.queryAllByTestId("chat-row").map(row => row.dataset.chat);
const draw = (route?: string) => renderApp(
  <Profiler id="chat-list" onRender={() => { commits++; }}><UpdateProvider><Sidebar /></UpdateProvider></Profiler>,
  route ? { route } : undefined,
);

describe("a chat list of 300 chats", () => {
  beforeEach(() => {
    scrolled = 0;
    commits = 0;
    for (let i = 0; i < CHATS; i++) saveSession(chat(i));
    fakeEngine.update({ groups: [] });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this.closest<HTMLElement>('[data-testid="chat-list"]');
      if (!box) return new DOMRect();
      if (this === box) return new DOMRect(0, 0, 400, VIEW);
      // (`data-row-space`: a row a list that drew only the rows near its view left as a space, laid out as a row.)
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
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    });
  };

  it("has every row in the page, in the list's order", () => {
    draw();
    expect(rows()).toEqual(Array.from({ length: CHATS }, (_, i) => `c-${i}`));
  });

  it("a scroll draws nothing again: no commit under the list, no row mounted or let go", async () => {
    draw();
    // The list settled first: what its first draws set off (its chats read, their faces) is not the scroll's.
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))); });
    const added: Node[] = [], removed: Node[] = [];
    const watch = new MutationObserver(records => records.forEach(r => { added.push(...r.addedNodes); removed.push(...r.removedNodes); }));
    watch.observe(list(), { childList: true, subtree: true });
    const before = commits;
    for (const row of [3, 6, 12, 40, 120, 250]) await scrollTo(row);
    await act(async () => { await Promise.resolve(); });
    watch.disconnect();
    expect(commits - before, "commits under the list while it scrolled").toBe(0);
    expect(added.length + removed.length, "nodes put in or taken out of the list while it scrolled").toBe(0);
    expect(rows()).toHaveLength(CHATS);
  });

  it("every chat and group row is one the browser draws only near the view (index.css)", () => {
    fakeEngine.update({ groups: [groupView({ id: "g-1", name: "Climbing", status: "active", lastMessageAt: NOW - 60_000 })] });
    draw();
    const all = document.querySelectorAll<HTMLElement>('[data-testid="chat-row"],[data-testid="group-row"]');
    expect(all.length).toBe(CHATS + 1);
    expect([...all].every(row => row.classList.contains("chat-list-row"))).toBe(true);
    const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");
    const rule = /\n\.chat-list-row \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/content-visibility:\s*auto;/);
    // A row drawn keeps its last real height (`auto`); one never drawn takes its lines at the Text size.
    expect(rule).toMatch(/contain-intrinsic-block-size:\s*auto calc\([^;]*var\(--chat-text-scale\)\);/);
  });

  it("the open chat's row is in the page however far from the view, and with folders every row can be put in order", () => {
    createFolder("Work");
    draw("/chat/c-250");
    expect(rows()).toContain("c-250");
    expect(screen.getByTestId("chat-folder-others-rows").querySelectorAll("[data-reorder-id]")).toHaveLength(CHATS);
    expect(document.querySelectorAll("[data-row-space]")).toHaveLength(0);
  });
});
