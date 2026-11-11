import type { Locator, Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * Forced colors (Windows high contrast) replace every background with the page's. Controls drawn by a background
 * alone (a switch's track and knob, the chosen option of a row of choices, a filled button) must still be drawn there,
 * and nothing of it may show in normal colours.
 */

type Look = { bg: string; border: number; borderColor: string; color: string; around: string };

/**
 * An element's colours as seen: its background laid over every one behind it (forced colors keep a background's alpha,
 * so a transparent option and a filled one differ in value but look the same), and what it sits on (`around`).
 */
const look = (el: Locator): Promise<Look> => el.evaluate((node) => {
  type RGBA = [number, number, number, number];
  const rgba = (c: string): RGBA => { const n = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const seen = (from: Element | null): RGBA => {
    let c: RGBA = [0, 0, 0, 0];
    for (let n = from; n && c[3] < 1; n = n.parentElement) c = over(c, rgba(getComputedStyle(n).backgroundColor));
    return c[3] < 1 ? over(c, [255, 255, 255, 1]) : c;
  };
  const text = (c: RGBA) => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`;
  const style = getComputedStyle(node);
  const around = seen(node.parentElement);
  return { bg: text(seen(node)), border: parseFloat(style.borderTopWidth), borderColor: text(over(rgba(style.borderTopColor), around)), color: text(over(rgba(style.color), seen(node))), around: text(around) };
});

/**
 * No transition or animation between two reads: a colour read mid-way is neither state, and a box read while Home's
 * column still slides in (`animate-fade-in`, 4 px up, played again each time Home opens) is not where it stays.
 */
const still = (page: Page) => page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

test("forced colors keep Settings' switches, the chosen Mode and Chat list option and Home's New chat drawn", { tag: ["@feature:app.accessibility", "@feature:app.theme"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await still(page);
  const newChat = page.getByTestId("home-chat-actions").getByRole("button").first();
  await expect(newChat).toBeVisible();

  // Normal colours: no border appears on the filled button or the switches, and their sizes are what they were.
  const newChatBox = await newChat.boundingBox();
  expect((await look(newChat)).border, "New chat in normal colours").toBe(0);
  await page.goto("/#/settings");
  await still(page);
  await expect(page.getByTestId("settings-reduce-motion")).toBeVisible();
  const reduceMotion = page.getByTestId("settings-reduce-motion");
  const switchBox = await reduceMotion.boundingBox();
  const knobBox = await reduceMotion.locator("span").boundingBox();
  expect((await look(reduceMotion)).border, "a switch in normal colours").toBe(0);
  console.log(`normal colours: New chat ${JSON.stringify(newChatBox)}, switch ${JSON.stringify(switchBox)}, knob ${JSON.stringify(knobBox)}`);
  expect(switchBox).toMatchObject({ width: 48, height: 24 });
  expect(knobBox!.x - switchBox!.x).toBe(4);

  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });

  // Every switch: an outline that shows against what it sits on, and a knob that shows against its track.
  const switches = page.getByRole("switch");
  const count = await switches.count();
  expect(count).toBeGreaterThan(2);
  for (let i = 0; i < count; i++) {
    const track = switches.nth(i);
    if (!await track.isVisible()) continue;
    const name = `${await track.getAttribute("data-testid") ?? await track.getAttribute("aria-label")} (${await track.getAttribute("aria-checked")})`;
    const t = await look(track);
    const knob = await look(track.locator("span"));
    expect.soft(t.border, `${name}: track border`).toBeGreaterThanOrEqual(1);
    expect.soft(t.borderColor, `${name}: track border against the page`).not.toBe(t.around);
    expect.soft(knob.bg, `${name}: knob against its track`).not.toBe(t.bg);
  }
  // On and off differ by more than the knob's place: the same switch, read in both states.
  const off = { track: await look(reduceMotion), knob: await look(reduceMotion.locator("span")) };
  await expect(reduceMotion).toHaveAttribute("aria-checked", "false");
  await reduceMotion.click();
  await expect(reduceMotion).toHaveAttribute("aria-checked", "true");
  const on = { track: await look(reduceMotion), knob: await look(reduceMotion.locator("span")) };
  expect.soft(on.track.bg, "track on vs off").not.toBe(off.track.bg);
  expect.soft(on.knob.bg, "knob on vs off").not.toBe(off.knob.bg);
  await reduceMotion.click();
  await expect(reduceMotion).toHaveAttribute("aria-checked", "false");

  // Mode and Chat list: the chosen option looks unlike every other one.
  const groups = { mode: page.getByRole("group").filter({ has: page.getByRole("button", { name: "Light", exact: true }) }), chatList: page.getByTestId("chat-list-density") };
  for (const [name, group] of Object.entries(groups)) {
    const options = group.locator("button[aria-pressed]");
    const looks = await Promise.all((await options.all()).map(async (option) => ({ pressed: await option.getAttribute("aria-pressed") === "true", ...await look(option) })));
    const chosen = looks.filter((l) => l.pressed);
    expect(chosen, `${name}: one chosen option`).toHaveLength(1);
    for (const other of looks.filter((l) => !l.pressed)) {
      const same = other.bg === chosen[0].bg && other.color === chosen[0].color && other.border === chosen[0].border && other.borderColor === chosen[0].borderColor;
      expect.soft(same, `${name}: the chosen option ${JSON.stringify(chosen[0])} looks like another ${JSON.stringify(other)}`).toBe(false);
    }
  }

  // Home's New chat keeps an edge, as Join beside it does.
  await page.goto("/#/");
  await expect(newChat).toBeVisible();
  const button = await look(newChat);
  expect(button.border, "New chat border in forced colors").toBeGreaterThanOrEqual(1);
  expect(button.borderColor, "New chat border against the page").not.toBe(button.around);

  // Back in normal colours, New chat has its old size. Its place is not compared: Home centres its content, and what
  // shows above it after a visit to Settings can move it by a pixel or two.
  await page.emulateMedia({ forcedColors: "none", colorScheme: "dark" });
  const back = (await newChat.boundingBox())!;
  expect({ width: back.width, height: back.height }).toEqual({ width: newChatBox!.width, height: newChatBox!.height });
});

/**
 * The place you are on (`aria-current`): the chat list's open chat, Saved and Tasks above it, the account bar's page, the
 * rail's open chat and the phone's current tab. Their background and accent colour said it, and forced colors replace
 * both: one mark instead (index.css `current-mark`), a Highlight bar at the place's start side, under it where the
 * places sit in a row (the account bar, the phone's tab bar). Only in forced colors, and nothing moves.
 */
test.describe("forced colors mark the place you are on", () => {
  test.describe.configure({ timeout: 6 * 60_000 });

  type Side = "start" | "under";
  /** The bar a place's ::before draws (none: `shown` false), where it sits in the place, and what it is drawn on. */
  const bar = (el: Locator) => el.evaluate((node) => {
    const before = getComputedStyle(node, "::before");
    const box = node.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    return {
      shown: before.content !== "none" && before.content !== "normal" && before.display !== "none" && px(before.width) > 0 && px(before.height) > 0,
      color: before.backgroundColor, width: px(before.width), height: px(before.height),
      start: px(before.left), end: box.width - px(before.left) - px(before.width), bottom: box.height - px(before.top) - px(before.height),
    };
  });
  type Place = { look: Look; bar: Awaited<ReturnType<typeof bar>> };
  const place = async (el: Locator): Promise<Place> => ({ look: await look(el), bar: await bar(el) });

  /** `current` carries the bar on its `side`, in a colour that shows on what it is drawn on; `others` carry none. */
  async function differs(name: string, current: Locator, others: Locator[], side: Side) {
    await expect(current, `${name}: current`).toHaveAttribute("aria-current", "page");
    const now = await place(current);
    expect.soft(now.bar.shown, `${name}: the current place's bar ${JSON.stringify(now)}`).toBe(true);
    expect.soft(now.bar.color, `${name}: the bar against the place`).not.toBe(now.look.bg);
    if (side === "start") {
      expect.soft(now.bar.width, `${name}: the bar's thickness`).toBeGreaterThanOrEqual(3);
      expect.soft(now.bar.height, `${name}: the bar's length`).toBeGreaterThanOrEqual(12);
      expect.soft(now.bar.start, `${name}: the bar at the start side`).toBe(0);
    } else {
      expect.soft(now.bar.height, `${name}: the bar's thickness`).toBeGreaterThanOrEqual(3);
      expect.soft(now.bar.width, `${name}: the bar's length`).toBeGreaterThanOrEqual(12);
      expect.soft(now.bar.bottom, `${name}: the bar under the place`).toBe(0);
    }
    for (const other of others) {
      await expect(other).not.toHaveAttribute("aria-current", "page");
      const then = await place(other);
      expect.soft(then.bar.shown, `${name}: ${await other.getAttribute("data-testid")} is not current, and has no bar`).toBe(false);
      expect.soft(JSON.stringify(then), `${name}: the current place ${JSON.stringify(now)} looks like another`).not.toBe(JSON.stringify(now));
    }
  }

  test("the open chat, Saved and Tasks, the account bar's page, the rail's open chat and the phone's tab", { tag: ["@feature:app.accessibility", "@feature:app.theme", "@feature:chats.list.rail", "@feature:chat.saved", "@feature:chat.tasks-board"] }, async ({ peer, relay }) => {
    const bot = new HeadlessBot();
    try {
      await bot.start(await relay.listen(), "Mark Bot");
      const { page } = await peer("current-mark");
      await page.setViewportSize({ width: 1280, height: 800 });
      // A chat with a bot: a message of its kept in Saved, a task of its on the Tasks board.
      const invite = await bot.run("invite", "create", "--label", "person");
      await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
      await pasteInvite(page, invite.invite as string);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
      await bot.run("send", invite.chat as string, "Keep this one", "--wait", "delivered");
      await bot.run("task", "send", invite.chat as string, "--id", "release", "--title", "Ship the release", "--wait", "delivered");
      const message = page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "Keep this one" }).last();
      await message.hover();
      await message.getByTestId("message-options").click();
      await page.getByTestId("message-save").click();
      await still(page);

      const open = page.getByTestId("chat-row").filter({ hasText: "Mark Bot" }).getByTestId("chat-row-open");
      const saved = page.getByTestId("sidebar-saved"), tasks = page.getByTestId("sidebar-tasks");
      const settings = page.getByTestId("account-settings"), identities = page.getByTestId("account-identities");
      await expect(saved).toBeVisible();
      await expect(tasks).toBeVisible();

      // Normal colours: no bar, and the places' sizes to compare with forced colors'.
      await expect(open).toHaveAttribute("aria-current", "page");
      expect((await bar(open)).shown, "the open chat's bar in normal colours").toBe(false);
      const boxes = async () => Promise.all([open, saved, tasks, settings, identities].map(async (el) => {
        const b = (await el.boundingBox())!;
        return { width: b.width, height: b.height };
      }));
      const normal = await boxes();

      await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      expect(await boxes(), "nothing moves in forced colors").toEqual(normal);
      await differs("the chat list", open, [saved, tasks], "start");
      await saved.click();
      await differs("Saved", saved, [tasks, open], "start");
      await tasks.click();
      await differs("Tasks", tasks, [saved, open], "start");
      await settings.click();
      await differs("the account bar", settings, [identities, page.getByTestId("account-profile")], "under");
      await page.screenshot({ path: test.info().outputPath("forced-list.png") });

      // The rail: its open chat, and the account bar stacked under it.
      await page.getByTestId("chat-list-toggle").click();
      const rail = page.getByTestId("chat-rail");
      await expect(rail).toBeVisible();
      await rail.getByTestId("chat-rail-chat").first().click();
      await differs("the rail", rail.getByTestId("chat-rail-chat").first(), [page.getByTestId("rail-saved"), page.getByTestId("rail-tasks")], "start");
      await settings.click();
      await differs("the account bar on the rail", settings, [identities], "start");
      await page.screenshot({ path: test.info().outputPath("forced-rail.png") });
      await page.getByTestId("chat-list-toggle").click();
      await expect(page.getByTestId("chat-list")).toBeVisible();

      // The phone's tab bar: the bar under the current tab, and nothing moves.
      await page.emulateMedia({ forcedColors: "none", colorScheme: "dark" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/#/");
      const chats = page.getByTestId("mobile-tab-chats"), wallet = page.getByTestId("mobile-tab-wallet");
      await expect(chats).toHaveAttribute("aria-current", "page");
      expect((await bar(chats)).shown, "the current tab's bar in normal colours").toBe(false);
      const tabBox = await chats.boundingBox();
      await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
      expect(await chats.boundingBox(), "the tab does not move in forced colors").toEqual(tabBox);
      await differs("the phone's tab bar", chats, [wallet, page.getByTestId("mobile-tab-settings")], "under");
      await page.screenshot({ path: test.info().outputPath("forced-tabs.png") });
    } finally {
      await bot.stop();
    }
  });
});
