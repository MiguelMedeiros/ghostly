import { pasteInvite } from "../support/clipboard";
import type { Locator, Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot's task cards (WISP 405 · Status Cards): a headless bot sends a task and keeps it current with `task update`; the
 * person on the web app sees one card, not a text, move to 100 % and Done with its pull request, and the Tasks button
 * lists the chat's tasks, active first, a row taking them to the card.
 */
test.describe.configure({ timeout: 5 * 60_000 });

/** The app's light or dark look, as Settings sets it, once its colours have settled. */
async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
  }, scheme);
}

/** A card's row stands on its own: the card is the surface, with no bubble and no "edited". */
async function standsAlone(row: Locator) {
  await expect(row.locator("[data-message-card]")).toHaveCount(1);
  await expect(row.locator("[data-message-bubble]")).toHaveCount(0);
  await expect(row.getByTestId("message-edited")).toHaveCount(0);
}

test("a bot's task card moves to done, and the Tasks button follows it", { tag: ["@feature:chat.status-cards", "@feature:chat.status-cards.wire", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("cards-person");
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const page = person.page, room = chat(person);

    // No card yet: no Tasks button.
    await expect(page.getByTestId("chat-tasks")).toHaveCount(0);

    const sent = await bot.run("task", "send", invite.chat as string, "--id", "relay", "--title", "Fix relay rotation", "--steps", "1/4", "--step", "Writing the codec",
      "--item", "done:Codec", "--item", "running:Engine", "--wait", "delivered");
    expect(sent).toMatchObject({ chat: invite.chat, task: "relay" });
    const card = room.locator('[data-testid="status-card"][data-card-id="relay"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId("status-card-title")).toHaveText("Fix relay rotation");
    await expect(card.getByTestId("status-card-progress")).toHaveAttribute("aria-valuenow", "25");
    // The card stands for its text: the fallback is not shown beside it.
    await expect(room.getByText("Now: Writing the codec")).toHaveCount(0);
    // A card of its own, not a bubble, named for a screen reader; how long it has been running, from when it started.
    const row = room.locator("[data-message-row]").filter({ has: page.locator(`[data-testid="status-card"][data-card-id="relay"]`) });
    await standsAlone(row);
    await expect(row.locator("[data-message-card]")).toHaveAttribute("role", "group");
    await expect(row.locator("[data-message-card]")).toHaveAccessibleName("Task: Fix relay rotation, Running, 25%");
    await expect(card.getByTestId("status-card-elapsed")).toHaveText(/^running for \d+ min$/);
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("1");

    // A second task, then the first one's updates: at the end one card, Done, full, with its pull request.
    await bot.run("task", "send", invite.chat as string, "--id", "docs", "--title", "Write the WISP", "--status", "running", "--progress", "60");
    await bot.run("task", "update", invite.chat as string, "relay", "--steps", "3/4", "--step", "CI");
    await bot.run("task", "update", invite.chat as string, "relay", "--status", "done", "--progress", "100", "--pr-url", "https://github.com/MiguelMedeiros/ghostly/pull/612",
      "--pr-number", "612", "--additions", "123", "--deletions", "45", "--wait", "confirmed", "--timeout", "60");
    await expect(card).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(card.getByTestId("status-card-progress")).toHaveAttribute("aria-valuenow", "100");
    await expect(card.getByTestId("status-card-pr")).toHaveText("+123−45·PR #612");
    await expect(room.locator('[data-testid="status-card"][data-card-id="relay"]')).toHaveCount(1);
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("1");
    // Updated three times: still no "edited", but when it was updated, and how long it took.
    await standsAlone(row);
    await expect(row.getByTestId("status-card-time")).toHaveAttribute("data-updated", "true");
    await expect(row.getByTestId("status-card-time")).toHaveText(/^updated /);
    await expect(card.getByTestId("status-card-elapsed")).toHaveText(/^took \d+ min$/);

    // Opened in place: the steps and the pull request's link, by its host.
    await card.getByTestId("status-card-toggle").click();
    await expect(card.getByTestId("status-card-item")).toHaveCount(2);
    await expect(card.getByTestId("status-card-link").first()).toHaveAttribute("href", "https://github.com/MiguelMedeiros/ghostly/pull/612");
    await expect(card.getByTestId("status-card-details")).toContainText("github.com");

    // The panel: the running task first, the finished one folded after; a row takes the person to its card.
    await page.getByTestId("chat-tasks").click();
    const panel = page.getByTestId("chat-tasks-panel");
    await expect(panel.getByTestId("chat-tasks-summary")).toHaveText("1 active");
    await expect(panel.getByTestId("chat-tasks-active").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "docs");
    await panel.getByTestId("chat-tasks-finished-toggle").click();
    await expect(panel.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "relay");
    await panel.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item").click();
    await expect(page.getByTestId("chat-tasks-panel")).toHaveCount(0);
    await expect(room.locator("[data-message-row]").filter({ has: page.locator('[data-testid="status-card"][data-card-id="relay"]') })).toHaveAttribute("data-reply-flash", "");
    await expect(card).toBeInViewport();

    // A routine: its schedule, then a run recorded; the panel lists it under Routines.
    await bot.run("routine", "send", invite.chat as string, "--id", "nightly", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--cron", "0 1 * * *",
      "--next", String(Date.now() + 3 * 3_600_000));
    const routine = room.locator('[data-testid="status-card"][data-card-id="nightly"]');
    await expect(routine.getByTestId("status-card-schedule")).toHaveText("every day 01:00");
    await expect(routine.getByTestId("status-card-last")).toHaveText("No runs yet");
    await bot.run("routine", "update", invite.chat as string, "nightly", "--run", "ok:12 issues checked", "--wait", "confirmed", "--timeout", "60");
    await expect(routine.getByTestId("status-card-last")).toContainText("OK", { timeout: 60_000 });
    await page.getByTestId("chat-tasks").click();
    await expect(page.getByTestId("chat-tasks-routines").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "nightly");
    await page.keyboard.press("Escape");

    // A task still running, started twelve minutes ago: the chat's pictures in both looks.
    await bot.run("task", "send", invite.chat as string, "--id", "e2e", "--title", "Run the e2e matrix", "--progress", "67", "--step", "WebKit",
      "--json", JSON.stringify({ startedAt: Date.now() - 12 * 60_000 }), "--wait", "delivered");
    const running = room.locator('[data-testid="status-card"][data-card-id="e2e"]');
    await expect(running.getByTestId("status-card-elapsed")).toHaveText("running for 12 min");
    await running.scrollIntoViewIfNeeded();
    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await page.screenshot({ path: test.info().outputPath(`desktop-${scheme}.png`) });
    }

    // A phone's width: the card fits, the panel is a sheet.
    await page.setViewportSize({ width: 375, height: 740 });
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await running.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("phone-card.png") });
    await page.getByTestId("chat-tasks").click();
    await expect(page.getByTestId("chat-tasks-panel")).toBeVisible();
    await page.waitForTimeout(400); // the sheet fades in: the picture after it
    await page.screenshot({ path: test.info().outputPath("phone-panel.png") });
  } finally {
    await bot.stop();
  }
});

test("in a group, each bot's tasks are listed under its name", { tag: ["@feature:chat.status-cards", "@feature:groups.send", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  test.setTimeout(8 * 60_000);
  const url = await relay.listen();
  const [coordinator, hermes] = [new HeadlessBot(), new HeadlessBot()];
  try {
    await Promise.all([coordinator.start(url, "Coordinator"), hermes.start(url, "Hermes One")]);
    const person = await peer("cards-group-person");
    const page = person.page;

    // The coordinator makes a private group and its link; Hermes and the person come in through it.
    const created = await coordinator.run("group", "create", "Sala de Máquinas", "--mesh");
    const group = created.group as string;
    const { link } = await coordinator.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await hermes.run("group", "join", code);
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    // Each bot sees all three members and an open edge to both others before it posts: a frame goes over the edges up now.
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    const ready = async (bot: HeadlessBot) => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 3 && shown.members.every(m => m.me || m.online);
    };
    await expect.poll(() => ready(coordinator), { timeout: 150_000, intervals: [2_000] }).toBe(true);
    await expect.poll(() => ready(hermes), { timeout: 150_000, intervals: [2_000] }).toBe(true);

    // Each bot posts: the coordinator two tasks, Hermes one, finished.
    const started = (min: number) => ["--json", JSON.stringify({ startedAt: Date.now() - min * 60_000 })];
    await coordinator.run("task", "send", group, "--id", "relay", "--title", "Fix relay rotation", "--progress", "30", ...started(12), "--wait", "sent", "--timeout", "120");
    await coordinator.run("task", "send", group, "--id", "docs", "--title", "Write the WISP", "--status", "queued", "--wait", "sent", "--timeout", "120");
    await hermes.run("task", "send", group, "--id", "nightly", "--title", "Nightly build", "--status", "done", "--progress", "100", "--wait", "sent", "--timeout", "120");
    const room = page.locator(".chat-wallpaper");
    await expect(room.getByTestId("status-card")).toHaveCount(3, { timeout: 120_000 });
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("2");

    // Each bot's cards under its coloured name, above the card, not in it: a card is one message of its sender's run.
    const rows = room.locator("[data-message-row][data-card-row]");
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) await standsAlone(row);
    await expect(room.getByTestId("message-nick")).toHaveText(["~Coordinator", "~Hermes One"]);
    await expect(room.locator("[data-message-card] [data-testid=message-nick]")).toHaveCount(0);
    await expect(room.locator('[data-testid="status-card"][data-card-id="relay"]').getByTestId("status-card-elapsed")).toHaveText("running for 12 min");
    for (const scheme of ["light", "dark"] as const) {
      await theme(page, scheme);
      await page.screenshot({ path: test.info().outputPath(`group-chat-${scheme}.png`) });
    }

    await page.getByTestId("chat-tasks").click();
    const sections = page.getByTestId("chat-tasks-panel").getByTestId("chat-tasks-sender");
    // Hermes has nothing going: its finished task is in the folded section at the end, with its name.
    await expect(sections.getByTestId("chat-tasks-sender-name")).toHaveText(["Coordinator"]);
    await expect(sections.first().getByTestId("chat-tasks-sender-count")).toHaveText("2 active");
    await page.getByTestId("chat-tasks-finished-toggle").click();
    await expect(page.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "nightly");
    await expect(page.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item")).toContainText("Hermes One");
    await page.waitForTimeout(400);
    await page.screenshot({ path: test.info().outputPath("group-panel.png") });

    // The coordinator finishes its task: the badge goes down, and the card says Done.
    await coordinator.run("task", "update", group, "relay", "--status", "done", "--progress", "100", "--wait", "sent", "--timeout", "120");
    await page.keyboard.press("Escape");
    await expect(room.locator('[data-testid="status-card"][data-card-id="relay"]')).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("1");
  } finally {
    await Promise.all([coordinator.stop(), hermes.stop()]);
  }
});

/** The panel and the chat stay inside the window, with nothing past its right edge. */
async function inWindow(page: Page, what: Locator) {
  const box = (await what.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Once the list settles, no row is half under the name (or Finished line) stuck at its top: the rows it cuts, if any. */
async function underStuck(panel: Locator): Promise<string[]> {
  await panel.page().waitForTimeout(600); // the scroll and its snap
  return panel.getByTestId("chat-tasks-scroll").evaluate((list) => {
    const top = list.getBoundingClientRect().top;
    const stuck = [...list.querySelectorAll<HTMLElement>("h3, [data-testid=chat-tasks-finished-toggle]")]
      .filter((el) => getComputedStyle(el).position === "sticky" && Math.abs(el.getBoundingClientRect().top - top) < 1);
    const edge = Math.max(top, ...stuck.map((el) => el.getBoundingClientRect().bottom));
    return [...list.querySelectorAll<HTMLElement>("[data-panel-row]")].filter((row) => !stuck.includes(row)).filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top < edge - 1 && r.bottom > edge + 1;
    }).map((row) => row.textContent ?? "");
  });
}

test("a room of bots with many routines: the panel scrolls inside the window, the chat folds the routines", { tag: ["@feature:chat.status-cards", "@feature:groups.send", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  test.setTimeout(10 * 60_000);
  const url = await relay.listen();
  const [coordinator, zero, one] = [new HeadlessBot(), new HeadlessBot(), new HeadlessBot()];
  try {
    await Promise.all([coordinator.start(url, "Coordinator"), zero.start(url, "Hermes Zero"), one.start(url, "Hermes One")]);
    const person = await peer("cards-load-person", { viewport: { width: 1280, height: 800 } });
    const page = person.page;
    const created = await coordinator.run("group", "create", "Sala de Máquinas", "--mesh");
    const group = created.group as string;
    const { link } = await coordinator.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await zero.run("group", "join", code);
    await one.run("group", "join", code);
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    const ready = async (bot: HeadlessBot) => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 4 && shown.members.some(m => !m.me && m.online);
    };
    for (const bot of [coordinator, zero, one]) await expect.poll(() => ready(bot), { timeout: 200_000, intervals: [2_000] }).toBe(true);
    // The person knows all four too: a member it learns of later has its "joined" line where it learned it, which may be
    // amid Hermes Zero's routines, and would part them into two rows.
    await expect(page.getByTestId("group-members")).toContainText("4 members", { timeout: 200_000 });

    // Miguel's load: the coordinator's two tasks and two routines, Hermes Zero's ten routines, Hermes One's two tasks and two routines.
    const sent = ["--wait", "sent", "--timeout", "150"];
    const now = Date.now();
    await coordinator.run("task", "send", group, "--id", "ux", "--title", "Status cards UX", "--steps", "2/5", "--item", "done:Reproduce", "--item", "running:Panel", ...sent);
    await coordinator.run("task", "send", group, "--id", "relay", "--title", "Fix relay rotation", "--status", "done", "--progress", "100", "--pr-url", "https://github.com/MiguelMedeiros/ghostly/pull/712", "--pr-number", "712", ...sent);
    await coordinator.run("routine", "send", group, "--id", "bughunt", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--next", String(now + 5 * 3_600_000), "--run", "ok", ...sent);
    await coordinator.run("routine", "send", group, "--id", "prqueue", "--name", "PR queue", "--schedule", "every 5 min", "--next", String(now + 4 * 60_000), "--run", "ok", ...sent);
    const jobs = ["watchdog 15 min", "disk usage", "backup sync", "cert renew", "docker prune", "log rotate", "uptime ping", "relay health", "DHT probe", "tunnel check"];
    for (const [i, job] of jobs.entries()) {
      await zero.run("routine", "send", group, "--id", `zero-${i}`, "--name", `Zero · ${job}`, "--schedule", i % 3 ? "every hour" : "every 15 min",
        "--next", String(now + (i + 2) * 60_000), "--run", i === 6 ? "failed:timeout" : "ok", ...sent);
    }
    await one.run("task", "send", group, "--id", "e2e", "--title", "Run the e2e matrix on One", "--progress", "45", ...sent);
    await one.run("task", "send", group, "--id", "bench", "--title", "Benchmarks", "--status", "blocked", ...sent);
    await one.run("routine", "send", group, "--id", "one-a", "--name", "One · nightly e2e", "--schedule", "every day 03:00", "--next", String(now + 7 * 3_600_000), ...sent);
    await one.run("routine", "send", group, "--id", "one-b", "--name", "One · docker cleanup", "--schedule", "every 6 h", "--next", String(now + 2 * 3_600_000), ...sent);
    const room = page.locator(".chat-wallpaper");
    await expect(room.getByTestId("status-card")).toHaveCount(18, { timeout: 300_000 });
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("3");

    // In the chat: Hermes Zero's ten routines are one row, opened on a tap; each routine is one line.
    const stack = room.getByTestId("routine-stack").filter({ hasText: "Hermes Zero" });
    await expect(stack).toHaveAttribute("data-count", "10");
    await expect(stack.getByTestId("routine-stack-toggle")).toContainText("10 routines");
    await expect(stack.getByTestId("status-card").first()).toBeHidden();
    await stack.getByTestId("routine-stack-toggle").click();
    await expect(stack.getByTestId("status-card")).toHaveCount(10);
    const line = (await stack.getByTestId("status-card").first().getByTestId("status-card-toggle").boundingBox())!;
    expect(line.height).toBeLessThan(40);
    await stack.getByTestId("routine-stack-toggle").click();
    await expect(stack.getByTestId("status-card").first()).toBeHidden();

    // The phone is an installed app on an iPhone: the status bar is 47px of the page's top.
    const cdp = await page.context().newCDPSession(page);
    for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
      const statusBar = size.width < 768 ? 47 : 0;
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: statusBar, bottom: statusBar ? 34 : 0, left: 0, right: 0 } });
      await page.setViewportSize(size);
      await page.getByTestId("chat-tasks").click();
      const panel = page.getByTestId("chat-tasks-panel");
      await expect(panel).toHaveAttribute("data-layout", size.width < 768 ? "sheet" : "popover");
      await expect(panel.getByTestId("chat-tasks-summary")).toHaveText("3 active · 14 routines");
      await expect(panel.getByTestId("chat-tasks-sender-name")).toHaveText(["Hermes One", "Coordinator", "Hermes Zero"]);
      // Hermes Zero's routines: one line, opened to ten.
      const zeroRoutines = panel.getByTestId("chat-tasks-sender").filter({ hasText: "Hermes Zero" }).getByTestId("chat-tasks-routines-toggle");
      await expect(zeroRoutines).toContainText("10 routines");
      await expect(zeroRoutines).toContainText("1 failed");
      // Open, the first row of each section sits whole under its name.
      expect(await underStuck(panel)).toEqual([]);
      await zeroRoutines.click();
      expect(await underStuck(panel)).toEqual([]);
      await page.getByTestId("chat-tasks-finished-toggle").click();
      expect(await underStuck(panel)).toEqual([]);
      await inWindow(page, panel);
      // Its header clear of the status bar: the sheet reached 40px from the top, under it.
      expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(statusBar);
      // Only the list scrolls: nothing in it makes the panel itself taller than its box, so a row scrolled into view
      // (a click, a focus) never scrolls the header out of sight.
      // (It was 119 px over with Hermes Zero's routines open; a pixel of rounding is not that.)
      const own = await panel.evaluate((p) => ({ top: p.scrollTop, over: p.scrollHeight - p.clientHeight }));
      expect(own.top).toBe(0);
      expect(own.over).toBeLessThanOrEqual(1);
      // Taller than the box: it scrolls, the header stays.
      const scroll = panel.getByTestId("chat-tasks-scroll");
      expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight + 20)).toBe(true);
      if (size.width >= 768) expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(Math.min(0.7 * size.height, 560) + 1);
      await page.screenshot({ path: test.info().outputPath(`panel-${size.width}.png`) });
      // The last row is reachable, and takes the person to its card.
      const last = panel.getByTestId("chat-tasks-item").last();
      await expect(last).toHaveAttribute("data-card-id", "relay");
      await last.scrollIntoViewIfNeeded();
      await expect(panel.getByTestId("chat-tasks-summary")).toBeInViewport();
      expect(await underStuck(panel)).toEqual([]);
      // Scrolled by hand to anywhere, it settles with no row cut either.
      await scroll.evaluate(el => el.scrollBy({ top: -77 }));
      expect(await underStuck(panel)).toEqual([]);
      await last.scrollIntoViewIfNeeded();
      await last.click();
      await expect(panel).toHaveCount(0);
      await expect(room.locator('[data-testid="status-card"][data-card-id="relay"]')).toBeInViewport();
    }

    // A routine in the folded row: the jump opens it first.
    await page.getByTestId("chat-tasks").click();
    const panel = page.getByTestId("chat-tasks-panel");
    await panel.getByTestId("chat-tasks-sender").filter({ hasText: "Hermes Zero" }).getByTestId("chat-tasks-routines-toggle").click();
    await panel.locator('[data-testid="chat-tasks-item"][data-card-id="zero-3"]').click();
    await expect(stack).toHaveAttribute("data-open", "");
    await expect(room.locator('[data-testid="status-card"][data-card-id="zero-3"]')).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("chat-375.png") });
  } finally {
    await Promise.all([coordinator.stop(), zero.stop(), one.stop()]);
  }
});

/** The app in another language, as Settings sets it: the page reloads in it. */
async function useLanguage(page: Page, language: string) {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/**
 * What spills: any part of a card drawn past the card's own box, and any of its row's actions (⋮, reply, react) drawn
 * over it. Empty when every card keeps to its box.
 */
async function spills(room: Locator): Promise<string[]> {
  return room.evaluate((room) => {
    const out: string[] = [];
    const cards = [...room.querySelectorAll<HTMLElement>("[data-message-card], [data-testid=routine-stack-toggle]")].filter((c) => c.offsetParent);
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const name = (card.textContent ?? "").slice(0, 40);
      for (const el of card.querySelectorAll<HTMLElement>("*")) {
        if (el.closest(".sr-only") || getComputedStyle(el).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${name} → <${el.tagName.toLowerCase()}> "${(el.textContent ?? "").slice(0, 30)}"`);
      }
      const row = card.closest("[data-message-row]");
      for (const action of row?.querySelectorAll<HTMLElement>("[data-testid=message-reply-action], [data-testid=message-react-action], [data-testid=message-options]") ?? []) {
        const r = action.getBoundingClientRect();
        if (r.width && r.left < box.right - 1 && r.right > box.left + 1) out.push(`${name} → its ${action.dataset.testid} over the card`);
      }
    }
    return out;
  });
}

test("the review pictures: a bot room's routines and tasks at every width, both looks, and in Arabic, Portuguese and French", { tag: ["@feature:chat.status-cards", "@feature:groups.send", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  test.setTimeout(12 * 60_000);
  const url = await relay.listen();
  const [coordinator, zero] = [new HeadlessBot(), new HeadlessBot()];
  const shot = (name: string) => test.info().outputPath(`review-${name}.png`);
  try {
    await Promise.all([coordinator.start(url, "Coordinator"), zero.start(url, "Hermes Zero")]);
    const person = await peer("cards-review-person", { viewport: { width: 1280, height: 860 } });
    const page = person.page;
    const created = await coordinator.run("group", "create", "Sala de Máquinas", "--mesh");
    const group = created.group as string;
    const { link } = await coordinator.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await zero.run("group", "join", code);
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    const ready = async (bot: HeadlessBot) => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 3 && shown.members.every(m => m.me || m.online);
    };
    for (const bot of [coordinator, zero]) await expect.poll(() => ready(bot), { timeout: 200_000, intervals: [2_000] }).toBe(true);
    await expect(page.getByTestId("group-members")).toContainText("3 members", { timeout: 200_000 });

    // Miguel's room: Hermes Zero's routines with long names between the coordinator's tasks, one routine failed with a
    // long error, and three routines in a row folded into one line.
    const sent = ["--wait", "sent", "--timeout", "150"];
    const now = Date.now(), min = 60_000, hr = 60 * min;
    const json = (value: unknown) => ["--json", JSON.stringify(value)];
    const error = "RuntimeError: HTTP 429: This request would exceed your account's rate limit. Please try again later.";
    await zero.run("routine", "send", group, "--id", "zero-nas", "--name", "Zero · zero NAS backup freshness watchdog", "--schedule", "every 15 min", "--next", String(now + 11 * min), "--run", "ok", ...sent);
    await zero.run("routine", "send", group, "--id", "zero-log", "--name", "Zero · Murray Rothbot zero log auto-remediation", "--schedule", "every hour", "--next", String(now + 26 * min), "--run", "ok", ...sent);
    await coordinator.run("task", "send", group, "--id", "ux", "--title", "Status cards: a cleaner layout for the tasks and routines in the chat", "--progress", "45", "--steps", "2/5",
      "--step", "Tasks panel", ...json({ startedAt: now - 12 * min }), ...sent);
    await zero.run("routine", "send", group, "--id", "zero-daily", "--name", "Zero · Murray Rothbot daily product/quality review", "--schedule", "weekdays at 10:30", "--cron", "30 10 * * 1-5",
      "--next", String(now + 23 * hr), ...json({ lastRun: { at: now - 29 * min, result: "failed", summary: error }, runs: [{ at: now - 29 * min, result: "failed", summary: error }, { at: now - 13 * hr, result: "ok", summary: "12 issues checked" }] }), ...sent);
    await coordinator.run("task", "send", group, "--id", "relay", "--title", "Fix relay rotation", "--status", "done", "--progress", "100", "--pr-url", "https://github.com/MiguelMedeiros/ghostly/pull/712",
      "--pr-number", "712", "--additions", "123", "--deletions", "45", ...json({ startedAt: now - 54 * min }), ...sent);
    await zero.run("routine", "send", group, "--id", "zero-hosted", "--name", "Zero · zero hosted products — maintenance and improvement sweep", "--schedule", "every day 11:00", "--next", String(now + 24 * hr), "--run", "ok", ...sent);
    await coordinator.run("task", "send", group, "--id", "bench", "--title", "Benchmarks on One", "--status", "blocked", "--progress", "30", "--step", "Waiting for the runner", ...json({ startedAt: now - 5 * min }), ...sent);
    await zero.run("routine", "send", group, "--id", "zero-mempool", "--name", "Zero · Mempool Matrix recurring product maintenance", "--schedule", "every Monday", "--next", String(now + 7 * 24 * hr), "--run", "ok", ...sent);
    await coordinator.run("routine", "send", group, "--id", "bughunt", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--next", String(now + 5 * hr), "--run", "ok", ...sent);
    await coordinator.run("routine", "send", group, "--id", "prqueue", "--name", "PR queue", "--schedule", "every 5 min", "--next", String(now + 4 * min), "--run", "ok", ...sent);
    await coordinator.run("routine", "send", group, "--id", "docs", "--name", "Docs sync", "--schedule", "every 6 h", "--state", "paused", ...sent);
    const room = page.locator(".chat-wallpaper");
    await expect(room.getByTestId("status-card")).toHaveCount(11, { timeout: 300_000 });
    const failed = room.locator('[data-testid="status-card"][data-card-id="zero-daily"]');

    const widths = [{ width: 1280, height: 860 }, { width: 768, height: 1024 }, { width: 375, height: 812 }, { width: 320, height: 640 }];
    for (const size of widths) {
      await page.setViewportSize(size);
      for (const scheme of ["dark", "light"] as const) {
        await theme(page, scheme);
        await room.getByTestId("routine-stack").last().scrollIntoViewIfNeeded();
        expect.soft(await spills(room), `${size.width} px, ${scheme}`).toEqual([]);
        await page.screenshot({ path: shot(`${size.width}-${scheme}`) });
      }
    }

    // The folded routines opened: each one in its sender's run, their face beside the last, as bubbles have it.
    const stack = room.getByTestId("routine-stack").last();
    await stack.getByTestId("routine-stack-toggle").click();
    for (const size of [widths[0], widths[2]]) {
      await page.setViewportSize(size);
      await theme(page, "dark");
      await stack.getByTestId("status-card").last().scrollIntoViewIfNeeded();
      expect.soft(await spills(room), `stack open, ${size.width} px`).toEqual([]);
      await page.screenshot({ path: shot(`stack-open-${size.width}-dark`) });
    }
    await stack.getByTestId("routine-stack-toggle").click();

    // A row's actions on hover, beside the card, not on it.
    await page.setViewportSize(widths[0]);
    await theme(page, "dark");
    const logRow = room.locator("[data-message-row]").filter({ has: page.locator('[data-card-id="zero-log"]') });
    await logRow.evaluate((row) => row.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(300);
    await logRow.locator("[data-message-card]").hover();
    await expect(logRow.getByTestId("message-reply-action")).toHaveCSS("opacity", "1");
    expect.soft(await spills(room), "hovered").toEqual([]);
    await page.screenshot({ path: shot("1280-dark-hover") });

    // The failed routine opened: its error, when it runs next, its cron line, its recent runs.
    await failed.getByTestId("status-card-toggle").click();
    await expect(failed.getByTestId("status-card-details")).toContainText("HTTP 429");
    for (const size of [widths[0], widths[2]]) {
      await page.setViewportSize(size);
      for (const scheme of ["dark", "light"] as const) {
        await theme(page, scheme);
        await failed.scrollIntoViewIfNeeded();
        expect.soft(await spills(room), `opened, ${size.width} px, ${scheme}`).toEqual([]);
        await page.screenshot({ path: shot(`opened-${size.width}-${scheme}`) });
      }
    }
    await theme(page, "dark");
    await failed.getByTestId("status-card-toggle").click();

    // The Tasks panel, wide and as a phone's sheet.
    for (const size of [widths[0], widths[2]]) {
      await page.setViewportSize(size);
      await page.getByTestId("chat-tasks").click();
      const panel = page.getByTestId("chat-tasks-panel");
      // Each bot's face before its name, its initial in its colour (these bots have no picture); a finished task's row too.
      for (const [name, initial] of [["Hermes Zero", "H"], ["Coordinator", "C"]]) {
        await expect(panel.getByTestId("chat-tasks-sender").filter({ hasText: name }).locator("h3").getByTestId("member-face")).toHaveText(initial);
      }
      await panel.getByTestId("chat-tasks-sender").filter({ hasText: "Hermes Zero" }).getByTestId("chat-tasks-routines-toggle").click();
      await panel.getByTestId("chat-tasks-finished-toggle").click();
      await expect(panel.getByTestId("chat-tasks-finished").getByTestId("member-face")).toHaveText("C");
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot(`panel-${size.width}-dark`) });
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    }

    // Right to left, and the longer words of Portuguese and French.
    for (const [language, size] of [["ar", widths[0]], ["ar", widths[2]], ["pt", widths[2]], ["fr", widths[3]]] as const) {
      await page.setViewportSize(size);
      await useLanguage(page, language);
      await expect(room.getByTestId("status-card")).toHaveCount(11, { timeout: 60_000 });
      await theme(page, "dark");
      await room.getByTestId("routine-stack").last().scrollIntoViewIfNeeded();
      expect.soft(await spills(room), `${language}, ${size.width} px`).toEqual([]);
      await page.screenshot({ path: shot(`${language}-${size.width}-dark`) });
      if (language === "ar") {
        await page.getByTestId("chat-tasks").click();
        await page.getByTestId("chat-tasks-sender").filter({ hasText: "Hermes Zero" }).getByTestId("chat-tasks-routines-toggle").click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: shot(`panel-ar-${size.width}-dark`) });
        await page.keyboard.press("Escape");
      }
    }
  } finally {
    await Promise.all([coordinator.stop(), zero.stop()]);
  }
});
