import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupPayNote } from "@ghostly/browser/shared/types";
import { groupPayTitle } from "../../lib/groupPayments";
import { loadLocale, translatorFor } from "../../locales";
import type { Language } from "../../lib/settings";
import { groupView } from "../fakeEngine";

// covers: groups.payments.notes

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = groupView({ status: "active", epoch: 1, myKey: ME, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" })] });
const note = (patch: Partial<GroupPayNote>): GroupPayNote => ({ id: "req-1", kind: "request", from: BOB, to: ALICE, amount: "21", unit: "sat", decimals: 0, rail: "cashu", test: true, memo: "tacos", createdAt: 1_700_000_000_000, state: "open", ...patch });

/**
 * A group payment's line when I pay or am paid: each language words it its own way. "You" slotted into the line about
 * two other members gave "You is paying Alice", "Vous a demandé à Bob", "Tú pidió a Bob", "Tu ha chiesto a Bob" and
 * "طلب أنت من Bob".
 */
describe("a group payment's line where I am the payer or payee", () => {
  const mine: Partial<GroupPayNote>[] = [
    { to: ME, from: BOB }, // I asked one member
    { to: ALICE, from: ME }, // one member asked me
    { to: ME, from: "*" }, // I asked the group
    { ask: true, from: ME, to: ALICE }, // I am paying an ask
    { ask: true, from: BOB, to: ME }, // one member is paying me
    { kind: "payment", from: ME, to: ALICE, state: "sent" }, // I sent
    { kind: "payment", from: BOB, to: ME, state: "sent" }, // one member sent me
  ];
  const lines: Record<Language, string[]> = {
    en: ["You asked Bob", "Alice asked you", "You asked the group", "You are paying Alice", "Bob is paying you", "You sent Alice", "Bob sent you"],
    pt: ["Você pediu a Bob", "Alice pediu a você", "Você pediu ao grupo", "Você está pagando Alice", "Bob está pagando você", "Você enviou para Alice", "Bob enviou para você"],
    es: ["Le pediste a Bob", "Alice te pidió", "Pediste al grupo", "Le estás pagando a Alice", "Bob te está pagando", "Le enviaste a Alice", "Bob te envió"],
    fr: ["Vous avez demandé à Bob", "Alice vous a demandé", "Vous avez demandé au groupe", "Vous payez Alice", "Bob vous paie", "Vous avez envoyé à Alice", "Bob vous a envoyé"],
    it: ["Hai chiesto a Bob", "Alice ti ha chiesto", "Hai chiesto al gruppo", "Stai pagando Alice", "Bob ti sta pagando", "Hai inviato a Alice", "Bob ti ha inviato"],
    ar: ["طلبتَ من Bob", "طلب Alice منك", "طلبتَ من المجموعة", "تدفع لـ Alice", "Bob يدفع لك", "أرسلتَ إلى Alice", "أرسل Bob إليك"],
    ja: ["あなたが Bob に請求", "Alice があなたに請求", "あなたがグループに請求", "あなたが Alice に支払い中", "Bob があなたに支払い中", "あなたが Alice に送金", "Bob があなたに送金"],
    zh: ["你向 Bob 发起请求", "Alice 向你发起请求", "你向群组发起请求", "你正在付款给 Alice", "Bob 正在付款给你", "你向 Alice 付款", "Bob 向你付款"],
  };
  it.each(Object.keys(lines) as Language[])("in %s", async (language) => {
    await loadLocale(language);
    const t = translatorFor(language);
    expect(mine.map(patch => groupPayTitle(note(patch), group, t))).toEqual(lines[language]);
  });

  it("between two other members, names both", () => {
    expect(groupPayTitle(note({}), group)).toBe("Alice asked Bob");
    expect(groupPayTitle(note({ ask: true }), group)).toBe("Bob is paying Alice");
    expect(groupPayTitle(note({ kind: "payment" }), group)).toBe("Bob sent Alice");
  });
});
