import { expect, test } from "@playwright/test";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * The Mac menu bar is in the app's language. Desktop builds the menu in English before any page runs
 * (apps/desktop/src/app_window.rs); the page gives it its titles again in the language chosen in Settings, at its
 * start and each time the language changes (`set_menu_titles`, apps/ui/src/lib/appMenu.ts). The app's own menu keeps
 * the app's name. Until 2026-11-27 the whole menu bar stayed in English in the other seven languages.
 *
 * The test driver reads the titles the menu has (`GET /menu`); how the menu bar looks is checked by hand.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- menu-language
 */

// 49760-49764: this test's ports.
const PORTS = { app: 49760 };

const ENGLISH: [string, string[]][] = [
  ["Ghostly", ["About Ghostly", "Settings…", "Services", "Hide Ghostly", "Hide Others", "Show All", "Quit Ghostly"]],
  ["File", ["New Chat", "Close Window"]],
  ["Edit", ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]],
  ["View", ["Toggle Full Screen"]],
  ["Window", ["Minimize", "Zoom", "Close Window"]],
  ["Help", []],
];

const PORTUGUESE: [string, string[]][] = [
  ["Ghostly", ["Sobre o Ghostly", "Ajustes…", "Serviços", "Ocultar Ghostly", "Ocultar Outros", "Mostrar Tudo", "Encerrar Ghostly"]],
  ["Arquivo", ["Nova conversa", "Fechar Janela"]],
  ["Editar", ["Desfazer", "Refazer", "Cortar", "Copiar", "Colar", "Selecionar Tudo"]],
  ["Visualizar", ["Tela Cheia"]],
  ["Janela", ["Minimizar", "Zoom", "Fechar Janela"]],
  ["Ajuda", []],
];

/** Chooses a language in Settings → Appearance → Language, by its code. */
const choose = async (desktop: MacDesktop, language: string) => {
  await desktop.app.execute(`location.hash = "#/settings";`);
  await desktop.app.click('[data-testid="settings-language"]');
  await desktop.app.click(`[role="option"][data-value="${language}"]`);
  await expect.poll(() => desktop.app.execute<string>(`return document.documentElement.lang;`)).toMatch(new RegExp(`^${language}`));
};

/** The titles without the `&` a menu reads as the next letter's shortcut on other systems. */
const titles = async (desktop: MacDesktop) =>
  (await desktop.app.menuTitles()).map(([title, items]) => [title.replaceAll("&", ""), items.map((item) => item.replaceAll("&", ""))]);

let desktop: MacDesktop | undefined;
test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
});
test.afterAll(async () => {
  await desktop?.stop();
  forgetSharedData();
});

test("the menu bar is in the language chosen in Settings, and in it again after the app is opened again", {
  tag: ["@client:desktop", "@feature:desktop.window", "@feature:app.i18n"],
}, async () => {
  desktop = await openMacDesktop({ name: "menu-language", port: PORTS.app });
  await expect.poll(() => desktop!.app.text('[title="New chat"]'), { timeout: 90_000 }).not.toBeNull();
  // A new profile on a Mac in English.
  if ((await desktop.app.execute<string>(`return document.documentElement.lang;`)).startsWith("en")) {
    await expect.poll(() => titles(desktop!)).toEqual(ENGLISH);
  }

  await choose(desktop, "pt");
  await expect.poll(() => titles(desktop!)).toEqual(PORTUGUESE);
  // The menu's commands are the same ones, whatever they are called.
  expect(await desktop.app.menu("ghostly-settings")).toBe(true);

  await test.step("opened again, the menu is in the profile's language from the start", async () => {
    await desktop!.stop({ keep: true });
    desktop = await openMacDesktop({ name: "menu-language", port: PORTS.app, keepData: true });
    await expect.poll(() => titles(desktop!), { timeout: 90_000 }).toEqual(PORTUGUESE);
  });

  await choose(desktop, "en");
  await expect.poll(() => titles(desktop!)).toEqual(ENGLISH);
});
