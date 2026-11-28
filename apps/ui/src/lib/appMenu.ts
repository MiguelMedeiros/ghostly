import type { Translate } from "../locales/translate";

/**
 * The Mac menu bar in the app's language. Desktop builds its menu before any page runs, in English
 * (apps/desktop/src/app_window.rs), so the page says the titles again in its own language: when it starts and each time
 * the language changes. The keys are the ones Rust knows (`TITLES` there); the app's own menu keeps the app's name.
 */
export type AppMenuTitles = Record<AppMenuKey, string>;

export const APP_MENU_KEYS = [
  "about", "closeWindow", "copy", "cut", "edit", "file", "fullScreen", "help", "hide", "hideOthers", "minimize", "newChat",
  "paste", "quit", "redo", "selectAll", "services", "settings", "showAll", "undo", "view", "window", "zoom",
] as const;

export type AppMenuKey = (typeof APP_MENU_KEYS)[number];

/** Every title of the menu in the language of `t`. */
export function appMenuTitles(t: Translate): AppMenuTitles {
  const app = t("app.name");
  return Object.fromEntries(APP_MENU_KEYS.map((key) => [key, t(`app.menu.${key}`, { app })])) as AppMenuTitles;
}

let sink: ((titles: AppMenuTitles) => void) | null = null;

/** Where the titles go: set by the Desktop host before the app is drawn; nowhere in a browser. */
export function setAppMenuSink(next: ((titles: AppMenuTitles) => void) | null): void {
  sink = next;
}

/** Gives the menu bar its titles in the language of `t`, where the app has one. */
export function applyAppMenu(t: Translate): void {
  sink?.(appMenuTitles(t));
}
