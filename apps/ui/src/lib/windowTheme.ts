import type { ColorScheme } from "./settings";

/**
 * The appearance the app's window takes around the page (Desktop's title bar), from the Light / Dark / System
 * choice in Settings rather than from the system's: Light and Dark set it, System (`null`) leaves it to the OS.
 */
export type WindowTheme = "light" | "dark" | null;

export function windowThemeFor(scheme: ColorScheme): WindowTheme {
  return scheme === "system" ? null : scheme;
}

let sink: ((theme: WindowTheme) => void) | null = null;

/** Where the window's appearance goes: set by the Desktop host before the app is drawn; nowhere in a browser. */
export function setWindowThemeSink(next: ((theme: WindowTheme) => void) | null): void {
  sink = next;
}

/** Gives the window the appearance `scheme` asks for, where the app has a window of its own. */
export function applyWindowTheme(scheme: ColorScheme): void {
  sink?.(windowThemeFor(scheme));
}
