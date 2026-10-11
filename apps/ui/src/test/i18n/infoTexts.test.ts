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

/** The screens whose ⓘ texts are held to the budget: Settings and the sections it is made of. */
const SETTINGS = [
  "../../pages/Settings.tsx",
  "../../components/NetworkSettings.tsx",
  "../../components/DomainProofSettings.tsx",
  "../../components/MediaSettings.tsx",
  "../../components/ProfileBackups.tsx",
  "../../components/settings/GroupDownloads.tsx",
  "../../components/DirectBlockedHint.tsx",
];

/** The keys a source passes to `t()` inside an `info={…}` (the ⓘ of a `Row`, a `Field` or an `InfoLine`), or names with `.info"`. */
function infoKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const start of source.matchAll(/\binfo=\{/g)) {
    let end = start.index + start[0].length;
    for (let depth = 1; depth && end < source.length; end++) depth += source[end] === "{" ? 1 : source[end] === "}" ? -1 : 0;
    for (const key of source.slice(start.index, end).matchAll(/\bt\(\s*"([\w.]+)"/g)) keys.add(key[1]);
  }
  for (const key of source.matchAll(/\bt\(\s*"([\w.]+\.info)"/g)) keys.add(key[1]);
  return [...keys];
}

const words = (text: string) => text.trim().split(/\s+/).length;

describe("the text behind an ⓘ is short", () => {
  const sources = appSources();
  const keys = [...new Set(SETTINGS.flatMap((file) => infoKeys(sources[file])))].sort();

  it("finds the ⓘ texts of Settings", () => {
    expect(keys).toEqual(expect.arrayContaining(["connection.directBlocked.info", "network.domainLookupsInfo", "profile.backups.holds", "pwa.wakeInfo", "settings.clearAllDataInfo"]));
    expect(keys.length).toBeGreaterThan(25);
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
