import { describe, expect, it, vi } from "vitest";

/**
 * The first screen (the chat list) loads only what it draws: the profile's language, not all eight, and the pages of
 * the menu once one is opened.
 */
const { evaluated, page } = vi.hoisted(() => {
  const evaluated: string[] = [];
  return { evaluated, page: (name: string) => () => { evaluated.push(name); return { [name]: () => null }; } };
});
vi.mock("../../pages/Settings", page("Settings"));
vi.mock("../../pages/Services", page("Services"));
vi.mock("../../pages/Profile", page("Profile"));
vi.mock("../../pages/Identities", page("Identities"));
vi.mock("../../pages/Apps", page("Apps"));
vi.mock("../../pages/Tasks", page("Tasks"));
vi.mock("../../pages/Wallet", page("Wallet"));

describe("the first screen", () => {
  it("holds English only, and a language once it is loaded", async () => {
    // A fresh copy of the module: the test setup loads every language into the shared one.
    vi.resetModules();
    const { loadLocale, loadedLocale } = await import("../../locales");
    expect(loadedLocale("en")?.common.close).toBe("Close");
    expect(loadedLocale("pt")).toBeUndefined();
    expect(loadedLocale("ja")).toBeUndefined();
    await loadLocale("pt");
    expect(loadedLocale("pt")?.common.close).toBe("Fechar");
    expect(loadedLocale("ja")).toBeUndefined();
  });

  it("does not load the menu's pages with the app", async () => {
    vi.resetModules();
    await import("../../Root");
    expect(evaluated).toEqual([]);
  });
});
