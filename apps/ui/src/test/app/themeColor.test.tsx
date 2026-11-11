import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { useSettings } from "../../contexts/SettingsContext";
import type { ColorScheme } from "../../lib/settings";
import { renderApp } from "../render";

// covers: app.theme

/*
 * The browser's bar (`<meta name="theme-color">`) takes the active theme's header colour wherever the theme is put on
 * the page, App or not: the lock screen and a standby device's screen show no App, and System follows the OS there too.
 */

const themeColor = () => document.head.querySelector('meta[name="theme-color"]')!.getAttribute("content");

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#202c33">'
    + '<style>[data-theme="dark"] { --theme-panel-header: #0c1929; } [data-theme="light"] { --theme-panel-header: #ecfeff; }</style>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-color-theme");
});

describe("the browser's bar colour", () => {
  it("follows the theme with nothing of App mounted", () => {
    let choose: (scheme: ColorScheme) => void = () => {};
    function Chooser() {
      choose = useSettings().updateColorScheme;
      return null;
    }
    renderApp(<ThemeProvider><Chooser /></ThemeProvider>);
    // A new profile's default is Dark.
    expect(themeColor()).toBe("#0c1929");
    act(() => choose("light"));
    expect(themeColor()).toBe("#ecfeff");
    act(() => choose("dark"));
    expect(themeColor()).toBe("#0c1929");
  });

  it("follows the OS's dark mode for System, with nothing of App mounted", () => {
    let osDark = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() { return osDark; },
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    }));
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ colorScheme: "system" }));
    renderApp(<ThemeProvider>{null}</ThemeProvider>);
    expect(themeColor()).toBe("#0c1929");
    osDark = false;
    act(() => { for (const listener of listeners) listener({ matches: false } as MediaQueryListEvent); });
    expect(themeColor()).toBe("#ecfeff");
  });
});
