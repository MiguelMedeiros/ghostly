import { describe, expect, it } from "vitest";
import { LANGUAGES, LOCALES, appSources, flatten, literalKeys, lookup } from "./locales";

// covers: app.i18n

/**
 * `t(key)` returns the key itself when a locale lacks it, so a missing translation shows `chat.deleteMessage`
 * in the UI instead of failing anywhere. These tests are where it fails instead.
 */

const en = flatten(LOCALES.en);
const others = LANGUAGES.filter((l) => l !== "en");
const placeholders = (text: string) => [...new Set(text.match(/\{\{\w+\}\}/g) ?? [])];

describe("every locale has the same keys as English", () => {
  it("English itself is only strings", () => {
    expect([...en].filter(([, v]) => typeof v !== "string").map(([k]) => k)).toEqual([]);
  });

  it.each(others)("%s has every English key, as a non-empty string", (language) => {
    const missing = [...en.keys()].filter((key) => !lookup(language, key)?.trim());
    expect(missing).toEqual([]);
  });

  it.each(others)("%s has no key English does not have", (language) => {
    const extra = [...flatten(LOCALES[language]).keys()].filter((key) => !en.has(key));
    expect(extra).toEqual([]);
  });

  it.each(others)("%s keeps every {{placeholder}} of the English text", (language) => {
    const lost = [...en].flatMap(([key, text]) => {
      const translation = lookup(language, key);
      if (translation === undefined) return [];
      return placeholders(text as string).filter((p) => !translation.includes(p)).map((p) => `${key} ${p}`);
    });
    expect(lost).toEqual([]);
  });

  it.each(others)("%s adds no {{placeholder}} English does not fill", (language) => {
    // `t()` only fills the params the English text was written for; a new one would show up raw.
    const unknown = [...en].flatMap(([key, text]) => {
      const translation = lookup(language, key);
      if (translation === undefined) return [];
      return placeholders(translation).filter((p) => !(text as string).includes(p)).map((p) => `${key} ${p}`);
    });
    expect(unknown).toEqual([]);
  });
});

/** Sources read as text: which keys they ask for is all that matters here. */
const allSources = appSources();
const componentSources = Object.fromEntries(Object.entries(allSources).filter(([path]) => [
  /^\.\.\/\.\.\/components\/(PaymentComposer|PaymentBubble|WalletDeck|GroupMembersDialog|GroupLinkPanel|NewGroupDialog|InviteCard|PairingBanner|MessageBubble)\.tsx$/,
  /^\.\.\/\.\.\/components\/(wallet\/providers|identities|layout)\/[^/]+\.tsx?$/,
  /^\.\.\/\.\.\/pages\/GroupChat\.tsx$/,
].some((pattern) => pattern.test(path))));

const name = (path: string) => path.replace(/^(\.\.\/)+/, "src/");

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
