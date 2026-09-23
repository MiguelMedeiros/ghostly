import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/**
 * Recovery phrases (BIP 39, English) for providers whose wallet Ghostly makes: the form generates one for
 * a new wallet and checks one typed to restore. Small on purpose, so a form can use it without loading
 * the provider.
 */
export const newRecoveryPhrase = () => generateMnemonic(wordlist);
/** A phrase as BIP 39 wants it, however it was typed or pasted. */
export const normalizePhrase = (text = "") => text.trim().toLowerCase().split(/\s+/).join(" ");
export const isRecoveryPhrase = (text: string) => validateMnemonic(normalizePhrase(text), wordlist);
