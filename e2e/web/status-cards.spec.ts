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
    await expect(room.locator("[data-message-row]").filter({ has: card })).toHaveAttribute("data-reply-flash", "");
    await expect(card).toBeInViewport();

    // A phone's width: the card fits, the panel is a sheet.
    await page.setViewportSize({ width: 375, height: 740 });
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await page.getByTestId("chat-tasks").click();
    await expect(page.getByTestId("chat-tasks-panel")).toBeVisible();
  } finally {
    await bot.stop();
  }
});
