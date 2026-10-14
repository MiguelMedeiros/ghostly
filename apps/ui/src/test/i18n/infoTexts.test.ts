import { describe, expect, it } from "vitest";
import { LANGUAGES, appSources, lookup } from "./locales";

// covers: app.i18n

/*
 * The text behind an ⓘ is the longer story of a short line, not a page: 25 English words at most, and about as much
 * room in the other languages (2026-10-11). Who sees what (an IP address, a relay, a push service) and what cannot be
 * undone stay in it; what the label or the hint already says is not said again.
 */

/** The most an ⓘ text may hold: words in English, characters in the other languages (which have no word count that compares). */
const WORDS = 25;
const CHARACTERS: Record<string, number> = { ja: 120, zh: 120 };
const OTHER_CHARACTERS = 210;

/**
 * The keys a source names inside an `info={…}` (the ⓘ of a `Row`, a `Field` or an `InfoLine`), one chosen by a
 * condition included (`t(direct ? "a.b" : "a.c")`), and the keys it names that end in `Info` or `.info`: the text of
 * an ⓘ a screen draws itself.
 */
function infoKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const start of source.matchAll(/\binfo=\{/g)) {
    let end = start.index + start[0].length;
    for (let depth = 1; depth && end < source.length; end++) depth += source[end] === "{" ? 1 : source[end] === "}" ? -1 : 0;
    for (const key of source.slice(start.index, end).matchAll(/["']([a-z]\w*(?:\.\w+)+)["']/gi)) keys.add(key[1]);
  }
  for (const key of source.matchAll(/["']([a-z]\w*(?:\.\w+)*(?:Info|\.info))["']/gi)) keys.add(key[1]);
  return [...keys].filter((key) => lookup("en", key) !== undefined);
}

/** ⓘ texts whose key is put together when it is drawn (`wallet.backupReminder.info.${due.backup}`). */
const BUILT = ["wallet.backupReminder.info.phrase", "wallet.backupReminder.info.profile"];

const words = (text: string) => text.trim().split(/\s+/).length;

describe("the text behind an ⓘ is short", () => {
  const sources = appSources();
  const keys = [...new Set([...Object.values(sources).flatMap(infoKeys), ...BUILT])].sort();

  it("finds the ⓘ texts of every screen", () => {
    expect(keys).toEqual(expect.arrayContaining(["connection.directBlocked.info", "network.domainLookupsInfo", "network.irohInfoDirect", "network.relaysInfoWeb", "profile.backups.holds", "pwa.wakeInfo", "settings.clearAllDataInfo",
      "apps.install.unknownPublisherInfo", "devices.limited.restoreInfo", "devices.standby.unreadableInfo", "payments.review.returnedInfo", "wallet.ark.sweepingInfo"]));
    expect(keys.length).toBeGreaterThanOrEqual(60);
  });

  it(`in English, ${WORDS} words at most`, () => {
    const long = keys.map((key) => [key, words(lookup("en", key)!)] as const).filter(([, count]) => count > WORDS);
    expect(long).toEqual([]);
  });

  it.each(LANGUAGES.filter((language) => language !== "en"))("in %s, about as much room", (language) => {
    const most = CHARACTERS[language] ?? OTHER_CHARACTERS;
    const long = keys.map((key) => [key, [...lookup(language, key)!].length] as const).filter(([, count]) => count > most);
    expect(long).toEqual([]);
  });
});
