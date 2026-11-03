import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";
import { addSeedLists } from "./secrets";

/**
 * BIP39's lists in the languages the app speaks besides English (Arabic has none), for the secret guard. Imported for
 * its effect: by the composer as it opens, so they are no part of the app's first download, and by the CLI.
 */
addSeedLists([portuguese, spanish, french, italian, japanese, simplifiedChinese, traditionalChinese]);
