import { describe, expect, it } from "vitest";
import { english } from "../../lib/english";
import { translateWith } from "../../locales/translate";
import { LOCALES } from "./locales";

// covers: app.i18n

// A value goes into its string as it is, even one that reads like another of the string's places: a contact who calls
// themselves "{{days}}" is "{{days}}" in "While {{name}} is away … for up to {{days}} days", not the number of days.
describe("a value that holds another value's place", () => {
  const name = "{{text}} {{days}}";

  it("is said as it is, in the app's translator", () => {
    const t = translateWith(LOCALES.en, "en");
    expect(t("chat.hold.intro", { name, days: 7 })).toBe(`While ${name} is away, what you send waits in your own storage, sealed so only they can open it, for up to 7 days. Text, pictures and payment requests; never ecash. They need to allow it too.`);
    expect(t("chat.announce.message", { name, text: "hello" })).toBe(`${name}: hello`);
  });

  it("is said as it is in a language that counts it", () => {
    const t = translateWith(LOCALES.ar, "ar");
    expect(t("chat.hold.intro", { name, days: 2 })).toContain(`أثناء غياب ${name}،`);
  });

  it("is said as it is in English outside the app's provider", () => {
    expect(english("chat.announce.message", { name, text: "hello" })).toBe(`${name}: hello`);
  });
});
