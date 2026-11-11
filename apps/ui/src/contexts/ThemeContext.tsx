import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import type { Theme, ColorScheme, ColorTheme } from "../lib/settings";
import { applyWindowTheme } from "../lib/windowTheme";

interface ThemeContextValue {
  effectiveScheme: "dark" | "light";
  colorScheme: ColorScheme;
  colorTheme: ColorTheme;
  // Legacy support
  effectiveTheme: "dark" | "light";
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Puts the theme on the page at once. Its colors are variables, so every element with a color transition (a chat row, a
 * button: hundreds, thousands with a long chat list) faded from the old theme's, restyled every frame until it ended.
 * The new colors are taken with transitions off (index.css `data-theme-switch`), then they are back.
 */
export function switchTheme(scheme: "dark" | "light", colorTheme: ColorTheme, root: HTMLElement = document.documentElement): void {
  if (root.getAttribute("data-theme") === scheme && root.getAttribute("data-color-theme") === colorTheme) {
    root.style.colorScheme = scheme;
    return;
  }
  root.setAttribute("data-theme-switch", "");
  root.setAttribute("data-theme", scheme);
  root.setAttribute("data-color-theme", colorTheme);
  root.style.colorScheme = scheme;
  // Reading a computed style makes the browser take the new colors now, while nothing transitions.
  void getComputedStyle(root).color;
  root.removeAttribute("data-theme-switch");
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(
    getSystemTheme
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  const effectiveScheme =
    settings.colorScheme === "system" ? systemTheme : settings.colorScheme;

  // Desktop's title bar takes the app's Light or Dark, not the system's; System gives it back to the system.
  useEffect(() => applyWindowTheme(settings.colorScheme), [settings.colorScheme]);

  // Before the page is drawn, with what changed it (a swatch pressed): the switch is one style change.
  useLayoutEffect(() => switchTheme(effectiveScheme, settings.colorTheme), [effectiveScheme, settings.colorTheme]);

  return (
    <ThemeContext.Provider
      value={{
        effectiveScheme,
        colorScheme: settings.colorScheme,
        colorTheme: settings.colorTheme,
        // Legacy support
        effectiveTheme: effectiveScheme,
        theme: settings.theme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
