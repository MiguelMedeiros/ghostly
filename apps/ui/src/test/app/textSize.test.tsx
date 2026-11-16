import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createProfile, settingsKeyFor } from "../../lib/profiles";
import { loadSettings, type Language } from "../../lib/settings";
import { searchSettings } from "../../lib/settingsSections";
import { TEXT_SCALE, TEXT_SIZES } from "../../lib/textSize";
import { translateWith } from "../../locales/translate";
import { Settings } from "../../pages/Settings";
import { LOCALES as locales } from "../i18n/locales";
import { renderApp } from "../render";

// covers: settings.text-size

const scale = () => document.documentElement.style.getPropertyValue("--chat-text-scale");
const stored = () => JSON.parse(localStorage.getItem("ghostly_app_settings")!).textSize;
const settingsPage = () => renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);

describe("Settings → Text size", () => {
  it("has five steps, from 90% to 150%, the default at 100%", () => {
    expect(TEXT_SIZES.map((size) => TEXT_SCALE[size])).toEqual([0.9, 1, 1.15, 1.3, 1.5]);
    expect(loadSettings().textSize).toBe("default");
  });

  it("is kept, and set on the page as the variable the chat's text sizes are multiplied by", () => {
    const page = settingsPage();
    const slider = screen.getByTestId("settings-text-size");
    expect(slider).toHaveAccessibleName("Text size");
    expect(slider).toHaveAttribute("aria-valuetext", "Default");
    expect(scale()).toBe("1");

    fireEvent.change(slider, { target: { value: "4" } });
    expect(slider).toHaveAttribute("aria-valuetext", "Huge");
    expect(screen.getByTestId("settings-text-size-value")).toHaveTextContent("Huge");
    expect(stored()).toBe("huge");
    expect(scale()).toBe("1.5");
    // The preview draws its messages with the chat's own class.
    for (const bubble of screen.getByTestId("settings-text-size-preview").querySelectorAll("p")) expect(bubble).toHaveClass("chat-text-message");

    fireEvent.change(slider, { target: { value: "0" } });
    expect(stored()).toBe("small");
    expect(scale()).toBe("0.9");
    page.unmount();
  });

  it("in forced colors, its messages have the edge the chat's bubbles have", () => {
    // Forced colors drop the bubbles' backgrounds; index.css gives a message bubble an outline in the theme's text colour.
    const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    const edge = [...forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, , body]) => /outline:\s*1px solid CanvasText/.test(body));
    expect(edge, "the bubbles' forced-colors outline").toBeDefined();
    settingsPage();
    const bubbles = screen.getByTestId("settings-text-size-preview").querySelectorAll("p");
    expect(bubbles).toHaveLength(2);
    for (const bubble of bubbles) expect(bubble.matches(edge![1].trim()), bubble.textContent!).toBe(true);
  });

  it("is applied as the app starts, from what was stored", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ textSize: "larger" }));
    settingsPage();
    expect(scale()).toBe("1.3");
    expect(screen.getByTestId("settings-text-size")).toHaveValue("3");
  });

  it("an unknown stored value is the default", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ textSize: "gigantic" }));
    expect(loadSettings().textSize).toBe("default");
    settingsPage();
    expect(scale()).toBe("1");
  });

  it("a new profile made on this device starts at this device's text size", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ textSize: "large" }));
    const work = createProfile("Work");
    expect(JSON.parse(localStorage.getItem(settingsKeyFor(work.id))!).textSize).toBe("large");
  });

  it("is found by the settings search, by its name or by the words people look for it by", () => {
    const found = (language: Language, query: string) => searchSettings(query, translateWith(locales[language], language), () => true).map((entry) => entry.label);
    expect(found("en", "text size")).toEqual(["settings.textSize"]);
    expect(found("en", "zoom")).toEqual(["settings.textSize"]);
    expect(found("pt", "tamanho do texto")).toEqual(["settings.textSize"]);
    expect(found("ja", "文字サイズ")).toEqual(["settings.textSize"]);
  });
});
