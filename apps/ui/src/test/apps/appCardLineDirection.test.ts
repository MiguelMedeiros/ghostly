import { describe, expect, it } from "vitest";
import { appCardLine } from "../../lib/statusCards";
import { isolate } from "../../lib/ownStatus";
import { translateWith } from "../../locales/translate";
import { LOCALES as locales } from "../i18n/locales";

// covers: apps.chat.card

/*
 * An app card's line (the chat list, a quote, the pinned bar, Saved, the screen reader) puts the sender's title inside
 * the reader's sentence. Shared with it, a card with no version, "Chess!", read "!Chess" in Arabic, and an Arabic title
 * in an English line put the version before the title. The title and the version each keep their own direction, so a
 * pre-release version ("1.2.0-beta.1") stays whole after the title in Arabic too.
 */

const card = (title: string) => ({ kind: "app" as const, ref: "k/chess", title, version: "1.2.0" });

describe("an app card's line", () => {
  it("in Arabic, an English title keeps its own direction", () => {
    const ar = translateWith(locales.ar, "ar");
    expect(appCardLine(card("Chess!"), true, ar, [])).toBe(`🧩 تطبيق: ${isolate("Chess!")} ${isolate("1.2.0")}`);
  });

  it("in Arabic, a pre-release version stays whole after the title", () => {
    const ar = translateWith(locales.ar, "ar");
    expect(appCardLine({ ...card("Chess"), version: "1.2.0-beta.1" }, true, ar, [])).toBe(`🧩 تطبيق: ${isolate("Chess")} ${isolate("1.2.0-beta.1")}`);
  });

  it("in English, an Arabic title keeps the version after it", () => {
    const en = translateWith(locales.en, "en");
    expect(appCardLine(card("شطرنج"), true, en, [])).toBe(`🧩 App: ${isolate("شطرنج")} ${isolate("1.2.0")}`);
  });

  it("a card with no version is its title alone, isolated", () => {
    const en = translateWith(locales.en, "en");
    expect(appCardLine({ ...card("شطرنج"), version: "" }, true, en, [])).toBe(`🧩 App: ${isolate("شطرنج")}`);
  });
});
