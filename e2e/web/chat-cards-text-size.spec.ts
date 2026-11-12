import type { Locator, Page } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { copyInvite, pasteInvite } from "../support/clipboard";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * Settings → Text size reaches a chat's cards as it reaches its messages: a Nostr key's and an invite's card, a new
 * chat's invite, a bot's task, routine and usage cards are half again their size at Huge, and none of them goes past a
 * phone's screen. Their icons, badges, buttons and time keep their size.
 */
test.describe.configure({ timeout: 6 * 60_000 });

const PHONE = { width: 390, height: 844 };

const px = (target: Locator) => target.evaluate((element) => Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);
/** Words whose line is shorter than they are, so their tops or tails are cut. */
const squeezed = (words: Record<string, Locator>) => Promise.all(Object.entries(words).map(([name, target]) => target.evaluate((element, name) => {
  const style = getComputedStyle(element);
  return style.lineHeight !== "normal" && parseFloat(style.lineHeight) < parseFloat(style.fontSize) * 1.15 ? `${name} ${style.lineHeight} for ${style.fontSize}` : "";
}, name))).then((out) => out.filter(Boolean));
const sizes = async (words: Record<string, Locator>) => Object.fromEntries(await Promise.all(Object.entries(words).map(async ([name, target]) => [name, await px(target)])));

/** The page wider than the screen, or a card past its edge. */
const cut = (page: Page, cards: Locator[]) => Promise.all(cards.map((card) => card.evaluate((card) => {
  const box = card.getBoundingClientRect();
  return box.left < -0.5 || box.right > window.innerWidth + 0.5 ? `${card.getAttribute("data-testid")} at ${box.left}-${box.right}` : "";
}))).then(async (out) => [...out.filter(Boolean), ...(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth ? [`page ${document.documentElement.scrollWidth}`] : []))]);

async function textSize(page: Page, textSize: string): Promise<void> {
  await page.evaluate((textSize) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), textSize })), textSize);
  await page.reload();
}

async function openChat(peer: Peer): Promise<void> {
  await peer.page.goto("/#/");
  await peer.page.getByTestId("chat-row").first().click();
  await expect(chat(peer)).toBeVisible();
}

test("at Text size Huge on a phone, a Nostr key's and an invite's cards and a new chat's invite grow with the messages", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout", "@feature:chat.cards.nostr", "@feature:chat.cards.invite"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("cards-size-alice"), peer("cards-size-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;
  await say(alice, `follow nostr:${npubEncode(getPublicKey(generateSecretKey()))} for ghost news`);
  // Alice makes a second invite (a new chat showing its invite card) and sends its link to Bob.
  const aliceChat = await alice.page.evaluate(() => location.hash);
  await alice.page.getByTitle("New Chat").click();
  const invite = alice.page.getByTestId("invite-card");
  await expect(invite).toBeVisible();
  const newChat = await alice.page.evaluate(() => location.hash);
  const inviteTitle = invite.locator("h2");
  expect(await px(inviteTitle)).toBe(14);
  const shared = await copyInvite(alice.page);
  await alice.page.evaluate((hash) => { location.hash = hash; }, aliceChat);
  await say(alice, `for your other profile: ${shared} thanks`);

  const nostr = chat(bob).getByTestId("entity-nostr");
  const card = chat(bob).getByTestId("entity-invite");
  await expect(nostr.getByTestId("entity-nostr-where")).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-outcome", "new", { timeout: 60_000 });
  const words = {
    nostrLabel: nostr.locator("p").first(),
    nostrTitle: nostr.locator("p").nth(1),
    nostrWhere: nostr.getByTestId("entity-nostr-where"),
    inviteLabel: card.locator("p").first(),
    inviteTitle: card.locator("p").nth(1),
    joinButton: card.getByTestId("entity-invite-join"),
  };
  expect(await sizes(words)).toEqual({ nostrLabel: 11, nostrTitle: 13.5, nostrWhere: 11, inviteLabel: 11, inviteTitle: 13.5, joinButton: 12 });

  await textSize(page, "huge");
  await page.setViewportSize(PHONE);
  await openChat(bob);
  await expect(card).toBeVisible();
  // Half again their size, as the messages are; the card's button keeps its own.
  expect(await sizes(words)).toEqual({ nostrLabel: 16.5, nostrTitle: 20.3, nostrWhere: 16.5, inviteLabel: 16.5, inviteTitle: 20.3, joinButton: 12 });
  expect(await cut(page, [nostr, card])).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("entity-huge.png"), fullPage: true });

  // Alice's new chat, its invite still waiting: its title at Huge too.
  await textSize(alice.page, "huge");
  await alice.page.setViewportSize(PHONE);
  await alice.page.evaluate((hash) => { location.hash = hash; }, newChat);
  await expect(invite).toBeVisible();
  expect(await px(inviteTitle)).toBe(21);
  expect(await cut(alice.page, [invite])).toEqual([]);
});

test("at Text size Huge on a phone, a bot's task, routine and usage cards grow with the messages", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout", "@feature:chat.status-cards", "@feature:chat.status-cards.usage"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("cards-size-person");
    const page = person.page, room = chat(person);
    const invite = await bot.run("invite", "create", "--label", "person");
    await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

    await bot.run("task", "send", invite.chat as string, "--id", "relay", "--title", "Fix relay rotation", "--steps", "1/4", "--step", "Writing the codec", "--wait", "delivered");
    await bot.run("routine", "send", invite.chat as string, "--id", "nightly", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--cron", "0 1 * * *",
      "--next", String(Date.now() + 3 * 3_600_000));
    await bot.run("usage", "send", invite.chat as string, "--label", "Claude", "--left", "62", "--window", "5 h", "--resets", new Date(Date.now() + 3 * 3_600_000).toISOString(), "--wait", "sent");
    const task = room.locator('[data-testid="status-card"][data-card-id="relay"]');
    const routine = room.locator('[data-testid="status-card"][data-card-id="nightly"]');
    const usage = room.locator('[data-testid="status-card"][data-kind="usage"]');
    await expect(task).toBeVisible({ timeout: 60_000 });
    await expect(routine).toBeVisible({ timeout: 60_000 });
    await expect(usage).toBeVisible({ timeout: 60_000 });
    const words = {
      taskTitle: task.getByTestId("status-card-title"),
      taskStatus: task.getByTestId("status-card-status"),
      routineName: routine.getByTestId("status-card-title"),
      routineSchedule: routine.getByTestId("status-card-schedule"),
      usageTitle: usage.getByTestId("status-card-title"),
      usageResets: usage.getByTestId("status-card-resets"),
    };
    expect(await sizes(words)).toEqual({ taskTitle: 13.5, taskStatus: 11.5, routineName: 13, routineSchedule: 11.5, usageTitle: 13.5, usageResets: 11.5 });

    await textSize(page, "huge");
    await page.setViewportSize(PHONE);
    await openChat(person);
    await expect(usage).toBeVisible();
    expect(await sizes(words)).toEqual({ taskTitle: 20.3, taskStatus: 17.3, routineName: 19.5, routineSchedule: 17.3, usageTitle: 20.3, usageResets: 17.3 });
    expect(await cut(page, [task, routine, usage])).toEqual([]);
    expect(await squeezed({ ...words, taskFoot: task.locator("> div").last(), routineLine: routine.getByTestId("status-card-schedule").locator(".."), usageFoot: usage.locator("> div").last() })).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("status-huge.png"), fullPage: true });
  } finally {
    await bot.stop();
  }
});
