// covers: app.i18n, app.theme
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followSettingsWhileWaiting } from "../../lib/otherTabSettings";
import { translatorFor } from "../../locales";
import { loadSettings } from "../../lib/settings";

/*
 * The web app runs a profile in one tab: another tab of it says "Ghostly is already open in another tab" until that one
 * closes. A change of language or theme in the open tab reaches the waiting one only as a storage event.
 */

const html = document.documentElement;
const KEY = "ghostly_app_settings";

/** What the open tab does: saves its settings, which the waiting tab hears as a storage event. */
function otherTabSaves(changes: object) {
  const value = JSON.stringify({ ...loadSettings(), ...changes });
  localStorage.setItem(KEY, value);
  dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: value, storageArea: localStorage }));
}

beforeEach(() => {
  localStorage.clear();
  html.lang = "en";
  html.dir = "ltr";
  html.setAttribute("data-theme", "dark");
  html.setAttribute("data-color-theme", "cyan");
});
afterEach(() => {
  localStorage.clear();
  html.removeAttribute("data-theme");
  html.removeAttribute("data-color-theme");
});

describe("the screen of a tab that waits behind the open one", () => {
  it("takes the language and theme the open tab chooses, and is drawn again in them", async () => {
    const redraw = vi.fn(() => translatorFor(loadSettings().language)("boot.otherTab"));
    const stop = followSettingsWhileWaiting(redraw);
    try {
      otherTabSaves({ language: "ar", colorScheme: "light", theme: "light", colorTheme: "purple" });
      expect([html.getAttribute("data-theme"), html.getAttribute("data-color-theme")]).toEqual(["light", "purple"]);
      await vi.waitFor(() => expect(redraw).toHaveBeenCalledOnce());
      expect([html.lang, html.dir]).toEqual(["ar", "rtl"]);
      expect(redraw.mock.results[0].value).toBe(translatorFor("ar")("boot.otherTab"));
      expect(redraw.mock.results[0].value).not.toBe(translatorFor("en")("boot.otherTab"));
    } finally {
      stop();
    }
  });

  it("follows nothing once the tab took the lock", async () => {
    const redraw = vi.fn();
    followSettingsWhileWaiting(redraw)();
    otherTabSaves({ language: "fr", colorScheme: "light", theme: "light" });
    await new Promise((settle) => setTimeout(settle, 50));
    expect(redraw).not.toHaveBeenCalled();
    expect([html.lang, html.getAttribute("data-theme")]).toEqual(["en", "dark"]);
  });
});
