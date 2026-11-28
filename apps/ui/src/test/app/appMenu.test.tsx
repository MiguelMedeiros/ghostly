import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../../contexts/SettingsContext";
import { APP_MENU_KEYS, appMenuTitles, setAppMenuSink, type AppMenuTitles } from "../../lib/appMenu";
import type { Language } from "../../lib/settings";
import { loadLocale, translatorFor } from "../../locales";
import { englishT } from "../../locales/translate";
import { renderApp } from "../render";

// covers: desktop.window, app.i18n

/*
 * The Mac menu bar is in the app's language: Desktop builds it in English before any page runs, and the page gives
 * it its titles again in its own language, at its start and each time the language changes (lib/appMenu.ts).
 */

afterEach(() => setAppMenuSink(null));

const LANGUAGES: Language[] = ["en", "pt", "es", "fr", "it", "zh", "ja", "ar"];

describe("the menu bar's titles", () => {
  it("are the ones the menu was built with, in English", () => {
    expect(appMenuTitles(englishT)).toEqual({
      about: "About Ghostly", closeWindow: "Close Window", copy: "Copy", cut: "Cut", edit: "Edit", file: "File",
      fullScreen: "Toggle Full Screen", help: "Help", hide: "Hide Ghostly", hideOthers: "Hide Others", minimize: "Minimize",
      newChat: "New Chat", paste: "Paste", quit: "Quit Ghostly", redo: "Redo", selectAll: "Select All", services: "Services",
      settings: "Settings…", showAll: "Show All", undo: "Undo", view: "View", window: "Window", zoom: "Zoom",
    });
  });

  it("are written in every language, each one a title a menu can show", async () => {
    for (const language of LANGUAGES) {
      await loadLocale(language);
      const titles = appMenuTitles(translatorFor(language));
      expect(Object.keys(titles).sort(), language).toEqual([...APP_MENU_KEYS].sort());
      for (const key of APP_MENU_KEYS) {
        // Never the key itself (a missing string), the app's name filled in, one line, and short enough for Rust (60).
        expect(titles[key], `${language} ${key}`).not.toContain("app.menu");
        expect(titles[key], `${language} ${key}`).not.toMatch(/[{}\n&]/);
        expect([...titles[key]].length, `${language} ${key}`).toBeGreaterThan(0);
        expect([...titles[key]].length, `${language} ${key}`).toBeLessThanOrEqual(60);
      }
      // Settings and New chat are called what the app calls them.
      const t = translatorFor(language);
      expect(titles.settings, language).toBe(`${t("sidebar.settings")}…`);
      if (language !== "en") expect(titles.newChat, language).toBe(t("sidebar.newChat"));
      // Translated: only a word that is the same in both languages stays.
      if (language !== "en") expect(titles.edit === "Edit" || titles.quit === "Quit Ghostly" || titles.window === "Window", language).toBe(false);
    }
  });

  it("go to the menu when the app starts and each time the language changes, and nowhere without a menu", async () => {
    await loadLocale("pt");
    const sink = vi.fn<(titles: AppMenuTitles) => void>();
    setAppMenuSink(sink);
    let choose: (language: Language) => void = () => {};
    function Chooser() {
      choose = useSettings().updateLanguage;
      return null;
    }
    renderApp(<Chooser />);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ file: "File", settings: "Settings…", quit: "Quit Ghostly" });

    await act(async () => { choose("pt"); await Promise.resolve(); });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
    expect(sink.mock.calls[1][0]).toMatchObject({ file: "Arquivo", settings: "Ajustes…", newChat: "Nova conversa", quit: "Encerrar Ghostly", about: "Sobre o Ghostly" });

    setAppMenuSink(null);
    await act(async () => { choose("en"); await Promise.resolve(); });
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
