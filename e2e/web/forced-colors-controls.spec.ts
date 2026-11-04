import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

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
