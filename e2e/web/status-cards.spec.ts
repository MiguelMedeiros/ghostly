import { pasteInvite } from "../support/clipboard";
import type { Locator, Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot's task cards (WISP 4xx · Status Cards): a headless bot sends a task and keeps it current with `task update`; the
 * person on the web app sees one card, not a text, move to 100 % and Done with its pull request, and the Tasks button
 * lists the chat's tasks, active first, a row taking them to the card.
 */
test.describe.configure({ timeout: 5 * 60_000 });

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

    // A phone's width: the card fits, the panel is a sheet.
    await page.setViewportSize({ width: 375, height: 740 });
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
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
    await coordinator.run("task", "send", group, "--id", "relay", "--title", "Fix relay rotation", "--progress", "30", "--wait", "sent", "--timeout", "120");
    await coordinator.run("task", "send", group, "--id", "docs", "--title", "Write the WISP", "--status", "queued", "--wait", "sent", "--timeout", "120");
    await hermes.run("task", "send", group, "--id", "nightly", "--title", "Nightly build", "--status", "done", "--progress", "100", "--wait", "sent", "--timeout", "120");
    const room = page.locator(".chat-wallpaper");
    await expect(room.getByTestId("status-card")).toHaveCount(3, { timeout: 120_000 });
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("2");

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

    for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
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
      await zeroRoutines.click();
      await page.getByTestId("chat-tasks-finished-toggle").click();
      await page.waitForTimeout(300); // the fade-in: measured after it
      await inWindow(page, panel);
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
