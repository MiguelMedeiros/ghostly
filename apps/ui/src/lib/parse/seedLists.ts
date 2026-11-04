import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";
import { MONERO_CHINESE_SIMPLIFIED, MONERO_FRENCH, MONERO_ITALIAN, MONERO_JAPANESE, MONERO_PORTUGUESE, MONERO_SPANISH } from "./monero-seed-lists";
import { addSeedLists } from "./secrets";

/**
 * BIP39's and Monero's lists in the languages the app speaks besides English (Arabic has none), for the secret guard.
 * Imported for its effect: by the composer as it opens, so they are no part of the app's first download, and by the
 * CLI.
 */
addSeedLists([portuguese, spanish, french, italian, japanese, simplifiedChinese, traditionalChinese], [
  // Monero's in the same languages, with each one's prefix length (its `Base(…, prefix)` in src/mnemonics/*.h).
  [MONERO_PORTUGUESE, 4], [MONERO_SPANISH, 4], [MONERO_FRENCH, 4], [MONERO_ITALIAN, 4], [MONERO_JAPANESE, 3],
  [MONERO_CHINESE_SIMPLIFIED, 1],
]);
