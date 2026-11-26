import { switchTheme, syncThemeColor } from "../contexts/ThemeContext";
import { loadLocale } from "../locales";
import { applyDocumentLanguage } from "./documentLanguage";
import { isSettingsStorageEvent, loadSettings } from "./settings";

/**
 * A tab that waits while the profile runs in another one ("already open in another tab") draws no app, so nothing in
 * it follows the settings: the open tab's change of language or theme lands here as a storage event. Each one puts the
 * profile's language (`<html lang>`, `dir`, its words once loaded) and theme on the page, then `redraw`s the screen.
 * Returns what stops it: this tab took the lock.
 */
export function followSettingsWhileWaiting(redraw: () => void): () => void {
  let stopped = false;
  const stored = (event: StorageEvent) => {
    if (!isSettingsStorageEvent(event)) return;
    const { language, colorScheme, colorTheme } = loadSettings();
    const scheme = colorScheme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : colorScheme;
    switchTheme(scheme, colorTheme);
    syncThemeColor();
    void loadLocale(language).then(() => {
      // A later change (or the lock) came while its words loaded: that one draws.
      if (stopped || loadSettings().language !== language) return;
      applyDocumentLanguage(language);
      redraw();
    });
  };
  addEventListener("storage", stored);
  return () => {
    stopped = true;
    removeEventListener("storage", stored);
  };
}
