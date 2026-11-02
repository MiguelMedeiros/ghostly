import { describe, expect, it } from "vitest";
import { labelInName } from "../labelInName";
import { LANGUAGES, lookup } from "./locales";

// covers: app.i18n

/*
 * Label in Name (WCAG 2.5.3) for the buttons that show a short word and give screen readers a longer name: the name
 * holds the word, in every language, so a voice-control user can say what they see. English's names start with the word
 * by luck; Japanese, Arabic, Chinese, French and Italian said other words (2026-11-02). New chat shows its own short
 * word, not the Wallets' and Identities' New: in French and Arabic it agrees with "conversation" / "محادثة".
 */
const PAIRS = [
  { where: "the list's New chat button", shown: "sidebar.newChatShort", name: "sidebar.startChat" },
  { where: "the list's Join button", shown: "sidebar.join", name: "join.submit" },
  { where: "Network's Reset for the relays", shown: "network.reset", name: "network.resetRelays" },
  { where: "Network's Reset for the Iroh relays", shown: "network.reset", name: "network.resetIroh" },
] as const;

describe.each(LANGUAGES)("in %s, a button's name holds the word it shows", (language) => {
  it.each(PAIRS)("$where", ({ shown, name }) => {
    const label = lookup(language, shown);
    const accessible = lookup(language, name);
    expect(label, shown).toBeTruthy();
    expect(labelInName(label!, accessible!), `${shown} "${label}" in ${name} "${accessible}"`).toBe(true);
  });
});
