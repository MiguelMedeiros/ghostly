import { describe, expect, it } from "vitest";
import { translateWith } from "../../locales/translate";
import { LOCALES } from "./locales";

// covers: app.i18n

// agents#1614: Arabic said every count with one plural form: "2 ملفات" for the dual, "32 ملفات" for the singular after 11.
describe("a counted string", () => {
  const ar = translateWith(LOCALES.ar, "ar"), en = translateWith(LOCALES.en, "en");

  it("in Arabic takes the form its count asks for: one, the dual, 3-10, 11-99 and 100 up", () => {
    const files = (count: number) => ar("pwa.shareFiles", { count });
    expect([1, 2, 3, 10, 11, 32, 100].map(files)).toEqual(["ملف واحد", "ملفان", "3 ملفات", "10 ملفات", "11 ملفًا", "32 ملفًا", "100 ملف"]);
    expect(ar("chat.forward.messages", { count: 2 })).toBe("رسالتان");
    expect(ar("group.chat.memberCount", { count: 25 })).toBe("25 عضوًا");
  });

  it("takes its count from {{count}}, or from its one number when it has no count", () => {
    expect(ar("errors.group.filesPacedNextMinutes", { minutes: 2 })).toBe("انتظر دقيقتين، ثم أرسله مرة أخرى.");
    expect(ar("errors.group.filesPacedNextMinutes", { minutes: 5 })).toBe("انتظر 5 دقائق، ثم أرسله مرة أخرى.");
  });

  it("with no form for its count, or no count at all, is the key's own text", () => {
    expect(en("pwa.shareFiles", { count: 2 })).toBe(translateWith(LOCALES.en)("pwa.shareFiles", { count: 2 }));
    expect(ar("pwa.shareFiles", { count: "x" })).toBe("x ملفات");
    expect(ar("pwa.shareFiles")).toBe("{{count}} ملفات");
  });
});
