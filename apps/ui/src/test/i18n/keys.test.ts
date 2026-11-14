import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain script, no types
import { formatLocale } from "../../../../../tools/scripts/locales-sort.mjs";
import english from "../../locales/en";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES, appSources, flatten, literalKeys, lookup } from "./locales";

// covers: app.i18n

/**
 * `t(key)` returns the key itself when a locale lacks it, so a missing translation shows `chat.deleteMessage`
 * in the UI instead of failing anywhere. These tests are where it fails instead.
 */

const en = flatten(LOCALES.en);
const others = LANGUAGES.filter((l) => l !== "en");
const placeholders = (text: string) => [...new Set(text.match(/\{\{\w+\}\}/g) ?? [])];
/** The English key a plural form (`chat.forward.messages_two`) is said for, or undefined. */
const pluralBase = (key: string) => /^(.+)_(zero|one|two|few|many|other)$/.exec(key)?.[1];
/**
 * English keys that are not a plural form of another one. A form (`apps.store.count_one`) is checked against its
 * key instead, as every language's forms are: Arabic's one reads "تطبيق واحد" without the English "{{count}} app"'s
 * number, and French's one, said for 0 too, needs it.
 */
const ownKeys = () => [...en].filter(([key]) => !en.has(pluralBase(key) ?? ""));

const LOCALE_DIR = join(fileURLToPath(import.meta.url), "../../../locales");
const areaFiles = (language: string) => readdirSync(join(LOCALE_DIR, language)).filter((f) => f.endsWith(".json")).sort();

describe("the locale files", () => {
  it("English imports every area file in en/index.ts, for the types", () => {
    expect(Object.keys(english).sort()).toEqual(areaFiles("en").map((f) => f.slice(0, -".json".length)));
  });

  it.each(LANGUAGES)("%s has the same area files as English", (language) => {
    expect(areaFiles(language)).toEqual(areaFiles("en"));
  });

  it.each(LANGUAGES)("%s: every file's keys are sorted (npm run locales:sort)", (language) => {
    // Sorted keys spread the keys pull requests add over the file: two of them adding keys to one area at the
    // same time touch different lines, where appending made both touch the last one.
    const unsorted = areaFiles(language).filter((file) => {
      const text = readFileSync(join(LOCALE_DIR, language, file), "utf8");
      return formatLocale(text) !== text;
    });
    expect(unsorted).toEqual([]);
  });
});

describe("every locale has the same keys as English", () => {
  it("English itself is only strings", () => {
    expect([...en].filter(([, v]) => typeof v !== "string").map(([k]) => k)).toEqual([]);
  });

  it.each(others)("%s has every English key, as a non-empty string", (language) => {
    const missing = [...en.keys()].filter((key) => !lookup(language, key)?.trim());
    expect(missing).toEqual([]);
  });

  it.each(others)("%s has no key English does not have", (language) => {
    // A counted string's plural forms (`<key>_two`, `<key>_many`: translate.ts `pluralForm`) belong to its English key.
    const extra = [...flatten(LOCALES[language]).keys()].filter((key) => !en.has(key) && !en.has(pluralBase(key) ?? ""));
    expect(extra).toEqual([]);
  });

  it.each(others)("%s keeps every {{placeholder}} of the English text", (language) => {
    const lost = ownKeys().flatMap(([key, text]) => {
      const translation = lookup(language, key);
      if (translation === undefined) return [];
      return placeholders(text as string).filter((p) => !translation.includes(p)).map((p) => `${key} ${p}`);
    });
    expect(lost).toEqual([]);
  });

  it.each(others)("%s gives a counted string's plural forms no {{placeholder}} its English key does not fill", (language) => {
    const unknown = [...flatten(LOCALES[language])].flatMap(([key, value]) => {
      const base = pluralBase(key);
      if (!base || !en.has(base) || typeof value !== "string") return [];
      return placeholders(value).filter((p) => !(en.get(base) as string).includes(p)).map((p) => `${key} ${p}`);
    });
    expect(unknown).toEqual([]);
  });

  it.each(others)("%s adds no {{placeholder}} English does not fill", (language) => {
    // `t()` only fills the params the English text was written for; a new one would show up raw.
    const unknown = ownKeys().flatMap(([key, text]) => {
      const translation = lookup(language, key);
      if (translation === undefined) return [];
      return placeholders(translation).filter((p) => !(text as string).includes(p)).map((p) => `${key} ${p}`);
    });
    expect(unknown).toEqual([]);
  });
});

/**
 * Arabic strings with `{{count}}` that need no `<key>_<category>` forms: the number stands alone or beside an adjective
 * ("عرض المزيد ({{count}})", "{{count}} نشطة"), the noun counts another number, or the count is a fixed cap of 32 or
 * 256, which takes the 11-99 form the string is written in ("حتى {{count}} عضوًا").
 */
const ARABIC_COUNT_ALONE = new Set([
  "apps.files.askAgainMore", "apps.store.showMore", "calls.timeline.audioMissedMany", "calls.timeline.videoMissedMany",
  "cards.board.showMore", "cards.board.showOlder", "cards.panel.activeCount", "cards.panel.buttonCount", "cards.panel.failedCount",
  "cards.panel.finishedCount", "chat.announce.rowMoved", "chat.forward.partial", "chat.forward.pick", "chat.forward.selected",
  "chat.hold.quota", "chat.jump.count", "chat.listTime.days", "chat.listTime.hours", "chat.listTime.minutes",
  "composer.identityShared", "composer.sendCount", "composer.servicesShared", "connection.history.showAll",
  "connection.history.title", "errors.group.growMore", "group.create.communityHint", "group.link.full", "group.link.note",
  "group.link.noteCommunity", "group.members.missing", "group.members.missingOne", "group.readNote", "group.readNoteCommunity",
  "group.readNoteCommunityOff",
  "messageDetails.value.edits", "profileSwitcher.unread", "pwa.sharePastLimit", "saved.rowLabel", "secretGuard.sat",
  "secretGuard.sats", "settings.storageParts.files", "sidebar.folder.unreadCount",
  "sidebar.rail.unreadCount", "wallet.fedimint.facts.guardianList", "wallet.fedimint.restoreFailed", "wallet.remove.pending",
  "wallet.source.available",
]);

describe("Arabic counted strings", () => {
  const ar = flatten(LOCALES.ar);
  const hasForms = (key: string) => [...ar.keys()].some((k) => pluralBase(k) === key);
  const counted = [...ar].filter(([key, value]) => !pluralBase(key) && typeof value === "string" && value.includes("{{count}}")).map(([key]) => key);

  it("give a counted noun its forms for 2 and 11+, not the 3-10 form for every count (translate.ts pluralForm)", () => {
    // "2 محادثات" and "15 محادثات" read as "2 chats" said wrong: two is "محادثتان", 11-99 "15 محادثة".
    expect(counted.filter((key) => !hasForms(key) && !ARABIC_COUNT_ALONE.has(key))).toEqual([]);
  });

  it("list no string as standing alone that is gone or has its forms", () => {
    expect([...ARABIC_COUNT_ALONE].filter((key) => !counted.includes(key) || hasForms(key))).toEqual([]);
  });

  const t = translateWith(LOCALES.ar, "ar");
  it.each([
    ["profile.chatCount", 2, "محادثتان"],
    ["profile.chatCount", 5, "5 محادثات"],
    ["profile.chatCount", 15, "15 محادثة"],
    ["group.connection.reconnectingTo", 2, "جارٍ إعادة الاتصال بعضوين…"],
    ["group.connection.reconnectingTo", 12, "جارٍ إعادة الاتصال بـ 12 عضوًا…"],
    ["services.status.sharedCount", 2, "تمت مشاركته مع جهتي اتصال"],
    ["composer.tooLong", 4097, "النص طويل جدًا للإرسال (4097 حرفًا، والحد 4096)."],
  ] as const)("%s says %d as a person reads it", (key, count, want) => {
    expect(t(key, { count, max: 4096 })).toBe(want);
  });

  // A string with one number not named count is said for that number.
  it.each([
    ["payments.invoice.expiresDays", { n: 1 }, "تنتهي خلال يوم واحد"],
    ["payments.invoice.expiresDays", { n: 2 }, "تنتهي خلال يومين"],
    ["payments.invoice.expiresDays", { n: 14 }, "تنتهي خلال 14 يومًا"],
    ["connection.duration.days", { n: 30 }, "30 يومًا"],
    ["chat.voice.limit", { minutes: 15 }, "الحد الأقصى للرسائل الصوتية 15 دقيقة"],
  ] as const)("%s says %o as a person reads it", (key, params, want) => {
    expect(t(key, params)).toBe(want);
  });
});

/** Sources read as text: which keys they ask for is all that matters here. */
const allSources = appSources();
const componentSources = Object.fromEntries(Object.entries(allSources).filter(([path]) => [
  /^\.\.\/\.\.\/components\/(PaymentComposer|PaymentBubble|WalletDeck|GroupMembersDialog|GroupLinkPanel|NewGroupDialog|InviteCard|ChatConnection|MessageBubble)\.tsx$/,
  /^\.\.\/\.\.\/components\/(wallet\/providers|identities|layout)\/[^/]+\.tsx?$/,
  /^\.\.\/\.\.\/pages\/GroupChat\.tsx$/,
].some((pattern) => pattern.test(path))));

const name = (path: string) => path.replace(/^(\.\.\/)+/, "apps/ui/src/");

describe("the keys components ask for exist in every language", () => {
  it("finds the sources and the keys in them", () => {
    // A glob or a pattern that matched nothing would make the checks below pass on nothing.
    expect(Object.keys(componentSources).length).toBeGreaterThanOrEqual(20);
    expect(literalKeys(componentSources["../../components/MessageBubble.tsx"])).toEqual(
      expect.arrayContaining(["chat.deleteMessage", "chat.deleteMessageHint", "common.cancel", "common.delete"]),
    );
    expect(literalKeys(allSources["../../components/pairing/words.ts"])).toEqual(
      expect.arrayContaining(["pairing.stage.onDht", "pairing.step.onDht", "pairing.onDht.waiting"]),
    );
  });

  const used = Object.entries(componentSources).flatMap(([path, source]) => literalKeys(source).map((key) => ({ file: name(path), key })));

  it.each(LANGUAGES)("%s: payments, wallet, identities, groups, pairing, messages and layout", (language) => {
    const missing = used.filter(({ key }) => lookup(language, key) === undefined).map(({ file, key }) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("reads the whole app's sources", () => {
    expect(Object.keys(allSources).length).toBeGreaterThan(100);
    expect(Object.values(allSources).flatMap(literalKeys).filter((key) => key.includes(".")).length).toBeGreaterThan(100);
  });

  it.each(LANGUAGES)("%s: every literal key anywhere in the app", (language) => {
    const missing = Object.entries(allSources).flatMap(([path, source]) =>
      literalKeys(source).filter((key) => key.includes(".") && lookup(language, key) === undefined).map((key) => `${name(path)}: ${key}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("every English key is asked for somewhere in the app", () => {
  // A key is named whole as a string (`t("chat.x")`, `labelKey: "chat.x"`), or built from a head the app writes
  // (`messageDetails.label.${label}`, "providers." + id). One nothing names is a string translated in every language
  // that no screen shows. The web app's and the extension's hosts ask for keys of their own (`services.window.retry`).
  const hostSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : hostSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });
  const APPS = join(LOCALE_DIR, "../../..");
  const source = [...Object.values(allSources), ...hostSources(join(APPS, "web/src")), ...hostSources(join(APPS, "extension/src"))].join("\n");
  const strings = new Set([...source.matchAll(/(["'`])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\.?)(?=\1|\$\{)/g)].map((m) => m[2]));
  const named = (key: string) => {
    const parts = (pluralBase(key) ?? key).split(".");
    return strings.has(parts.join(".")) || parts.some((_, i) => i > 0 && strings.has(`${parts.slice(0, i).join(".")}.`));
  };

  it("sees the keys the app builds from a head", () => {
    expect(strings.has("messageDetails.label.")).toBe(true);
    expect(named("messageDetails.label.sent")).toBe(true);
  });

  it("names every one", () => {
    expect([...en.keys()].filter((key) => !named(key))).toEqual([]);
  });
});
