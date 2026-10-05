import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../../contexts/SettingsContext";
import { useI18n } from "../../contexts/I18nContext";
import { browserLanguage, loadSettings } from "../../lib/settings";
import { renderApp } from "../render";

// covers: app.i18n

/** The browser's languages, as `navigator.languages` gives them. */
const browserSpeaks = (...languages: string[]) => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  vi.spyOn(navigator, "language", "get").mockReturnValue(languages[0] ?? "");
};

function Title() {
  const { t } = useI18n();
  const { updateLanguage } = useSettings();
  return <><h1>{t("settings.title")}</h1><button onClick={() => updateLanguage("en")}>English</button></>;
}

afterEach(() => vi.restoreAllMocks());

describe("a new profile's language", () => {
  it("is the first of the browser's languages the app speaks", () => {
    expect(browserLanguage(["pt-BR", "en-US"])).toBe("pt");
    expect(browserLanguage(["de-DE", "fr-CA", "en"])).toBe("fr");
    expect(browserLanguage(["zh-TW"])).toBe("zh");
    expect(browserLanguage(["ja"])).toBe("ja");
    expect(browserLanguage(["ar-EG"])).toBe("ar");
  });

  it("is English when the browser speaks none of the app's languages", () => {
    expect(browserLanguage(["de-DE", "nl"])).toBe("en");
    expect(browserLanguage([])).toBe("en");
  });

  it("opens the app in the browser's language on the first run, and keeps it as the setting", () => {
    browserSpeaks("pt-BR", "en");
    renderApp(<Title />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Configurações");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).language).toBe("pt");
  });

  it("the language setting still wins, whatever the browser speaks", async () => {
    browserSpeaks("fr-FR");
    const { user, unmount } = renderApp(<Title />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Paramètres");
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
    unmount();
    // A reload: the profile keeps its own language.
    expect(loadSettings().language).toBe("en");
    renderApp(<Title />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
  });

  it("a profile that already has settings is not moved to the browser's language", () => {
    browserSpeaks("es-ES");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "ja" }));
    expect(loadSettings().language).toBe("ja");
    // Settings from before the language was saved read as English, as they did.
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ colorScheme: "light" }));
    expect(loadSettings().language).toBe("en");
  });
});
