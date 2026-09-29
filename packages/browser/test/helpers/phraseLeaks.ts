import { mnemonicToEntropy, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/**
 * Proving a recovery phrase is not stored, the same way every run.
 *
 * A random phrase is the wrong tool for it. BIP39's words are ordinary English, and so is the structure
 * around a sealed secret: "version", "vault", "salt", "seed", "main", "ghost", "address", "network" and
 * "state" are all in the list. "No word of the phrase is in what was stored" then fails whenever the draw
 * hits one of them (Breez's settings did, on "version").
 *
 * So the phrase is fixed, made of long words no stored key, label or encoding spells, and `phraseLeaks`
 * looks for every shape a leak takes: the phrase however it is cased or separated, any two of its words
 * in a row, any one of its words, and its entropy and seed as hex, base64 or bytes.
 */
export const TEST_PHRASE = "hamster lobster pyramid volcano gorilla dolphin giraffe leopard trumpet cabbage pumpkin squirrel";

const WORDS = TEST_PHRASE.split(" ");
const alone = (pattern: string) => new RegExp(`(?<![a-z])${pattern}(?![a-z])`);
/** What separates words when they are stored: a space, a newline, `","` in a JSON array. */
const GAP = "[^a-z]{1,4}";

/** The encodings a secret's bytes would be stored in. */
function encodings(bytes: Uint8Array): [string, string][] {
  const buffer = Buffer.from(bytes);
  return [
    ["hex", buffer.toString("hex")],
    ["base64", buffer.toString("base64").replace(/=+$/, "")],
    ["base64url", buffer.toString("base64url")],
    ["a byte list", [...bytes].join(",")],
    ["a Uint8Array", JSON.stringify(bytes)],
  ];
}
const SECRETS = [
  ...encodings(mnemonicToEntropy(TEST_PHRASE, wordlist)).map(([how, text]) => [`the entropy as ${how}`, text]),
  ...encodings(mnemonicToSeedSync(TEST_PHRASE)).map(([how, text]) => [`the seed as ${how}`, text]),
];

/**
 * What of TEST_PHRASE is in `text`: the names of the forms found, never the words themselves, so a
 * failure reads the same for a real phrase. Empty when nothing is.
 */
export function phraseLeaks(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  if (alone(WORDS.join(GAP)).test(lower)) found.push("the phrase");
  for (let i = 1; i < WORDS.length; i++) if (alone(`${WORDS[i - 1]}${GAP}${WORDS[i]}`).test(lower)) found.push(`words ${i} and ${i + 1} in a row`);
  WORDS.forEach((word, i) => { if (alone(word).test(lower)) found.push(`word ${i + 1}`); });
  for (const [what, secret] of SECRETS) if ((what.endsWith("hex") ? lower : text).includes(secret)) found.push(what);
  return found;
}
