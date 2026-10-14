import { test, expect } from "@playwright/test";
import { choose, type DesktopApp } from "../support/desktop";

/**
 * `choose` on a page that is not drawn yet. The menu's pages (Settings among them) load the first time they are opened,
 * and nothing is drawn in their place for that moment: a test that opens Settings and chooses a language at once met
 * no select and failed with "Nothing to click", on a machine where the page took longer than WebDriver's answer.
 *
 * No app here: the page is a stand-in that draws its select a moment after the first question about it, as the app
 * does while Settings loads.
 */
function pageDrawnLater(ms: number): { app: DesktopApp; clicks: string[] } {
  const select = '[data-testid="settings-language"]';
  const option = (value: string) => `[data-testid="settings-language-list"] [role="option"][data-value="${value}"]`;
  const clicks: string[] = [];
  let drawnAt: number | null = null;
  let open = false;
  let value = "en";
  const drawn = () => {
    drawnAt ??= Date.now() + ms;
    return Date.now() >= drawnAt;
  };
  const app = {
    attribute: async (selector: string, name: string) => {
      if (selector !== select || !drawn()) return null;
      return name === "aria-expanded" ? String(open) : name === "data-value" ? value : null;
    },
    text: async (selector: string) => drawn() && open && selector === option("ar") ? "العربية" : null,
    click: async (selector: string) => {
      const there = drawn() && (selector === select || (open && selector === option("ar")));
      if (!there) throw new Error(`Nothing to click at ${selector}`);
      clicks.push(selector);
      if (selector === select) open = true;
      else { value = "ar"; open = false; }
    },
  } as unknown as DesktopApp;
  return { app, clicks };
}

test("choosing in a select waits for the page that holds it to be drawn", { tag: ["@feature:app.i18n"] }, async () => {
  const { app, clicks } = pageDrawnLater(500);
  await choose(app, "settings-language", "ar");
  expect(clicks).toEqual(['[data-testid="settings-language"]', '[data-testid="settings-language-list"] [role="option"][data-value="ar"]']);
  expect(await app.attribute('[data-testid="settings-language"]', "data-value")).toBe("ar");
});
