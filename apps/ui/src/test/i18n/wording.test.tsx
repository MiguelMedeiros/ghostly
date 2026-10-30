import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { LANGUAGES, LOCALES, flatten, lookup } from "./locales";

// covers: app.i18n

/*
 * One word for one thing (2026-10-05): Settings is "Ajustes" in Portuguese on every bar and page, as the phone's tab
 * already said; New chat is in sentence case; the Wallet page is titled as its place, Wallets.
 */

describe("Portuguese says Ajustes for Settings", () => {
  it("on the account bar, the tab bar and the page", () => {
    for (const key of ["sidebar.settings", "tabs.settings", "settings.title"]) expect(lookup("pt", key), key).toBe("Ajustes");
  });

  it("everywhere it names the app's settings: only Windows' own app is Configurações", () => {
    const named = [...flatten(LOCALES.pt)].filter(([, value]) => typeof value === "string" && value.includes("Configurações") && !value.includes("Configurações do Windows"));
    expect(named.map(([key]) => key)).toEqual([]);
  });

  it("keeps Entrar for Join", () => {
    expect(lookup("pt", "sidebar.join")).toBe("Entrar");
  });
});

/*
 * Spanish, French and Italian too (2026-10-30): the phone's tab took the short word in #909 and the page, the account
 * bar and the hint to hold the tab kept the long one. The OS's own Settings apps keep their names.
 */
const settingsWords = [
  { language: "es", word: "Ajustes", long: "Configuración", os: [/Configuración de Windows/] },
  { language: "fr", word: "Réglages", long: "Paramètres", os: [/Paramètres Windows/] },
  { language: "it", word: "Opzioni", long: "Impostazioni", os: [/macOS|Windows|iOS|iPhone|Safari/] },
] as const;

describe.each(settingsWords)("$language says $word for Settings", ({ language, word, long, os }) => {
  it("on the account bar, the tab bar, the page and the hint to hold the tab", () => {
    for (const key of ["sidebar.settings", "tabs.settings", "settings.title"]) expect(lookup(language, key), key).toBe(word);
    expect(lookup(language, "profileSwitcher.holdHint")).toContain(word);
  });

  it(`everywhere it names the app's settings: only the OS's own app is ${long}`, () => {
    const named = [...flatten(LOCALES[language])].filter(([, value]) => typeof value === "string" && value.includes(long) && !os.some((name) => name.test(value)));
    expect(named.map(([key]) => key)).toEqual([]);
  });
});

describe("New chat is in sentence case", () => {
  it("in English, with no Title Case left", () => {
    const titled = [...flatten(LOCALES.en)].filter(([, value]) => typeof value === "string" && /\bNew Chat\b/.test(value));
    expect(titled.map(([key]) => key)).toEqual([]);
    expect(lookup("en", "sidebar.newChat")).toBe("New chat");
  });

  it.each(["pt", "es", "fr", "it"] as const)("in %s, as the button's other label", (language) => {
    expect(lookup(language, "sidebar.newChat")).toBe(lookup(language, "sidebar.startChat"));
  });
});

describe("the Wallet page", () => {
  it.each(LANGUAGES)("in %s is titled as its place in the bars, Wallets", async (language) => {
    const { engine } = renderApp(<Wallet />, { language });
    engine.update({ wallet: walletView({}) });
    await screen.findByTestId("wallet-first");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(lookup(language, "tabs.wallets")!);
  });
});
