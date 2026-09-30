import { pasteInvite } from "../support/clipboard";
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

    // The panel: the running task first, the finished one after; a row takes the person to its card.
    await page.getByTestId("chat-tasks").click();
    const panel = page.getByTestId("chat-tasks-panel");
    await expect(panel.getByTestId("chat-tasks-active").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "docs");
    await expect(panel.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "relay");
    await panel.getByTestId("chat-tasks-finished").getByTestId("chat-tasks-item").click();
    await expect(page.getByTestId("chat-tasks-panel")).toHaveCount(0);
    await expect(room.locator("[data-message-row]").filter({ has: page.locator('[data-testid="status-card"][data-card-id="relay"]') })).toHaveAttribute("data-reply-flash", "");
    await expect(card).toBeInViewport();

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
    await expect(sections.getByTestId("chat-tasks-sender-name")).toHaveText(["Coordinator", "Hermes One"]);
    await expect(sections.first().getByTestId("chat-tasks-sender-count")).toHaveText("2 active");
    await expect(sections.nth(1).getByTestId("chat-tasks-item")).toHaveAttribute("data-card-id", "nightly");
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
