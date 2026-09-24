import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSettings } from "../../contexts/SettingsContext";
import { useI18n } from "../../contexts/I18nContext";
import { applyDocumentLanguage, languageTag, textDirection } from "../../lib/documentLanguage";
import type { Language } from "../../lib/settings";
import { renderApp } from "../render";
import { LANGUAGES } from "./locales";

// covers: app.i18n

const html = document.documentElement;

/** Stands in for the Settings page's language select. */
function LanguageSwitch() {
  const { updateLanguage } = useSettings();
  const { t } = useI18n();
  return (
    <>
      <h1>{t("settings.title")}</h1>
      {LANGUAGES.map((language) => (
        <button key={language} onClick={() => updateLanguage(language)}>{language}</button>
      ))}
    </>
  );
}

describe("<html lang> and <html dir>", () => {
  it("every shipped locale has a BCP 47 tag of its own", () => {
    const tags = LANGUAGES.map(languageTag);
    expect(new Set(tags).size).toBe(LANGUAGES.length);
    for (const tag of tags) expect(Intl.getCanonicalLocales(tag)).toEqual([tag]);
    expect(languageTag("pt")).toBe("pt-BR");
  });

  it("Arabic reads right to left, the rest left to right", () => {
    expect(LANGUAGES.filter((l) => textDirection(l) === "rtl")).toEqual(["ar"]);
  });

  it("a language the app does not know reads as English", () => {
    applyDocumentLanguage("de" as Language);
    expect(html.lang).toBe("en");
    expect(html.dir).toBe("ltr");
  });

  it("follows the stored language from the first render", () => {
    renderApp(<LanguageSwitch />, { language: "ar" });
    expect(html.lang).toBe("ar");
    expect(html.dir).toBe("rtl");
  });

  it("changes with the language, and back", async () => {
    const { user } = renderApp(<LanguageSwitch />);
    expect(html.lang).toBe("en");
    expect(html.dir).toBe("ltr");

    await user.click(screen.getByRole("button", { name: "ar" }));
    expect(html.lang).toBe("ar");
    expect(html.dir).toBe("rtl");

    await user.click(screen.getByRole("button", { name: "pt" }));
    expect(html.lang).toBe("pt-BR");
    expect(html.dir).toBe("ltr");
    expect(screen.getByRole("heading", { name: "Configurações" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "zh" }));
    expect(html.lang).toBe("zh-CN");
  });
});
