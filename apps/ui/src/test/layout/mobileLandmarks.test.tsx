import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import type { Language } from "../../lib/settings";
import { Settings } from "../../pages/Settings";
import { lookup } from "../i18n/locales";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: app.accessibility, app.mobile-layout

/**
 * On a phone the chat list is a navigation landmark ("Chats"), Settings' menu is one ("Settings"), and so is the tab
 * bar at the bottom. The tab bar had no name, so a screen reader's landmark list read it as a bare "navigation" beside
 * the named ones. Every navigation landmark on a phone screen has a name of its own, in English and in Arabic.
 */
function renderPhone(route: string, language: Language) {
  windowIs(true);
  return renderApp(
    <LockScreenProvider><UpdateProvider>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<p>Home</p>} />
          <Route path="/settings/:section?" element={<Settings />} />
        </Route>
      </Routes>
    </UpdateProvider></LockScreenProvider>,
    { route, language },
  );
}

/** A landmark's name as a screen reader reads it: what `aria-labelledby` points to, else `aria-label`. */
function nameOf(el: HTMLElement): string {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  return el.getAttribute("aria-label")?.trim() ?? "";
}

const navNames = () => screen.getAllByRole("navigation").map(nameOf);

afterEach(() => vi.restoreAllMocks());

describe("the navigation landmarks of a phone screen", () => {
  for (const language of ["en", "ar"] as const) {
    it(`each has a name, none shared, the tab bar's its own (${language})`, async () => {
      renderPhone("/", language);
      const bar = await screen.findByTestId("mobile-tabs");
      const names = navNames();
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(names.filter((name) => !name.trim()), JSON.stringify(names)).toEqual([]);
      expect(new Set(names).size, JSON.stringify(names)).toBe(names.length);
      expect(nameOf(bar)).toBe(lookup(language, "tabs.bar"));
      expect(screen.getByTestId("mobile-tab-chats")).toHaveAttribute("aria-current", "page");
    });

    it(`on Settings too, where its menu is a third one, the tab bar marking Settings (${language})`, async () => {
      renderPhone("/settings", language);
      await screen.findByTestId("settings-menu");
      const names = navNames();
      expect(names.filter((name) => !name.trim()), JSON.stringify(names)).toEqual([]);
      expect(new Set(names).size, JSON.stringify(names)).toBe(names.length);
      expect(names).toContain(lookup(language, "settings.title"));
      expect(names).toContain(lookup(language, "tabs.bar"));
      await waitFor(() => expect(screen.getByTestId("mobile-tab-settings")).toHaveAttribute("aria-current", "page"));
      expect(screen.getByTestId("mobile-tab-chats")).not.toHaveAttribute("aria-current");
    });
  }
});
