import { describe, expect, it } from "vitest";
import { english } from "../../lib/english";
import { translateWith } from "../../locales/translate";
import { LOCALES } from "./locales";

// covers: app.i18n

// A value goes into its string as it is: `$$`, `$&`, `` $` `` and `$'` are a contact's name, a text or a file's name,
// not String.replace's patterns ("Mo$$y" read "Mo$y", and `` $` `` repeated the words before it).
describe("a value with a $ in it", () => {
  const name = "Mo$$y $&";
  const text = "Lunch is $$ cheap, $` and $' too";

  it("is said as it is, in the app's translator", () => {
    const t = translateWith(LOCALES.en, "en");
    expect(t("chat.announce.message", { name, text })).toBe(`${name}: ${text}`);
  });

  it("is said as it is in English outside the app's provider", () => {
    expect(english("chat.announce.message", { name, text })).toBe(`${name}: ${text}`);
  });
});
