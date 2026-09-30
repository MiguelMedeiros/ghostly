// The AI agents page (/developers/agents): Boo's chat with Casper, an agent on the headless CLI (packages/cli). Casper
// answers, thinks with a status line, posts a task card that runs to done with its pull request, a routine card and a
// second task still running. Desktop from Boo's side, the Tasks panel, then Boo's own profile reopened on a phone.
import { test, expect } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { LocalRelay } from "../../../../e2e/support/relay";
import { pasteInvite } from "../../../../e2e/support/clipboard";
import { HeadlessBot } from "../../../../e2e/support/headless";
import { CAST, REPO, chat, home, newProfile, open, person, portrait, shot, toBottom } from "./helpers";

const started = (min: number) => JSON.stringify({ startedAt: Date.now() - min * 60_000 });

test("an agent's cards in a chat, desktop and phone", async ({ browser, baseURL }) => {
  test.setTimeout(12 * 60_000);
  const relay = new LocalRelay();
  const profile = newProfile();
  const bot = new HeadlessBot();
  try {
    await bot.start(await relay.listen(), "Casper");
    const boo = await person(browser, relay, baseURL!, CAST.boo, { profile });
    // Casper's face, drawn in Boo's page like every portrait here, set with the CLI.
    const sharp = createRequire(join(REPO, "apps/website/package.json"))("sharp");
    const face = join(bot.home, "casper.jpg");
    writeFileSync(face, await sharp(await portrait(boo, CAST.casper)).resize(128, 128).jpeg({ quality: 88 }).toBuffer());
    await bot.run("profile", "picture", face);

    const invite = await bot.run("invite", "create", "--label", "boo");
    const chatId = invite.chat as string;
    await home(boo);
    await boo.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(boo.page, invite.invite as string);
    await bot.run("chat", "wait", chatId, "--until", "live", "--timeout", "120");
    await expect(boo.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });
    await expect(boo.page.getByTitle("Click to set a name")).toHaveText("Casper", { timeout: 30_000 }).catch(() => console.log("  [Boo] no name for Casper yet"));

    const box = boo.page.getByPlaceholder("Message…");
    await box.fill("Can you fix the relay rotation bug and open a PR?");
    await box.press("Enter");
    await bot.run("typing", chatId, "--kind", "thinking", "--status", "Reading the relay logs", "--for", "4");
    await bot.run("send", chatId, "On it. I'll keep a card here up to date.", "--wait", "delivered");

    // The task: sent fourteen minutes ago, its steps, then done with its pull request.
    await bot.run("task", "send", chatId, "--id", "relay", "--title", "Fix relay rotation", "--steps", "1/4", "--step", "Writing the codec",
      "--item", "done:Reproduce", "--item", "running:Codec", "--item", "pending:Tests", "--item", "pending:Open the PR", "--json", started(14), "--wait", "delivered");
    await bot.run("task", "update", chatId, "relay", "--steps", "3/4", "--step", "Waiting for CI",
      "--item", "done:Reproduce", "--item", "done:Codec", "--item", "done:Tests", "--item", "running:Open the PR");
    await bot.run("task", "update", chatId, "relay", "--status", "done", "--steps", "4/4", "--pr-url", "https://github.com/MiguelMedeiros/ghostly/pull/612",
      "--pr-number", "612", "--additions", "123", "--deletions", "45", "--files", "6",
      "--item", "done:Reproduce", "--item", "done:Codec", "--item", "done:Tests", "--item", "done:Open the PR", "--wait", "confirmed", "--timeout", "60");
    await bot.run("send", chatId, "Done: PR #612 is up, CI is green.", "--wait", "delivered");

    // The nightly routine, one run recorded, and a second task still going.
    await bot.run("routine", "send", chatId, "--id", "nightly", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--cron", "0 1 * * *",
      "--next", String(Date.now() + 9 * 3_600_000), "--wait", "delivered");
    await bot.run("routine", "update", chatId, "nightly", "--run", "ok:12 issues checked", "--wait", "confirmed", "--timeout", "60");
    await bot.run("task", "send", chatId, "--id", "e2e", "--title", "Run the e2e matrix", "--progress", "67", "--step", "WebKit", "--json", started(12), "--wait", "delivered");

    const room = chat(boo);
    await expect(room.locator('[data-testid="status-card"][data-card-id="relay"]')).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(room.locator('[data-testid="status-card"][data-card-id="e2e"]').getByTestId("status-card-elapsed")).toHaveText("running for 12 min", { timeout: 60_000 });
    // The done card opened: its steps and its pull request.
    await room.locator('[data-testid="status-card"][data-card-id="relay"]').getByTestId("status-card-toggle").click();
    // Casper thinking again, as the shot is taken.
    await bot.run("typing", chatId, "--kind", "thinking", "--status", "Reviewing the CI logs", "--for", "30");
    await expect(boo.page.getByText("Reviewing the CI logs").first()).toBeVisible({ timeout: 20_000 });
    await toBottom(boo);
    await shot(boo, "agents.png");

    await boo.page.getByTestId("chat-tasks").click();
    await expect(boo.page.getByTestId("chat-tasks-panel")).toBeVisible();
    await boo.page.waitForTimeout(500);
    await shot(boo, "x-agents-panel.png");
    await boo.page.keyboard.press("Escape");

    // The same Boo on a phone.
    const hash = await boo.page.evaluate(() => location.hash);
    await boo.context.close();
    const phone = await open(browser, relay, baseURL!, "mBoo", { mobile: true, profile });
    await phone.page.evaluate((h) => { location.hash = h; }, hash);
    await expect(chat(phone).locator('[data-testid="status-card"][data-card-id="e2e"]')).toBeVisible({ timeout: 60_000 });
    await expect(phone.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 }).catch(() => console.log("  [mBoo] not live yet"));
    await bot.run("typing", chatId, "--kind", "thinking", "--status", "Reviewing the CI logs", "--for", "30");
    await expect(phone.page.getByText("Reviewing the CI logs").first()).toBeVisible({ timeout: 20_000 }).catch(() => console.log("  [mBoo] no thinking line yet"));
    await phone.page.waitForTimeout(800);
    await toBottom(phone);
    await shot(phone, "agents-mobile.png");
    await phone.context.close();
  } finally {
    await bot.stop();
    rmSync(profile, { recursive: true, force: true });
    relay.close();
  }
});
