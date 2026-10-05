import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * The Tasks board (WISP 405 · Status Cards § The Tasks board): a headless bot posts tasks in two chats with a person on
 * the web app (a 1:1 chat and a private group) and updates them; the person's board gathers them all in columns by
 * status, follows the updates, and a card opens its chat on its message. Then hundreds of cards: a column draws fifty
 * and scrolls smoothly.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** The app's light or dark look, as Settings sets it, once its colours have settled. */
async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
  }, scheme);
}

/** A picture in the test's output, and in `TASKS_BOARD_SHOTS` when that names a folder (the pull request's pictures). */
async function shot(page: Page, name: string) {
  const path = test.info().outputPath(name);
  await page.screenshot({ path });
  const keep = process.env.TASKS_BOARD_SHOTS;
  if (keep) { mkdirSync(keep, { recursive: true }); copyFileSync(path, join(keep, name)); }
}

const column = (page: Page, id: string) => page.locator(`[data-testid="board-column"][data-column="${id}"]`);
const cards = (scope: Locator) => scope.getByTestId("board-card");
const ids = (scope: Locator) => cards(scope).evaluateAll((list) => list.map((card) => card.getAttribute("data-card-id")));

test("a bot's tasks from two chats on one board: columns by status, live updates, a card opens its chat", { tag: ["@feature:chat.tasks-board", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("board-person");
    const page = person.page;

    // A profile with no card: no way to the board above the chat list, and the page itself says what tasks are.
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("sidebar-tasks")).toHaveCount(0);
    await page.goto("/#/tasks");
    await expect(page.getByTestId("tasks-empty")).toContainText("No tasks yet");
    await page.goto("/#/");

    // Chat one: a 1:1 chat with the bot.
    const invite = await bot.run("invite", "create", "--label", "person");
    await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const direct = invite.chat as string;

    // Chat two: a private group the bot made, joined through its link.
    const group = (await bot.run("group", "create", "Sala de Máquinas", "--mesh")).group as string;
    const { link } = await bot.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    await expect.poll(async () => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 2 && shown.members.every((m) => m.me || m.online);
    }, { timeout: 150_000, intervals: [2_000] }).toBe(true);

    // Three tasks in two chats.
    await bot.run("task", "send", direct, "--id", "relay", "--title", "Fix relay rotation", "--steps", "1/4", "--step", "Writing the codec", "--wait", "delivered");
    await bot.run("task", "send", group, "--id", "docs", "--title", "Write the WISP", "--status", "queued", "--wait", "sent", "--timeout", "120");
    await bot.run("task", "send", group, "--id", "ci", "--title", "Fix the flaky large-file spec", "--progress", "60",
      "--pr-url", "https://github.com/MiguelMedeiros/ghostly/pull/612", "--pr-number", "612", "--additions", "123", "--deletions", "45", "--wait", "sent", "--timeout", "120");

    // The way in, above the chat list, with the tasks still going across both chats.
    const entry = page.getByTestId("sidebar-tasks");
    await expect(entry).toHaveAccessibleName("Tasks, 3 active", { timeout: 120_000 });
    await entry.click();
    await expect(page).toHaveURL(/#\/tasks$/);
    const board = page.getByTestId("tasks-board");
    await expect(page.getByTestId("tasks-summary")).toHaveText("3 active · 3 tasks");
    await expect(page.getByTestId("board-column").getByRole("heading")).toHaveText(["Queued1", "Running2", "Blocked0", "Done0", "Stopped0"]);
    expect(await ids(column(page, "queued"))).toEqual(["docs"]);
    expect((await ids(column(page, "running"))).sort()).toEqual(["ci", "relay"]);

    // A card: its bot and chat, its pull request's link, its progress.
    const ci = board.locator('[data-testid="board-card"][data-card-id="ci"]');
    await expect(ci.getByTestId("board-card-open")).toHaveAccessibleName(/^Fix the flaky large-file spec, Running, 60%, Coordinator in Sala de Máquinas, PR #612, updated /);
    await expect(ci.getByTestId("board-card-bot")).toHaveText(/Coordinator$/);
    await expect(ci.getByTestId("board-card-chat")).toHaveText(/Sala de Máquinas$/);
    await expect(ci.getByTestId("board-card-pr")).toHaveAttribute("href", "https://github.com/MiguelMedeiros/ghostly/pull/612");
    await expect(ci.getByTestId("board-card-pr")).toHaveText("PR #612+123−45");
    await expect(ci.getByTestId("board-card-progress")).toHaveAttribute("aria-valuenow", "60");
    const relayCard = board.locator('[data-testid="board-card"][data-card-id="relay"]');
    await expect(relayCard.getByTestId("board-card-open")).toHaveAccessibleName(/^Fix relay rotation, Running, 1 of 4, in Coordinator, updated /);
    // Nothing on the board loops: a running task is a still dot and a bar.
    expect(await board.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);

    // The bot updates them while the board is open: each card moves to its column, still one card.
    await bot.run("task", "update", group, "docs", "--status", "running", "--progress", "10", "--wait", "sent", "--timeout", "120");
    await bot.run("task", "update", group, "ci", "--status", "blocked", "--step", "Waiting for review", "--wait", "sent", "--timeout", "120");
    await bot.run("task", "update", direct, "relay", "--status", "done", "--steps", "4/4", "--wait", "confirmed", "--timeout", "60");
    await expect(page.getByTestId("board-column").getByRole("heading")).toHaveText(["Queued0", "Running1", "Blocked1", "Done1", "Stopped0"], { timeout: 60_000 });
    expect(await ids(column(page, "running"))).toEqual(["docs"]);
    expect(await ids(column(page, "blocked"))).toEqual(["ci"]);
    expect(await ids(column(page, "done"))).toEqual(["relay"]);
    await expect(page.getByTestId("tasks-summary")).toHaveText("2 active · 3 tasks");
    await expect(cards(board)).toHaveCount(3);

    // A failed task and a routine, for the last column and the Routines tab.
    await bot.run("task", "send", group, "--id", "deploy", "--title", "Deploy the relay", "--status", "failed", "--wait", "sent", "--timeout", "120");
    await bot.run("routine", "send", group, "--id", "nightly", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--next", String(Date.now() + 3 * 3_600_000), "--wait", "sent", "--timeout", "120");
    await expect(column(page, "closed").getByTestId("board-column-count")).toHaveText("1", { timeout: 60_000 });
    await expect(page.getByTestId("tasks-view-routines")).toHaveText("Routines 1", { timeout: 60_000 });
    await expect(board.getByTestId("board-routine")).toHaveCount(0);

    // The pictures: the board in both looks.
    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await shot(page, `board-desktop-${scheme}.png`);
    }
    await theme(page, "dark");

    // Grouped by chat, then filtered by text.
    await page.getByTestId("tasks-group-chat").click();
    await expect(page.getByTestId("board-column").getByRole("heading")).toHaveText(["Sala de Máquinas3", "Coordinator1"]);
    await shot(page, "board-desktop-by-chat.png");
    await page.getByTestId("tasks-group-status").click();
    await page.getByTestId("tasks-filter").fill("flaky");
    expect(await ids(board)).toEqual(["ci"]);
    await page.getByTestId("tasks-filter").fill("");

    // The keys: down a column, across to the next one that has a card.
    await column(page, "running").getByTestId("board-card-open").focus();
    await page.keyboard.press("ArrowRight");
    await expect(column(page, "blocked").getByTestId("board-card-open")).toBeFocused();

    // A card of the group opens the group on its message; one of the 1:1 chat, that chat.
    await column(page, "blocked").getByTestId("board-card-open").press("Enter");
    await expect(page).toHaveURL(/#\/group\//);
    const room = page.locator(".chat-wallpaper");
    const ciRow = room.locator("[data-message-row]").filter({ has: page.locator('[data-testid="status-card"][data-card-id="ci"]') });
    await expect(ciRow).toHaveAttribute("data-reply-flash", "", { timeout: 30_000 });
    await expect(room.locator('[data-testid="status-card"][data-card-id="ci"]')).toBeInViewport();

    await page.getByTestId("sidebar-tasks").click();
    await column(page, "done").getByTestId("board-card-open").click();
    await expect(page).toHaveURL(/#\/chat\//);
    const directRow = chat(person).locator("[data-message-row]").filter({ has: page.locator('[data-testid="status-card"][data-card-id="relay"]') });
    await expect(directRow).toHaveAttribute("data-reply-flash", "", { timeout: 30_000 });
    await expect(chat(person).locator('[data-testid="status-card"][data-card-id="relay"]')).toBeInViewport();

    // A phone's width: the columns are tabs with their counts, one column on screen; the routines on their own tab.
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/#/tasks");
    const tabs = page.getByTestId("tasks-tab");
    await expect(tabs).toHaveText(["Queued0", "Running1", "Blocked1", "Done1", "Stopped1"]);
    await expect(page.getByTestId("tasks-board")).toHaveAttribute("data-layout", "tabs");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(column(page, "running").getByTestId("board-card")).toBeInViewport();
    await expect(column(page, "blocked").getByTestId("board-card")).not.toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.waitForTimeout(500); // the column's slide: the picture after it
    await shot(page, "board-phone.png");
    // A swipe is a scroll of the columns: the tab follows.
    await page.getByTestId("tasks-board").evaluate((el) => el.scrollTo({ left: el.clientWidth * 3, behavior: "instant" }));
    await expect(tabs.nth(3)).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("tasks-view-routines").click();
    await expect(page.getByTestId("board-routine")).toContainText("Nightly bug hunt");
    await shot(page, "board-phone-routines.png");
    await page.setViewportSize({ width: 1280, height: 720 });

    // Hundreds of cards (written straight into the store, as 500 messages of the 1:1 chat would be): a column draws
    // fifty, and scrolling it stays smooth.
    const written = await page.evaluate(async () => {
      for (const { name } of await indexedDB.databases()) {
        if (!name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
          if (!db.objectStoreNames.contains("messages") || !db.transaction("messages").objectStore("messages").indexNames.contains("byCardKind")) continue;
          const store = () => db.transaction("messages", "readwrite").objectStore("messages");
          const rows = await new Promise<{ linkId: string; id: string; timestamp: number; card: { id: string; title: string; status: string } }[]>((resolve, reject) => {
            const r = store().index("byCardKind").getAll("task"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
          });
          const seed = rows.find((row) => !row.linkId.startsWith("group:"));
          if (!seed) continue;
          const statuses = ["queued", "running", "running", "blocked", "done"];
          const tx = db.transaction("messages", "readwrite");
          for (let i = 0; i < 500; i++) {
            tx.objectStore("messages").put({ ...seed, id: `bulk-${i}`, timestamp: Date.now() - i * 1000, edit: undefined,
              card: { ...seed.card, id: `bulk-${i}`, title: `Bulk task ${i}: a title long enough to be cut on one line of a card`, status: statuses[i % statuses.length] } });
          }
          await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
          return 500;
        } finally { db.close(); }
      }
      return 0;
    });
    expect(written).toBe(500);
    await page.reload();
    await page.goto("/#/tasks");
    await expect(page.getByTestId("tasks-summary")).toContainText("504 tasks", { timeout: 60_000 });
    const running = column(page, "running");
    await expect(running.getByTestId("board-column-count")).toHaveText("201");
    await expect(cards(running)).toHaveCount(50);
    await expect(cards(page.getByTestId("tasks-board"))).toHaveCount(50 * 4 + 1);
    await running.getByTestId("board-column-more").click();
    await expect(cards(running)).toHaveCount(100);
    // A full column scrolls: its cards keep their two lines.
    expect((await cards(running).first().boundingBox())!.height).toBeGreaterThan(44);
    // Scrolled a little each frame for a second and a half: how long the frames took.
    const frames = await running.getByTestId("board-column-cards").evaluate(async (list) => {
      const times: number[] = [];
      let last = performance.now();
      for (let i = 0; i < 90; i++) {
        list.scrollTop += 40;
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      times.sort((a, b) => a - b);
      return { median: times[45], p95: times[85], worst: times[89], scrolled: list.scrollTop };
    });
    test.info().annotations.push({ type: "scroll frames with 500 cards (ms)", description: JSON.stringify(frames) });
    console.log(`tasks board, 500 cards: scroll frames ${JSON.stringify(frames)}`);
    expect(frames.scrolled).toBeGreaterThan(1000);
    expect(frames.median).toBeLessThan(34);
    await shot(page, "board-desktop-500.png");
  } finally {
    await bot.stop();
  }
});

test("richer task cards: a Review column for an open pull request, its checks, tags, and parts stacked under their task", { tag: ["@feature:chat.tasks-board", "@feature:chat.status-cards.wire", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("board-fields-person");
    const page = person.page;
    const invite = await bot.run("invite", "create", "--label", "person");
    await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const direct = invite.chat as string;
    const prOf = (n: number) => ["--pr-url", `https://github.com/MiguelMedeiros/ghostly/pull/${n}`, "--pr-number", String(n)];

    // The CLI refuses what a reader would leave out, and a parent that is not there.
    await expect(bot.run("task", "send", direct, "--title", "x", ...prOf(1), "--pr-state", "approved")).rejects.toThrow(/pr.state is one of/);
    await expect(bot.run("task", "send", direct, "--title", "x", "--tag", "a", "--tag", "b", "--tag", "c", "--tag", "d")).rejects.toThrow(/tags is a list of at most 3/);
    await expect(bot.run("task", "send", direct, "--title", "x", "--parent", "never-sent")).rejects.toThrow(/never-sent/);

    // A task with three parts; tasks whose pull requests stand in different places.
    await bot.run("task", "send", direct, "--id", "rework", "--title", "Relay rework", "--tag", "core", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "codec", "--title", "Write the codec", "--parent", "rework", "--status", "done", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "engine", "--title", "Wire the engine", "--parent", "rework", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "ui", "--title", "Draw the panel", "--parent", "rework", "--status", "queued", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "flaky", "--title", "Fix the flaky large-file spec", "--progress", "80", ...prOf(612), "--additions", "123", "--deletions", "45",
      "--pr-state", "open", "--pr-checks", "passing", "--tag", "e2e", "--tag", "web", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "docs", "--title", "Write the WISP", "--progress", "30", ...prOf(613), "--pr-state", "draft", "--pr-checks", "pending", "--tag", "docs", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "idle", "--title", "Rest the idle animations", "--status", "blocked", ...prOf(614), "--pr-state", "open", "--pr-checks", "failing", "--tag", "web", "--wait", "delivered");

    // In the chat the cards are the cards they always were: the new fields change nothing there.
    await expect(chat(person).locator('[data-testid="status-card"]')).toHaveCount(7, { timeout: 60_000 });
    await expect(chat(person).locator('[data-testid="status-card"][data-card-id="flaky"]').getByTestId("status-card-pr")).toHaveText("+123−45·PR #612");

    await page.getByTestId("sidebar-tasks").click();
    const board = page.getByTestId("tasks-board");
    await expect(page.getByTestId("board-column").getByRole("heading")).toHaveText(["Queued0", "Running2", "Blocked1", "Review1", "Done0", "Stopped0"]);
    await expect(page.getByTestId("tasks-summary")).toHaveText("6 active · 7 tasks");
    // Review: the running task whose pull request is open. The blocked one stays in Blocked, the draft in Running.
    expect(await ids(column(page, "review"))).toEqual(["flaky"]);
    expect(await ids(column(page, "blocked"))).toEqual(["idle"]);
    expect((await ids(column(page, "running"))).sort()).toEqual(["docs", "rework"]);
    const card = (id: string) => board.locator(`[data-testid="board-card"][data-card-id="${id}"]`);
    await expect(card("flaky")).toHaveAttribute("data-status", "running");
    await expect(card("flaky").getByTestId("board-card-checks")).toHaveAttribute("data-checks", "passing");
    await expect(card("flaky").getByTestId("board-card-checks")).toHaveText("✓Checks passing");
    await expect(card("idle").getByTestId("board-card-checks")).toHaveAttribute("data-checks", "failing");
    await expect(card("docs").getByTestId("board-card-checks")).toHaveAttribute("data-checks", "pending");
    await expect(card("flaky").getByTestId("board-card-open")).toHaveAccessibleName(/PR #612, Open, Checks passing, e2e, web, updated /);

    // The parts are under their task, in no column of their own.
    await expect(card("codec")).toHaveCount(0);
    await expect(card("rework").getByTestId("board-card-parts")).toHaveText("1 of 3 done");
    await card("rework").getByTestId("board-card-stack-toggle").click();
    await expect(card("rework").getByTestId("board-card-part")).toHaveText(["Wire the engineRunning", "Draw the panelQueued", "Write the codecDone"]);
    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await shot(page, `fields-desktop-${scheme}.png`);
    }
    await theme(page, "dark");

    // The bot marks a part done and the pull request merged: the summary and the columns follow.
    await bot.run("task", "update", direct, "engine", "--status", "done", "--wait", "confirmed", "--timeout", "60");
    await expect(card("rework").getByTestId("board-card-parts")).toHaveText("2 of 3 done", { timeout: 60_000 });
    await bot.run("task", "update", direct, "flaky", "--pr-state", "merged", "--wait", "confirmed", "--timeout", "60");
    // Merged, and still running: the task is done when its bot says so.
    await expect.poll(() => ids(column(page, "review")), { timeout: 60_000 }).toEqual([]);
    expect(await ids(column(page, "running"))).toContain("flaky");
    await bot.run("task", "update", direct, "flaky", "--status", "done", "--progress", "100", "--wait", "confirmed", "--timeout", "60");
    await expect.poll(() => ids(column(page, "done")), { timeout: 60_000 }).toEqual(["flaky"]);

    // Filtered by a tag; a part opens its own message in the chat.
    await expect(page.getByTestId("tasks-tag")).toHaveText(["web", "core", "docs", "e2e"]);
    await page.getByTestId("tasks-tags").getByRole("button", { name: "web" }).click();
    expect((await ids(board)).sort()).toEqual(["flaky", "idle"]);
    await page.getByTestId("tasks-tags").getByRole("button", { name: "web" }).click();
    // The filter took the task off the board and brought it back: its stack is folded again.
    await card("rework").getByTestId("board-card-stack-toggle").click();
    await card("rework").getByTestId("board-card-part").filter({ hasText: "Write the codec" }).click();
    await expect(page).toHaveURL(/#\/chat\//);
    await expect(chat(person).locator("[data-message-row]").filter({ has: page.locator('[data-testid="status-card"][data-card-id="codec"]') })).toHaveAttribute("data-reply-flash", "", { timeout: 30_000 });

    // A phone: Review is a tab like the others.
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/#/tasks");
    await expect(page.getByTestId("tasks-tab")).toHaveText(["Queued0", "Running2", "Blocked1", "Review0", "Done1", "Stopped0"]);
    await page.getByTestId("tasks-tab").nth(1).click();
    await page.locator('[data-testid="board-card"][data-card-id="rework"]').getByTestId("board-card-stack-toggle").click();
    await page.waitForTimeout(500);
    await shot(page, "fields-phone.png");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await bot.stop();
  }
});
