import { describe, expect, it } from "vitest";
import { RESTORED_WORDS } from "../../lib/profiles";
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
