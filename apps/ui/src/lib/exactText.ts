/**
 * For a field whose text must stay as typed (an address, an invoice, a token, an invite, a recovery phrase, a key, a server's address or login): a phone's
 * keyboard would capitalize its first letter and correct its words, as it does for prose.
 */
export const exactText = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;
