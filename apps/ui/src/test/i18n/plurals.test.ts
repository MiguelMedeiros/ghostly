import { describe, expect, it } from "vitest";
import { formatAmount } from "../../lib/amount";
import { translateWith } from "../../locales/translate";
import { LOCALES, flatten } from "./locales";

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

  // agents#2255: a redeem at a mint that kept a fee says the unit in the form of what arrived.
  it("a redeem that paid the mint a fee says the unit for what arrived, in English and in Arabic", () => {
    const redeemed = (say: typeof en, count: number) => say("wallet.cashu.tokenRedeemedFeeTest", { count, amount: String(count), fee: "2" });
    expect([1, 2].map((count) => redeemed(en, count))).toEqual(["Redeemed 1 test sat (the mint kept 2 as its fee).", "Redeemed 2 test sats (the mint kept 2 as its fee)."]);
    expect([1, 2, 3, 11, 100].map((count) => redeemed(ar, count).split(" (")[0])).toEqual(["استُرد 1 sat تجريبي", "استُرد 2 sat تجريبيان", "استُرد 3 sats تجريبية", "استُرد 11 sat تجريبيًا", "استُرد 100 sat تجريبي"]);
  });

  // A store's app count (Apps' store rows, Add's store question) read "0 تطبيقات", "2 تطبيقات", "61 تطبيقات".
  it("a store's app count takes its form for every count, in Arabic and in every language", () => {
    const apps = (count: number) => ar("apps.store.count", { count });
    expect([0, 1, 2, 3, 10, 61, 100].map(apps)).toEqual(["لا تطبيقات", "تطبيق واحد", "تطبيقان", "3 تطبيقات", "10 تطبيقات", "61 تطبيقًا", "100 تطبيق"]);
    expect([1, 2].map((count) => en("apps.store.count", { count }))).toEqual(["1 app", "2 apps"]);
    expect([0, 1, 2].map((count) => translateWith(LOCALES.fr, "fr")("apps.store.count", { count }))).toEqual(["0 app", "1 app", "2 apps"]);
    for (const [language, dict] of Object.entries(LOCALES)) {
      expect(translateWith(dict, language as "en")("apps.store.count", { count: 1 }), language).not.toMatch(/apps\b|تطبيقات/);
    }
  });

  // A proof's expiry read "تنتهي خلال 2 يومًا" and "5 يومًا" in its last ten days; every Identities count had one form.
  it("an identity's counts take their form for every count in Arabic", () => {
    const expires = (count: number) => ar("identities.card.expiresIn", { count });
    expect([2, 5, 10, 11, 30, 100].map(expires)).toEqual(["تنتهي خلال يومين", "تنتهي خلال 5 أيام", "تنتهي خلال 10 أيام", "تنتهي خلال 11 يومًا", "تنتهي خلال 30 يومًا", "تنتهي خلال 100 يوم"]);
    expect([7, 30, 90, 180, 365].map((count) => ar("identities.add.days", { count }))).toEqual(["7 أيام", "30 يومًا", "90 يومًا", "180 يومًا", "365 يومًا"]);
    expect([2, 3, 11].map((count) => ar("identities.card.sharedIn", { count }))).toEqual(["مُشاركة في محادثتين", "مُشاركة في 3 محادثات", "مُشاركة في 11 محادثة"]);
    expect(ar("identities.ghostly.alsoSees", { contact: "Bob", count: 2 })).toBe("Bob يرى أيضًا هويتين أخريين");
    expect(ar("identities.nostr.youFollowAsOf", { count: 200, time: "x" })).toBe("تتابع 200 حساب (القائمة حتى x).");
    expect([0, 2, 1234].map((count) => ar("identities.profile.followers", { count: formatAmount(count, "ar") }))).toEqual(["لا متابعين", "متابعان", "1,234 متابعًا"]);
    // Every counted Identities string has Arabic's dual, 3-10 and 11-99 forms.
    const counted = [...flatten(LOCALES.en.identities, "identities")].filter(([, text]) => (text as string).includes("{{count}}")).map(([key]) => key);
    expect(counted.length).toBe(18);
    const same = counted.filter((key) => new Set([2, 3, 11].map((count) => ar(key as "identities.add.days", { count, contact: "c", time: "t" }).replace(/\d+/, ""))).size < 3);
    expect(same).toEqual([]);
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
