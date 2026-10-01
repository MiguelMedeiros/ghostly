import { describe, expect, it } from "vitest";
import { DEFAULT_NAMES, RESTORED_WORDS } from "../../lib/profiles";
import { LANGUAGES, lookup } from "./locales";

// covers: app.i18n

// lib/profiles takes the word for restored out of a profile name in every language the app speaks (a name typed or
// pasted with it, a registry or backup that kept it): its list is the words of profile.restoredName, all of them.
describe("the words a restored profile's name is said with", () => {
  it.each(LANGUAGES)("%s: profile.restoredName adds one of lib/profiles' RESTORED_WORDS, in parentheses", (language) => {
    const format = lookup(language, "profile.restoredName");
    expect(format).toBeDefined();
    const word = /^\{\{name\}\}\s*[(（]([^)）]+)[)）]$/u.exec(format!)?.[1];
    expect(word, `${language}: "{{name}} (word)"`).toBeDefined();
    expect(RESTORED_WORDS).toContain(word!.normalize("NFC"));
  });
});

// A backup an older app made of the first profile, never renamed, carries its name in that app's language: restored,
// lib/profiles reads any of them as the built-in name, so its list is profile.defaultName in every language.
describe("the first profile's name in every language", () => {
  it.each(LANGUAGES)("%s: profile.defaultName is one of lib/profiles' DEFAULT_NAMES", (language) => {
    expect(DEFAULT_NAMES).toContain(lookup(language, "profile.defaultName"));
  });
});
