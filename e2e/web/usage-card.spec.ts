import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot's usage (WISP 405 § Usage): headless bots say how much of their quota is left with `usage send`; the person on
 * the web app sees it on each bot's chat row and in the chat's header without opening anything, amber when low, red when
 * nearly out, and the details behind a tap. Each report edits the one card: the chat gets no stream of messages.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** The app's light or dark look, as Settings sets it, once its colours have settled. */
async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    // At most a second: a transition that never ends (seen once with the details open) must not hang the test.
    const settled = Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
    await Promise.race([settled, new Promise((done) => setTimeout(done, 1000))]);
  }, scheme);
}

/** A picture for the review, kept with the test's output and, when `USAGE_SHOTS` names a folder, copied there. */
async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  if (process.env.USAGE_SHOTS) { mkdirSync(process.env.USAGE_SHOTS, { recursive: true }); copyFileSync(path, join(process.env.USAGE_SHOTS, `${name}.png`)); }
}

test("a bot's usage shows on its chat's row and in the header, and follows its reports", { tag: ["@feature:chat.status-cards.usage", "@feature:headless.usage"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bots = [new HeadlessBot(), new HeadlessBot()];
  try {
    await Promise.all([bots[0].start(url, "Hermes One"), bots[1].start(url, "Hermes Two")]);
    const person = await peer("usage-person");
    const page = person.page, room = chat(person);
    await page.setViewportSize({ width: 1280, height: 800 });

    // The person joins each bot's invite; the first bot's chat ends up open.
    const chats: string[] = [];
    for (const bot of [bots[1], bots[0]]) {
      const invite = await bot.run("invite", "create", "--label", "person");
      await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
      await pasteInvite(page, invite.invite as string);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
      chats.unshift(invite.chat as string);
    }
    const [one, two] = chats;
    const row = (name: string) => page.getByTestId("chat-row").filter({ hasText: name });
    // No report yet: no meter.
    await expect(page.getByTestId("chat-usage")).toHaveCount(0);
    await expect(row("Hermes One").getByTestId("chat-row-usage")).toHaveCount(0);

    // The first report: a meter on the row and in the header, no colour at 62%.
    const resets = new Date(Date.now() + 3 * 3_600_000).toISOString(), week = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const first = await bots[0].run("usage", "send", one, "--label", "Claude", "--account", "work", "--left", "62", "--window", "5 h", "--resets", resets,
      "--also", `week=80@${week}`, "--wait", "sent");
    expect(first).toMatchObject({ chat: one, usage: "usage", updated: false });
    await expect(row("Hermes One").getByTestId("chat-row-usage")).toHaveAttribute("data-left", "62", { timeout: 60_000 });
    await expect(row("Hermes One").getByTestId("chat-row-usage")).toHaveAttribute("data-level", "ok");
    const header = page.getByTestId("chat-usage");
    await expect(header).toHaveAttribute("data-left", "62");
    await expect(header).toHaveText(/^62%·\d{2}:\d{2}/);
    const card = room.locator('[data-testid="status-card"][data-kind="usage"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("62% left");

    // The next report edits the same card: amber now, still one message in the chat.
    await bots[0].run("usage", "send", one, "--label", "Claude", "--account", "work", "--left", "12", "--window", "5 h", "--resets", resets,
      "--also", `week=41@${week}`, "--wait", "sent", "--timeout", "60");
    await expect(header).toHaveAttribute("data-left", "12", { timeout: 60_000 });
    await expect(header).toHaveAttribute("data-level", "low");
    await expect(row("Hermes One").getByTestId("chat-row-usage")).toHaveAttribute("data-level", "low");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("12% left");
    await expect(room.getByTestId("message-edited")).toHaveCount(0);

    // The other bot is nearly out: red on its row, though its chat is not open.
    await bots[1].run("usage", "send", two, "--label", "Claude", "--account", "personal", "--left", "3", "--window", "5 h", "--resets", resets, "--wait", "sent");
    await expect(row("Hermes Two").getByTestId("chat-row-usage")).toHaveAttribute("data-level", "critical", { timeout: 60_000 });
    await expect(row("Hermes Two").getByTestId("chat-row-usage")).toHaveAccessibleName(/^Claude: 3% left, resets /);

    // The header's details, the ⓘ open: on a wide screen and on a phone, in both looks.
    await page.getByTestId("chat-usage-open").click();
    const panel = page.getByTestId("chat-usage-panel");
    await expect(panel).toHaveAttribute("data-layout", "popover");
    await expect(panel.getByTestId("usage-details-account")).toContainText("work");
    await expect(panel.getByTestId("usage-details-window-0")).toContainText("41% left");
    await panel.getByTestId("chat-usage-info").click();
    await expect(panel.getByTestId("chat-usage-info-text")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await theme(page, scheme);
      await shot(page, `desktop-1280-${scheme}`);
    }
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 760 });
    await page.getByTestId("chat-usage-open").click();
    await expect(panel).toHaveAttribute("data-layout", "sheet");
    await panel.getByTestId("chat-usage-info").click();
    await page.waitForTimeout(400); // the sheet fades in: the picture after it
    for (const scheme of ["light", "dark"] as const) {
      await theme(page, scheme);
      await shot(page, `phone-375-header-${scheme}`);
    }
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    for (const scheme of ["light", "dark"] as const) {
      await theme(page, scheme);
      await shot(page, `phone-375-chat-${scheme}`);
    }
    await page.getByTestId("chat-back").click();
    await expect(row("Hermes Two").getByTestId("chat-row-usage")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await theme(page, scheme);
      await shot(page, `phone-375-list-${scheme}`);
    }
  } finally {
    await Promise.all(bots.map((bot) => bot.stop()));
  }
});
