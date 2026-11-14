import { describe, expect, it } from "vitest";
import { translatorFor } from "../../locales";
import { flatten, LOCALES } from "./locales";

// covers: app.i18n

/**
 * A breakable space before a French mark, or inside « »: "?", "!", ";", ":" and "»" take one before them, and a line
 * may break there and leave the mark alone at the start of the next. A mark that begins a word ("?requête", a URL's
 * query) is not one.
 */
const breakable = /\s(?<![\u00a0\u202f])[?!;:»](?=$|[\s"'),.?!…»])|«\s(?<![\u00a0\u202f])/;

/**
 * French wrote each of those spaces as a plain one (about 800 of them), so on a phone at 150% text the Leave
 * dialog's title read "Quitter Clube do livro" with "?" alone on the line under it. A narrow no-break space (U+202F)
 * goes before "?", "!", ";", a no-break space (U+00A0) before ":" and inside « ».
 */
describe("French keeps each mark on the line of the word before it", () => {
  it("no French string has a breakable space before ? ! ; : » or after «", () => {
    const bad = [...flatten(LOCALES.fr)].filter(([, value]) => typeof value === "string" && breakable.test(value)).map(([key, value]) => `${key}: ${value}`);
    expect(bad).toEqual([]);
  });

  it("the Leave dialog's title", () => {
    const t = translatorFor("fr");
    expect(t("group.leave.title", { name: "Clube do livro" })).toBe("Quitter Clube do livro\u202f?");
    expect(t("common.quotedName", { name: "Ana" })).toBe("«\u00a0Ana\u00a0»");
  });
});
