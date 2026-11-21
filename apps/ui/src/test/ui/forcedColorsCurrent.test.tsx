import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import type { CardIndexRow, SavedMessage } from "@ghostly/browser/shared/types";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, app.theme

/**
 * Forced colors (Windows Contrast themes) replace backgrounds and accent colours, which were all that marked the place
 * you are on (`aria-current`) in the chat list, on the rail, Saved and Tasks, the account bar and the phone's tab bar.
 * One mark for all of them, in forced colors only: `current-mark` (index.css), a Highlight bar at the place's start
 * side, under it in a row of places (`current-mark-under`). What the browser draws is e2e/web/forced-colors-controls.spec.ts.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FORCED = "@media (forced-colors: active)";

/** Every `@media (forced-colors: active)` block's body, and the stylesheet without them. */
function forcedBlocks(): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = "", at = 0;
  for (let start = CSS.indexOf(FORCED); start >= 0; start = CSS.indexOf(FORCED, at)) {
    const open = CSS.indexOf("{", start);
    let depth = 1, i = open + 1;
    for (; depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
    rest += CSS.slice(at, start);
    blocks.push(CSS.slice(open + 1, i - 1));
    at = i;
  }
  return { blocks, rest: rest + CSS.slice(at) };
}

/** A block's rules: selector -> its declarations. */
function rules(block: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [, selector, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
    out.set(selector.trim(), decls);
  }
  return out;
}

const MARK = '.current-mark[aria-current]:not([aria-current="false"])::before';
const UNDER = '.current-mark.current-mark-under[aria-current]:not([aria-current="false"])::before';
const PHYSICAL = /(^|-)(left|right|top|bottom|width|height)(-|$)/;

describe("the forced-colors mark of the place you are on (index.css)", () => {
  const { blocks, rest } = forcedBlocks();
  const all = blocks.map(rules);
  const find = (selector: string) => all.find((r) => r.has(selector))?.get(selector);

  it("is a Highlight bar drawn inside the place, only in forced colors, the bar alone keeping its colour", () => {
    const mark = find(MARK);
    expect(mark, `${MARK} inside ${FORCED}`).toBeDefined();
    expect(mark).toMatchObject({ content: '""', position: "absolute", background: "Highlight", "forced-color-adjust": "none", "pointer-events": "none" });
    expect(mark!["inset-inline-start"]).toBe("0");
    expect(mark!["inline-size"]).toBe("0.25rem");
    expect(find(UNDER), `${UNDER} inside ${FORCED}`).toMatchObject({ "inset-block": "auto 0", "block-size": "0.25rem" });
    // Normal colours: nothing reads the class outside forced colors.
    expect(rest).not.toMatch(/current-mark/);
  });

  it("uses logical sides only, so the bar is at the start in Arabic too", () => {
    for (const selector of [MARK, UNDER]) {
      const decls = find(selector);
      expect(decls, `${selector} inside ${FORCED}`).toBeDefined();
      expect(Object.keys(decls!).filter((name) => PHYSICAL.test(name)), selector).toEqual([]);
      expect(Object.keys(decls!).some((name) => /^(inset-(inline|block)|inline-size|block-size)/.test(name)), selector).toBe(true);
    }
  });
});

const key = (c: string) => c.repeat(52);
const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: Date.now(), nick });
const savedOne: SavedMessage = { savedAt: Date.now(), message: { linkId: "link-1", id: "peer_1", text: "keep", sender: "peer", timestamp: Date.now(), via: "datalink" } };
const running: CardIndexRow = { linkId: "link-1", id: "m1", sender: "peer", timestamp: Date.now(),
  card: readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" }) as TaskCard };

/** Each of these places carries the mark's class, is positioned for its bar, and only `current` says it is current. */
function marked(places: HTMLElement[], current: HTMLElement | undefined, under = false) {
  expect(places.length).toBeGreaterThan(1);
  for (const place of places) {
    const name = place.getAttribute("data-testid") ?? place.getAttribute("aria-label");
    expect(place, `${name}: the mark's class`).toHaveClass("current-mark");
    expect(place.classList.contains("current-mark-under"), `${name}: the bar under it`).toBe(under);
    // `account-action` is `position: relative` in index.css.
    expect(["relative", "absolute", "account-action"].some((c) => place.classList.contains(c)), `${name}: positioned for its bar`).toBe(true);
    if (place === current) expect(place, `${name}: current`).toHaveAttribute("aria-current", "page");
    else expect(place, `${name}: not current`).not.toHaveAttribute("aria-current");
  }
}

const sidebar = (route: string) => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { route });
const withSavedAndTasks = () => fakeEngine.on("savedMessages", () => [savedOne]).on("statusCardIndex", () => [running]);

describe("the places that carry it", () => {
  it("the chat list's open chat, Saved and Tasks, and the account bar's page: a bar at the start, under the account bar's", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bea"));
    withSavedAndTasks();
    sidebar("/chat/a");
    await screen.findByTestId("sidebar-saved");
    await screen.findByTestId("sidebar-tasks");
    const opens = screen.getAllByTestId("chat-row-open");
    marked(opens, opens.find((o) => o.closest("[data-chat]")?.getAttribute("data-chat") === "a"));
    marked([screen.getByTestId("sidebar-saved"), screen.getByTestId("sidebar-tasks")], undefined);
    marked(within(screen.getByTestId("account-bar")).getAllByRole("button"), undefined, true);
  });

  it("Saved, then the account bar's Settings, as the current place", async () => {
    withSavedAndTasks();
    const saved = sidebar("/saved");
    await screen.findByTestId("sidebar-tasks");
    marked([screen.getByTestId("sidebar-saved"), screen.getByTestId("sidebar-tasks")], screen.getByTestId("sidebar-saved"));
    saved.unmount();

    renderApp(<AccountBar />, { route: "/settings" });
    marked(within(screen.getByTestId("account-bar")).getAllByRole("button"), screen.getByTestId("account-settings"), true);
  });

  it("on the rail: the open chat, Saved and Tasks and the account bar stacked, each with the bar at the start", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bea"));
    withSavedAndTasks();
    sidebar("/chat/b");
    const rail = screen.getByTestId("chat-rail");
    await screen.findByTestId("rail-saved");
    await screen.findByTestId("rail-tasks");
    const items = within(rail).getAllByTestId("chat-rail-chat");
    const bea = items.find((i) => i.getAttribute("data-chat") === "b");
    marked(items, bea);
    // Its own accent bar would be filled with the page's colour over the Highlight one: gone in forced colors.
    expect(within(bea!).getByTestId("chat-rail-active")).toHaveClass("forced-colors:hidden");
    marked([screen.getByTestId("rail-saved"), screen.getByTestId("rail-tasks")], undefined);
    marked(within(screen.getByTestId("account-bar")).getAllByRole("button"), undefined);
  });

  it("the phone's tab bar: the bar under the current tab", async () => {
    renderApp(<MobileTabBar />, { route: "/wallet" });
    await waitFor(() => expect(screen.getByTestId("mobile-tab-wallet")).toHaveAttribute("aria-current", "page"));
    marked(within(screen.getByTestId("mobile-tabs")).getAllByRole("button"), screen.getByTestId("mobile-tab-wallet"), true);
  });
});
