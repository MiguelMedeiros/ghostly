import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSettings } from "../../lib/settings";
import { searchSettings } from "../../lib/settingsSections";
import { downloadedLanguages, translateOffered } from "../../lib/translateSettings";
import { translateWith } from "../../locales/translate";
import { Settings } from "../../pages/Settings";
import { LOCALES as locales } from "../i18n/locales";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import type { Language } from "../../lib/settings";

/*
 * Settings → Appearance → Translate messages: off for every profile until turned on, the default for chats that have
 * not chosen, and the languages downloaded on this computer with their sizes and Remove. Only a `VITE_TRANSLATE` build
 * of the Desktop app shows any of it.
 */

const models = vi.hoisted(() => ({
  translationStatus: vi.fn(async (): Promise<{ pairs: { pair: string; bytes: number }[] }> => ({ pairs: [] })),
  removeTranslationPair: vi.fn(async (_pair: string): Promise<void> => {}),
}));
vi.mock("../../desktop/translateStatus", () => models);
// The UI tests alias every `@tauri-apps/api/*` to one stand-in: the rest of Settings asks Desktop's commands nothing useful.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), listen: async () => () => {}, getVersion: async () => "0.4.0" }));

const MB = 1024 * 1024;
const desktop = () => { (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {}; };
const t = (language: Language) => translateWith(locales[language], language);

const renderSettings = (language?: Language) => renderApp(
  <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
  { route: "/settings/appearance", language },
);

beforeEach(() => { windowIs(false); });
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  models.translationStatus.mockReset().mockResolvedValue({ pairs: [] });
  models.removeTranslationPair.mockReset().mockResolvedValue(undefined);
});

describe("the translateMessages setting", () => {
  it("is off for a new profile and for settings saved before it, and on only when turned on", () => {
    expect(loadSettings().translateMessages).toBe(false);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "pt", linkPreviews: true }));
    expect(loadSettings().translateMessages).toBe(false);
    for (const odd of ["yes", 1, "true", null]) {
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ translateMessages: odd }));
      expect(loadSettings().translateMessages, String(odd)).toBe(false);
    }
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ translateMessages: true }));
    expect(loadSettings().translateMessages).toBe(true);
  });
});

describe("where it shows", () => {
  it("only in a VITE_TRANSLATE build of the Desktop app: not on the web, not on Android", () => {
    desktop();
    expect(translateOffered("Linux x86_64")).toBe(false);
    vi.stubEnv("VITE_TRANSLATE", "1");
    expect(translateOffered("Mozilla/5.0 (X11; Linux x86_64)")).toBe(true);
    expect(translateOffered("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    expect(translateOffered("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });

  it("a build without the flag has no row and asks Desktop nothing about models", async () => {
    desktop();
    renderSettings();
    expect(await screen.findByTestId("settings-language")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-translate-row")).not.toBeInTheDocument();
    expect(models.translationStatus).not.toHaveBeenCalled();
  });

  it("the web app with the flag has no row either", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    renderSettings();
    expect(await screen.findByTestId("settings-language")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-translate-row")).not.toBeInTheDocument();
    expect(models.translationStatus).not.toHaveBeenCalled();
  });

  it("the search finds it only where it shows, in the language shown", () => {
    const found = (language: Language, query: string, offered: boolean) =>
      searchSettings(query, t(language), (needs) => needs !== "translate" || offered).map((entry) => entry.label);
    expect(found("en", "translate messages", true)).toEqual(["settings.translate.name"]);
    expect(found("en", "translate messages", false)).toEqual([]);
    expect(found("pt", "traduzir mensagens", true)).toEqual(["settings.translate.name"]);
    expect(found("en", "language models", true)).toEqual(["settings.translate.name"]);
  });
});

describe("the switch, on Desktop with the flag", () => {
  beforeEach(() => { desktop(); vi.stubEnv("VITE_TRANSLATE", "1"); });

  it("sits right under Language, off, named after the app's language; turning it on is kept", async () => {
    const { user } = renderSettings();
    const row = await screen.findByTestId("settings-translate-row");
    expect(row).toHaveTextContent("Translate messages into English");
    expect(row).toHaveTextContent("The default for chats that have not chosen");
    expect(row.previousElementSibling).toContainElement(screen.getByTestId("settings-language"));
    const toggle = within(row).getByTestId("settings-translate");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(loadSettings().translateMessages).toBe(true));
    await user.click(toggle);
    await waitFor(() => expect(loadSettings().translateMessages).toBe(false));
  });

  it("in each language the row names that language", async () => {
    const titles: Partial<Record<Language, string>> = { pt: "Traduzir mensagens para português", ja: "メッセージを日本語に翻訳", ar: "ترجمة الرسائل إلى العربية" };
    for (const [language, title] of Object.entries(titles) as [Language, string][]) {
      const { unmount } = renderSettings(language);
      expect(await screen.findByTestId("settings-translate-row"), language).toHaveTextContent(title);
      unmount();
      localStorage.clear();
    }
  });

  it("lists the downloaded languages with their sizes, whether the switch is on or off", async () => {
    models.translationStatus.mockResolvedValue({ pairs: [{ pair: "pt-en", bytes: 37 * MB }, { pair: "ja-en", bytes: 54.8 * MB }] });
    renderSettings();
    const lines = await screen.findAllByTestId("settings-translate-pair");
    expect(lines.map((line) => line.textContent)).toEqual([expect.stringContaining("Japanese → English"), expect.stringContaining("Portuguese → English")]);
    expect(lines[0]).toHaveTextContent("54.8 MB");
    expect(lines[1]).toHaveTextContent("37 MB");
    expect(screen.queryByTestId("settings-translate-none")).not.toBeInTheDocument();
  });

  it("with nothing downloaded: says so while the switch is on, and nothing while it is off", async () => {
    const { user } = renderSettings();
    await screen.findByTestId("settings-translate-row");
    await waitFor(() => expect(models.translationStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-translate-none")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("settings-translate"));
    expect(await screen.findByTestId("settings-translate-none")).toHaveTextContent("No languages downloaded");
    expect(screen.queryByTestId("settings-translate-pair")).not.toBeInTheDocument();
  });

  it("Remove deletes that pair and the list reads the computer again", async () => {
    models.translationStatus.mockResolvedValueOnce({ pairs: [{ pair: "pt-en", bytes: 37 * MB }, { pair: "en-pt", bytes: 36.4 * MB }] })
      .mockResolvedValue({ pairs: [{ pair: "en-pt", bytes: 36.4 * MB }] });
    const { user } = renderSettings();
    const portuguese = (await screen.findAllByTestId("settings-translate-pair")).find((line) => line.textContent?.includes("Portuguese → English"))!;
    await user.click(within(portuguese).getByRole("button", { name: "Remove Portuguese → English" }));
    expect(models.removeTranslationPair).toHaveBeenCalledWith("pt-en");
    await waitFor(() => expect(screen.getAllByTestId("settings-translate-pair")).toHaveLength(1));
    expect(screen.getByTestId("settings-translate-pair")).toHaveTextContent("English → Portuguese");
  });

  it("a Remove that fails keeps the line and says what to do; the error's own words are behind the ⓘ", async () => {
    models.translationStatus.mockResolvedValue({ pairs: [{ pair: "pt-en", bytes: 37 * MB }] });
    models.removeTranslationPair.mockRejectedValue(new Error("Permission denied (os error 13)"));
    const { user } = renderSettings();
    const line = await screen.findByTestId("settings-translate-pair");
    await user.click(within(line).getByRole("button", { name: "Remove Portuguese → English" }));
    expect(await within(line).findByText("Could not remove it. Try again.")).toBeInTheDocument();
    expect(line).not.toHaveTextContent("Permission denied");
    await user.click(within(line).getByRole("button", { name: /more|info|details/i }));
    expect(await screen.findByText(/Permission denied \(os error 13\)/)).toBeInTheDocument();
    expect(screen.getByTestId("settings-translate-pair")).toBeInTheDocument();
  });

  it("a list that cannot be read says so, with Try again", async () => {
    models.translationStatus.mockRejectedValueOnce(new Error("Not available on this platform")).mockResolvedValue({ pairs: [{ pair: "pt-en", bytes: 37 * MB }] });
    const { user } = renderSettings();
    const failed = await screen.findByTestId("settings-translate-unread");
    expect(failed).toHaveTextContent("Could not read the downloaded languages.");
    expect(failed).not.toHaveTextContent("Not available on this platform");
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("settings-translate-pair")).toHaveTextContent("Portuguese → English");
  });
});

describe("downloaded languages, as listed", () => {
  it("are named in the app's language, sorted by those names, a line starting with a capital", () => {
    const pairs = [{ pair: "pt-en", bytes: 37 * MB }, { pair: "en-pt", bytes: 36.4 * MB }, { pair: "es-en", bytes: 37 * MB }];
    expect(downloadedLanguages(pairs, t("en")).map((line) => [line.pair, line.label, line.size])).toEqual([
      ["en-pt", "English → Portuguese", "36.4 MB"],
      ["pt-en", "Portuguese → English", "37 MB"],
      ["es-en", "Spanish → English", "37 MB"],
    ]);
    expect(downloadedLanguages(pairs, t("pt")).map((line) => line.label)).toEqual(["Espanhol → inglês", "Inglês → português", "Português → inglês"]);
    expect(downloadedLanguages(pairs, t("fr"))[0].size).toBe("36,4 Mo");
  });

  it("leave out what is not a pair", () => {
    const odd = ["pt", "pt-pt", "PT-EN", "pt-en-x", "../en", "", "pt_en"].map((pair) => ({ pair, bytes: MB }));
    expect(downloadedLanguages([...odd, { pair: "de-en", bytes: MB }], t("en")).map((line) => line.pair)).toEqual(["de-en"]);
  });
});
