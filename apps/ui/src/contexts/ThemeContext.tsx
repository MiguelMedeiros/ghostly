import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useSettings } from "./SettingsContext";
import type { Theme, ColorScheme, ColorTheme } from "../lib/settings";

interface ThemeContextValue {
  effectiveScheme: "dark" | "light";
  colorScheme: ColorScheme;
  colorTheme: ColorTheme;
  // Legacy support
  effectiveTheme: "dark" | "light";
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

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

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", effectiveScheme);
    root.setAttribute("data-color-theme", settings.colorTheme);
    root.style.colorScheme = effectiveScheme;
  }, [effectiveScheme, settings.colorTheme]);

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
