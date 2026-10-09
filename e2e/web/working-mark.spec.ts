import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * Whether a bot is working (WISP 405 § Showing a card): headless bots say what they do with task cards; the person on
 * the web app sees a dot on each bot's row in the chat list while one of its tasks is running, without opening
 * anything. The dot turns muted once the bot has been quiet for 15 minutes, and goes when the task is done; it comes
 * and goes without moving the row's usage meter.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** The app's light or dark look, as Settings sets it, once its colours have settled. */
async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    const settled = Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
    await Promise.race([settled, new Promise((done) => setTimeout(done, 1000))]);
  }, scheme);
}

/** A picture for the review, kept with the test's output and, when `WORKING_SHOTS` names a folder, copied there. */
async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  if (process.env.WORKING_SHOTS) { mkdirSync(process.env.WORKING_SHOTS, { recursive: true }); copyFileSync(path, join(process.env.WORKING_SHOTS, `${name}.png`)); }
}

const left = async (locator: Locator) => Math.round((await locator.boundingBox())!.x);

test("a bot's running task shows as a dot on its chat's row, muted once it goes quiet, gone when it is done", { tag: ["@feature:chat.status-cards.working", "@feature:headless.status-cards"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  // One has a usage meter and a task; Two a task and no meter; Three a meter and no task.
  const bots = [new HeadlessBot(), new HeadlessBot(), new HeadlessBot()];
  try {
    await Promise.all(bots.map((bot, i) => bot.start(url, `Hermes ${["One", "Two", "Three"][i]}`)));
    const person = await peer("working-person");
    const page = person.page;
    await page.setViewportSize({ width: 1280, height: 800 });

    const chats: string[] = [];
    for (const bot of bots) {
      const invite = await bot.run("invite", "create", "--label", "person");
      await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
      await pasteInvite(page, invite.invite as string);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
      chats.push(invite.chat as string);
    }
    const [one, two, three] = chats;
    const row = (name: string) => page.getByTestId("chat-row").filter({ hasText: name });
    const dot = (name: string) => row(name).getByTestId("chat-row-working");
    const meter = (name: string) => row(name).getByTestId("chat-row-usage");

    // The meters first, with nobody working: no dot, and each meter's row keeps the dot's place.
    for (const [bot, chat] of [[bots[0], one], [bots[2], three]] as const) await bot.run("usage", "send", chat, "--label", "Claude", "--left", "62", "--window", "5 h", "--wait", "sent");
    await expect(meter("Hermes One")).toBeVisible({ timeout: 60_000 });
    await expect(meter("Hermes Three")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("chat-row-working")).toHaveCount(0);
    const idle = { meter: await left(meter("Hermes One")), width: (await row("Hermes One").boundingBox())!.width };

    // Two bots start a task: a dot on each one's row, though neither chat is open (the third bot's is).
    await bots[0].run("task", "send", one, "--id", "fix", "--title", "Fix relay rotation", "--status", "running", "--step", "Running the tests", "--wait", "sent");
    await bots[1].run("task", "send", two, "--id", "docs", "--title", "Write the WISP", "--status", "running", "--wait", "sent");
    await expect(dot("Hermes One")).toHaveAttribute("data-state", "working", { timeout: 60_000 });
    await expect(dot("Hermes Two")).toHaveAttribute("data-state", "working", { timeout: 60_000 });
    await expect(dot("Hermes Three")).toHaveCount(0);
    await expect(dot("Hermes One")).toHaveAccessibleName("Working");
    await expect(dot("Hermes One")).toHaveAttribute("title", "Working · Fix relay rotation · Running the tests");
    // The dot took the place its row kept: the meter and the row are where they were, and where the idle bot's are.
    expect(await left(meter("Hermes One"))).toBe(idle.meter);
    expect((await row("Hermes One").boundingBox())!.width).toBe(idle.width);
    expect(await left(meter("Hermes Three"))).toBe(idle.meter);
    // Compact, the list's default: the dot is right after the name, on the name's line.
    const afterName = async (name: string) => {
      const title = (await row(name).getByTestId("chat-row-name").boundingBox())!, mark = (await dot(name).boundingBox())!;
      expect(mark.x - (title.x + title.width)).toBeGreaterThanOrEqual(0);
      expect(mark.x - (title.x + title.width)).toBeLessThan(12);
      expect(Math.abs(mark.y + mark.height / 2 - (title.y + title.height / 2))).toBeLessThan(4);
    };
    await afterName("Hermes One");
    await afterName("Hermes Two");

    /** Both densities in both looks, for the review; the dots share one place in each. */
    const pictures = async (state: string) => {
      for (const density of ["Compact", "Comfortable"] as const) {
        await page.goto("/#/settings");
        await page.getByTestId("chat-list-density").getByRole("button", { name: density }).click();
        await expect(row("Hermes One").getByTestId("chat-row-key")).toHaveCount(density === "Comfortable" ? 1 : 0);
        // Comfortable: the dots share one place, after the key. Compact: each after its name.
        if (density === "Comfortable") expect(await left(dot("Hermes Two"))).toBe(await left(dot("Hermes One")));
        else await afterName("Hermes Two");
        expect(await left(meter("Hermes Three"))).toBe(await left(meter("Hermes One")));
        for (const scheme of ["light", "dark"] as const) {
          await theme(page, scheme);
          await shot(page, `${state}-${density.toLowerCase()}-${scheme}`);
        }
        if (density === "Compact") {
          // A phone's width: the list alone, the dot still right after the name.
          await page.setViewportSize({ width: 375, height: 760 });
          await page.goto("/#/");
          await afterName("Hermes One");
          for (const scheme of ["light", "dark"] as const) {
            await theme(page, scheme);
            await shot(page, `${state}-compact-phone-${scheme}`);
          }
          await page.setViewportSize({ width: 1280, height: 800 });
        }
      }
    };
    await pictures("working");

    // Sixteen minutes on with no word from the bots: both dots are muted, and say for how long.
    await page.clock.setFixedTime(Date.now() + 16 * 60_000);
    await expect(dot("Hermes One")).toHaveAttribute("data-state", "stale", { timeout: 90_000 });
    await expect(dot("Hermes Two")).toHaveAttribute("data-state", "stale");
    await expect(dot("Hermes One")).toHaveAccessibleName(/^No update for 1[67] min$/);
    await pictures("stale");

    // The first bot finishes: its dot goes, its meter stays where it was. The other is still at it.
    await bots[0].run("task", "update", one, "fix", "--status", "done");
    await expect(dot("Hermes One")).toHaveCount(0, { timeout: 60_000 });
    await expect(dot("Hermes Two")).toHaveCount(1);
    expect(await left(meter("Hermes One"))).toBe(await left(meter("Hermes Three")));
  } finally {
    await Promise.all(bots.map((bot) => bot.stop()));
  }
});
