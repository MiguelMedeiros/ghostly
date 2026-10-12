import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A phone back in a busy room (WISP 902 group mesh § Catch-up): its app was away while five members wrote, each in
 * turn. Back, every member's edge opens within a moment of the first, and it reads the conversation in the order it
 * was written, the newest message last. Before, each member's own answer raced the first member's, which holds the
 * whole conversation in order: 30 messages came with 92 pairs out of order, the newest 14 rows above the last, out of
 * sight on a phone until the list was scrolled.
 */
const SENDERS = ["Coordinator", "Hermes Zero", "Hermes One", "Omarchy", "Mac"];
const TURNS = 6;

const list = (page: Page) => page.locator("[data-message-list]");

test("a phone back in a group of five reads what they wrote in turn in that order, the newest last", { tag: ["@feature:groups.catch-up"] }, async ({ peer, relay }) => {
  test.setTimeout(10 * 60_000);
  const url = await relay.listen();
  const bots = SENDERS.map(() => new HeadlessBot());
  try {
    await Promise.all(bots.map((bot, i) => bot.start(url, SENDERS[i])));
    const person = await peer("back-person", { mobile: true, viewport: { width: 375, height: 812 } });
    let page = person.page;
    const group = (await bots[0].run("group", "create", "Sala de Máquinas", "--mesh")).group as string;
    const { link } = await bots[0].run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    for (const bot of bots.slice(1)) await bot.run("group", "join", code);
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 200_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    const ready = async (bot: HeadlessBot) => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === SENDERS.length + 1 && shown.members.every(m => m.me || m.online);
    };
    for (const bot of bots) await expect.poll(() => ready(bot), { timeout: 300_000, intervals: [2_000] }).toBe(true);
    for (const [i, bot] of bots.entries()) await bot.run("group", "send", group, "--wait", "sent", "--timeout", "150", "--", `before ${i}`);
    await expect(list(page).getByText("before 4", { exact: true })).toBeVisible({ timeout: 120_000 });
    const groupUrl = page.url();

    // The phone's app goes away; the room goes on talking, each in turn.
    await page.close();
    const written: string[] = [];
    for (let turn = 0; turn < TURNS; turn++) for (const [b, bot] of bots.entries()) {
      const text = `talk ${String(written.length).padStart(2, "0")} from ${SENDERS[b]}`;
      written.push(text);
      await bot.run("group", "send", group, "--", text);
      await new Promise(done => setTimeout(done, 400));
    }

    // Back: what it missed is held by every member, and each one's edge opens.
    page = await person.context.newPage();
    await page.goto(groupUrl);
    await expect(page.getByTestId("group-chat")).toBeVisible({ timeout: 60_000 });
    const read = () => list(page).locator("[data-message-row] [data-testid=message-text]").evaluateAll(rows => rows.map(row => row.textContent ?? "").filter(text => text.startsWith("talk ")));
    await expect.poll(async () => (await read()).length, { timeout: 240_000, intervals: [1_000] }).toBe(written.length);
    expect(await read()).toEqual(written);
    // The newest is the last row, in view at the list's bottom.
    await expect(list(page).locator("[data-message-row]").last()).toContainText(written.at(-1)!);
    await expect(list(page).getByText(written.at(-1)!, { exact: true })).toBeInViewport();
  } catch (error) {
    for (const bot of bots) await bot.attachLogs(test.info());
    throw error;
  } finally {
    await Promise.all(bots.map(bot => bot.stop()));
  }
});
