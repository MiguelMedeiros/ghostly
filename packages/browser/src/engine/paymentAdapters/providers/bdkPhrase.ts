import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** A new recovery phrase for a BDK wallet: 12 English words (BIP39). The form shows it once, to write down. */
export const newBdkPhrase = () => generateMnemonic(wordlist);
