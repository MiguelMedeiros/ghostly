import { createLink } from "@ghostly/core";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The fields people type into show where the keyboard focus is: a ring around the chat list's search, the composer and
 * a chat's search, 3:1 or more against the colours on both of its sides (WCAG 2.4.11 and 1.4.11), in every colour theme,
 * light and dark. Before, each had `outline: none` and no ring: only the caret said where the focus was.
 */

const THEMES = ["classic", "cyan", "purple", "monochrome"] as const;

/** A chat with a few messages, opened: its composer and its search. */
async function seedChat(page: Page) {
  const mine = createLink().mine;
  await page.evaluate((mine) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 3_600_000;
    const messages = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, sender: i % 2 ? "peer" : "me", timestamp: start + i * 60_000, delivery: "delivered", text: `Message ${i}` }));
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    localStorage.setItem(`ghostly_join_${id}`, "true");
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, mine);
}

/** The colour theme and light or dark as Settings keeps them, the app reloaded in them. */
async function look(page: Page, colorTheme: string, scheme: "light" | "dark") {
  await page.evaluate(([colorTheme, scheme]) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, colorTheme, colorScheme: scheme, theme: scheme }));
  }, [colorTheme, scheme]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", colorTheme);
}

/**
 * The outline on `ring` (the field, or the shape around it): the lower of its contrasts with the background inside it
 * and the one outside it (WCAG's formula). 0 with no outline of 2 px or more.
 */
const ringContrast = (ring: Locator) => ring.evaluate((el) => {
  const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
  const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const background = (from: Element | null) => {
    for (let at = from; at; at = at.parentElement) {
      const c = rgb(getComputedStyle(at).backgroundColor);
      if (c.length < 4 || c[3] > 0) return c;
    }
    return rgb(getComputedStyle(document.body).backgroundColor);
  };
  const style = getComputedStyle(el);
  if (style.outlineStyle === "none" || parseFloat(style.outlineWidth) < 2) return 0;
  const ring = lum(rgb(style.outlineColor));
  const ratio = (other: number) => (Math.max(ring, other) + 0.05) / (Math.min(ring, other) + 0.05);
  return Math.min(ratio(lum(background(el))), ratio(lum(background(el.parentElement))));
});

test("the chat list's search, the composer and a chat's search show a ring with the focus, 3:1 or more in every theme", { tag: ["@feature:app.keyboard", "@feature:app.theme", "@feature:chat.search"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const alice = await peer("ring-alice", { viewport: { width: 1280, height: 900 } });
  const { page } = alice;
  await seedChat(page);
  await expect(page.getByText("Message 4", { exact: true })).toBeVisible();

  const search = page.getByTestId("sidebar-search"), composer = page.getByPlaceholder("Message…"), find = page.getByTestId("chat-search-input");
  const fields: [string, Locator, Locator][] = [
    ["the chat list's search", search, search.locator("xpath=..")],
    ["the composer", composer, page.locator(".composer-field")],
    ["a chat's search", find, find],
  ];
  for (const theme of THEMES) {
    for (const scheme of ["light", "dark"] as const) {
      await look(page, theme, scheme);
      await expect(composer).toBeVisible();
      for (const [name, field, ring] of fields) {
        if (field === find) {
          await composer.focus();
          await page.keyboard.press("ControlOrMeta+f");
        }
        else await field.focus();
        await expect(field).toBeFocused();
        expect(await ringContrast(ring), `${name}, ${theme} ${scheme}`).toBeGreaterThanOrEqual(3);
        if (field === find) {
          await page.keyboard.press("Escape");
          await expect(find).toBeHidden();
          continue;
        }
        // Without the focus, no ring.
        await page.keyboard.press("Tab");
        await expect(field).not.toBeFocused();
        expect(await ringContrast(ring), `${name} without the focus, ${theme} ${scheme}`).toBe(0);
      }
    }
  }
});
