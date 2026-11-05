import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MONERO_WORDS } from "./monero-words";

/**
 * What the composer asks about before a message goes: text that looks like a secret someone could take funds or an
 * identity with, or a Cashu token (bearer money: the text box would hand it to whoever reads the chat).
 *
 * Detection is local and synchronous, and a finding never carries the text it found: only what kind it is and, for
 * ecash, the amount decoded here. Ark, Spark and Fedimint wallets are BIP39 seeds or raw keys, caught by the rules
 * below; Fedimint ecash notes are plain base64 with no prefix, so they are not recognised. A `node-login` is what the
 * wallet sources ask for to reach a node: an LND macaroon, a Core Lightning rune, a bitcoind RPC password or cookie.
 */
export type SecretFinding =
  | { kind: "mnemonic" | "nsec" | "bitcoin-key" | "hex-key" | "node-login" }
  | { kind: "cashu"; amount: number | null; unit: string };

export type SecretKind = SecretFinding["kind"];

interface SeedWords {
  /** Each word's place in the list, as `words` spells it. */
  index: () => Map<string, number>;
  /** The words of a text, spelled as `index` keys them. */
  words: (text: string) => string[] | null;
  /** Seed lengths whose checksum is tried on any run of these words. */
  lengths: number[];
  /** A message that is nothing but this many of these words counts, checksum or not. */
  wholeMessage: number[];
  checksumHolds: (indices: number[]) => boolean;
}

const englishWords = (text: string) => text.toLowerCase().match(/[a-z]+/g);

/**
 * A word of another language's list as it is matched: decomposed, in lower case and without its marks, so "ábaco",
 * "ABACO" and "abaco" are one word, and a Japanese word is one with or without its voicing marks. No two words of a
 * list are the same once read this way.
 */
const fold = (text: string) => text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
const foldedWords = (text: string) => fold(text).match(/\p{L}+/gu);

/** Built the first time a message is read: most messages never get past English. */
function lazyIndex(list: readonly string[], spell: (word: string) => string): () => Map<string, number> {
  let index: Map<string, number> | undefined;
  return () => (index ??= new Map(list.map((word, i) => [spell(word), i])));
}

const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];
const BIP39: SeedWords = {
  index: lazyIndex(wordlist, (word) => word),
  words: englishWords,
  lengths: MNEMONIC_LENGTHS,
  /**
   * BIP39's lengths, and a Polyseed's 16 (Monero's seed in Feather and Cake Wallet, BIP39's English words with a
   * checksum of its own, which BIP39's caught only by chance, about 3 in 10).
   */
  wholeMessage: [...MNEMONIC_LENGTHS, 16],
  checksumHolds: bip39ChecksumHolds,
};
/** Monero's classic seed (Monero GUI, monero-wallet-cli): 25 words of its own list, or MyMonero's 13. */
const MONERO: SeedWords = {
  index: lazyIndex(MONERO_WORDS, (word) => word),
  words: englishWords,
  lengths: [25, 13],
  wholeMessage: [25, 13],
  checksumHolds: moneroChecksum(MONERO_WORDS, 3),
};
let seeds = [BIP39, MONERO];

/**
 * BIP39's own lists in the app's other languages, which a wallet set to one of them shows its seed in: the same
 * lengths and checksum as the English list. Monero's lists in them too, each with the prefix length its checksum
 * reads. Handed in by `seedLists.ts`, which the composer loads as it opens (83 KB gzipped, kept out of the app's
 * first download) and the CLI with the guard.
 */
export function addSeedLists(lists: readonly (readonly string[])[], moneroLists: readonly [list: readonly string[], prefix: number][] = []): void {
  seeds = [BIP39, MONERO, ...lists.map((list): SeedWords => ({
    index: lazyIndex(list, fold),
    words: foldedWords,
    lengths: MNEMONIC_LENGTHS,
    wholeMessage: MNEMONIC_LENGTHS,
    checksumHolds: bip39ChecksumHolds,
  })), ...moneroLists.map(([list, prefix]): SeedWords => ({
    index: lazyIndex(list, fold),
    words: foldedWords,
    lengths: MONERO.lengths,
    wholeMessage: MONERO.wholeMessage,
    checksumHolds: moneroChecksum(list, prefix),
  }))];
}
/** Checksums tried per message and word list at most: a 16 KiB run of seed words stays a few milliseconds. */
const CHECKSUM_BUDGET = 4096;

const NSEC = /\bnsec1[02-9ac-hj-np-z]{58}(?![02-9ac-hj-np-z])/i;
const EXTENDED_PRIVATE = /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,}/;
const WIF = /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const HEX_SECRET = /\b(?:0x)?(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64})\b/g;
/**
 * Monero's keys count too: "Private spend key" and "Spend key (private)" (Cake Wallet, MyMonero). A bare "spend key" or
 * "view key" does not, as a wallet's public keys are written that way too.
 */
const SECRET_CONTEXT = /priv(?:ate)?[\s_-]*(?:(?:spend|view)[\s_-]*)?key|(?:spend|view)[\s_-]*key[\s_-]*\(\s*private|secret|seed|mnemonic|nsec|xprv|\bwif\b|recovery|passphrase|password/i;
/** A bitcoind login: its cookie file (`__cookie__:<hex>`), `rpcpassword=`, or the bitcoind source's own words. */
const NODE_CONTEXT = /__cookie__|rpc[\s_-]*pass(?:word)?|\bcookie\b/i;
/** How far from a 64-hex string a word like "seed" still counts as saying what it is. */
const CONTEXT_REACH = 48;
/** A macaroon (version 2) with a location, as LND writes it: `02 01 <length> lnd …`, in hex or base64. */
const MACAROON_HEX = /\b0201[0-9a-fA-F]{96,}\b/g;
const MACAROON_BASE64 = /(?<![\w+/-])AgE[\w+/-]{60,}={0,2}/g;
/** A Core Lightning rune: base64url of a 32-byte authcode and the restrictions. */
const RUNE = /(?<![\w-])[\w-]{43,}={0,2}(?![\w=-])/g;
/** The restrictions of a rune that `createrune` made: its unique id first (`=0`, `=3&method=…`). */
const RUNE_RESTRICTIONS = /^=\d+(?:[&|][ -~]*)?$/;
const RUNE_WORD = /\brunes?\b/i;
const CASHU_TOKEN = /\bcashu([AB])([A-Za-z0-9_\-+/]{20,}={0,2})/g;

/**
 * Characters that take no room on screen: format characters (zero-width space, soft hyphen, word joiner, the joiners,
 * direction marks), control characters that are not white space, variation selectors, the grapheme joiner and the
 * Hangul fillers. A page, a PDF or a terminal puts some of them into long strings as places to break a line.
 */
const INVISIBLE = /(?![\t\n\v\f\r\x85])[\p{Cc}\p{Cf}]|\u034f|[\u115f\u1160\u3164\uffa0]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;

const base58check = createBase58check(sha256);

/**
 * The first secret in `text`, keys and seeds before ecash; null for anything else. The text is read as it is and as
 * it reads without its invisible characters: a key with one inside is whole again once the reader takes it out.
 */
export function findSecret(text: string): SecretFinding | null {
  const visible = text.replace(INVISIBLE, "");
  const readings = visible === text ? [text] : [text, visible];
  if (readings.some((reading) => {
    // A text's words are read once per way of reading them, not once per list: the other languages' 13 lists share one.
    const words = new Map<SeedWords["words"], string[] | null>();
    return seeds.some((seed) => {
      if (!words.has(seed.words)) words.set(seed.words, seed.words(reading));
      return hasMnemonic(words.get(seed.words)!, seed);
    });
  })) return { kind: "mnemonic" };
  if (readings.some((reading) => NSEC.test(reading))) return { kind: "nsec" };
  if (readings.some((reading) => EXTENDED_PRIVATE.test(reading) || hasWif(reading))) return { kind: "bitcoin-key" };
  if (readings.some(hasNodeLogin)) return { kind: "node-login" };
  if (readings.some(hasHexSecret)) return { kind: "hex-key" };
  const tokens = readings.map(findCashu);
  return tokens.find((found) => found?.kind === "cashu" && found.amount !== null) ?? tokens.find((found) => found) ?? null;
}

/**
 * 12 to 24 words in a row from the English BIP39 list whose checksum holds, anywhere in the text; or a message that
 * is nothing but 12, 15, 16, 18, 21 or 24 of those words (a seed with one word mistyped is still most of a seed). The
 * same for Monero's English list, 25 or 13 words, and for BIP39's and Monero's lists in the app's other languages.
 * Prose breaks a run at once: "the", "a", "is", "to", "and", "of" and "I" are on neither English list, nor "de",
 * "la", "a", "e" on the others.
 *
 * One word said over and over is not a seed, though one in 16 such runs passes a 12-word checksum ("word" does), and
 * every one passes Monero's: a window of a single word never counts, and a window mostly of one word ("abandon …
 * about") counts only when that word does not go on past it on either side.
 */
function hasMnemonic(tokens: string[] | null, seed: SeedWords): boolean {
  const shortest = Math.min(...seed.lengths);
  if (!tokens || tokens.length < shortest) return false;
  const index = seed.index();
  let budget = CHECKSUM_BUDGET;
  let run: number[] = [];
  const seedLike = (start: number, length: number) => {
    const window = run.slice(start, start + length);
    const counts = new Map<number, number>();
    for (const word of window) counts.set(word, (counts.get(word) ?? 0) + 1);
    if (counts.size === 1) return false;
    const [most, times] = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a));
    if (times > length / 2 && (run[start - 1] === most || run[start + length] === most)) return false;
    return seed.checksumHolds(window);
  };
  const check = () => {
    if (run.length >= shortest) {
      for (const length of seed.lengths) {
        for (let start = 0; start + length <= run.length && budget > 0; start++, budget--) {
          if (seedLike(start, length)) return true;
        }
      }
      if (run.length === tokens.length && seed.wholeMessage.includes(run.length) && new Set(run).size > 1) return true;
    }
    run = [];
    return false;
  };
  for (const token of tokens) {
    const at = index.get(token);
    if (at !== undefined) run.push(at);
    else if (check()) return true;
  }
  return check();
}

/** BIP39: the words' 11-bit indices are the entropy followed by the first bits of its SHA-256. */
function bip39ChecksumHolds(indices: number[]): boolean {
  const bits = indices.length * 11, checksumBits = bits / 33, entropyBytes = (bits - checksumBits) / 8;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  indices.forEach((index, i) => {
    for (let b = 0; b < 11; b++) if (index & (1 << (10 - b))) { const at = i * 11 + b; bytes[at >> 3] |= 0x80 >> (at & 7); }
  });
  const expected = sha256(bytes.subarray(0, entropyBytes))[0] >> (8 - checksumBits);
  const got = bytes[entropyBytes] >> (8 - checksumBits);
  return expected === got;
}

/**
 * Monero (src/mnemonics/electrum-words.cpp): the last word repeats the one at CRC-32 of the other words' first
 * `prefix` letters as the list spells them (English 3, Japanese 3, Chinese 1, the others 4), run together in UTF-8,
 * modulo how many they are.
 */
function moneroChecksum(list: readonly string[], prefix: number): (indices: number[]) => boolean {
  let prefixes: string[] | undefined;
  return (indices) => {
    prefixes ??= list.map((word) => Array.from(word).slice(0, prefix).join(""));
    const words = indices.slice(0, -1);
    return words[crc32(words.map((index) => prefixes![index]).join("")) % words.length] === indices[indices.length - 1];
  };
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

const utf8 = new TextEncoder();

/** CRC-32 (the zlib one) of text in UTF-8. */
function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of utf8.encode(text)) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A WIF private key: base58check with version 0x80 (mainnet) or 0xef (testnet), 32 bytes and an optional 0x01. */
function hasWif(text: string): boolean {
  for (const [candidate] of text.matchAll(WIF)) {
    try {
      const payload = base58check.decode(candidate);
      if ((payload[0] === 0x80 || payload[0] === 0xef) && (payload.length === 33 || (payload.length === 34 && payload[33] === 1))) return true;
    } catch { /* not base58check: an ordinary word */ }
  }
  return false;
}

/** Whether `context` is said within reach of `match`, before or after it. */
function beside(text: string, match: RegExpExecArray, context: RegExp): boolean {
  const before = text.slice(Math.max(0, match.index - CONTEXT_REACH), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + CONTEXT_REACH);
  return context.test(before) || context.test(after);
}

/** 64 or 128 hex digits with "private key", "secret", "seed" or the like close by. A bare hash is not asked about. */
function hasHexSecret(text: string): boolean {
  return hexBeside(text, SECRET_CONTEXT);
}

function hexBeside(text: string, context: RegExp): boolean {
  for (const match of text.matchAll(HEX_SECRET)) if (beside(text, match, context)) return true;
  return false;
}

/** A login to a node: a macaroon, a rune, or 64 hex digits that bitcoind's cookie or `rpcpassword` names. */
function hasNodeLogin(text: string): boolean {
  if (hexBeside(text, NODE_CONTEXT)) return true;
  for (const [hex] of text.matchAll(MACAROON_HEX)) if (hex.length % 2 === 0 && isMacaroon(Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)))) return true;
  for (const [text64] of text.matchAll(MACAROON_BASE64)) if (isMacaroon(tryBase64(text64))) return true;
  for (const match of text.matchAll(RUNE)) if (isRune(text, match)) return true;
  return false;
}

const printable = (bytes: Uint8Array) => bytes.every((b) => b >= 0x20 && b <= 0x7e);
/** Bytes as a string of one character each, however many there are. */
const binary = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

function tryBase64(text: string): Uint8Array | null {
  try { return fromBase64(text); } catch { return null; }
}

/** Whether `text` is exactly how `bytes` are written in padded base64url: nothing left over in its last letter. */
function canonicalBase64url(text: string, bytes: Uint8Array): boolean {
  return btoa(binary(bytes)).replace(/\+/g, "-").replace(/\//g, "_") === text;
}

/** Version 2 with a location (LND's "lnd"), the identifier next, and the 32-byte signature last. */
function isMacaroon(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes[0] !== 2 || bytes[1] !== 1) return false;
  const length = bytes[2];
  return length > 0 && length < 128 && printable(bytes.subarray(3, 3 + length)) && bytes[3 + length] === 2
    && bytes.length >= 3 + length + 36 && bytes[bytes.length - 34] === 6 && bytes[bytes.length - 33] === 32;
}

/**
 * A rune decodes to a hash, which is never text, and then its restrictions, which always are: the unique id first
 * when `createrune` made it, padded as it prints it. One with no restriction (or an older one with no id, or with its
 * padding taken off) counts only beside the word "rune".
 * Hex is read as a hash or a key above, never as a rune.
 */
function isRune(text: string, match: RegExpExecArray): boolean {
  if (/^[0-9a-fA-F]+=*$/.test(match[0])) return false;
  const bytes = tryBase64(match[0]);
  if (!bytes || bytes.length < 32 || printable(bytes.subarray(0, 32))) return false;
  const tail = bytes.subarray(32);
  if (!printable(tail)) return false;
  const restrictions = binary(tail);
  if (canonicalBase64url(match[0], bytes) && RUNE_RESTRICTIONS.test(restrictions)) return true;
  return (!restrictions || /^\w*[!=/^$~<>{}#]/.test(restrictions)) && beside(text, match, RUNE_WORD);
}

/** Every Cashu token in the text, with their amounts added up when all of them decode and share one unit. */
function findCashu(text: string): SecretFinding | null {
  const tokens = [...text.matchAll(CASHU_TOKEN)].map(([, version, body]) => decodeCashu(version as "A" | "B", body));
  if (!tokens.length) return null;
  const unit = tokens.find((token) => token)?.unit ?? "sat";
  const readable = tokens.every((token) => token && token.unit === unit);
  return { kind: "cashu", amount: readable ? tokens.reduce((sum, token) => sum + token!.amount, 0) : null, unit };
}

/** What a Cashu token is worth, read from the token itself (NUT-00): nothing is asked of the mint. */
export function decodeCashu(version: "A" | "B", body: string): { amount: number; unit: string } | null {
  try {
    const bytes = fromBase64(body);
    if (version === "A") {
      const token = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { token?: { proofs?: { amount?: unknown }[] }[]; unit?: unknown };
      return total(token.token?.flatMap((entry) => entry.proofs ?? []).map((proof) => proof.amount), token.unit);
    }
    const token = decodeCbor(bytes) as { t?: { p?: { a?: unknown }[] }[]; u?: unknown } | null;
    return total(token?.t?.flatMap((entry) => entry.p ?? []).map((proof) => proof.a), token?.u);
  } catch {
    return null;
  }
}

function total(amounts: unknown[] | undefined, unit: unknown): { amount: number; unit: string } | null {
  if (!amounts?.length || !amounts.every((a): a is number => Number.isSafeInteger(a) && (a as number) >= 0)) return null;
  const amount = amounts.reduce((sum, a) => sum + a, 0);
  return Number.isSafeInteger(amount) ? { amount, unit: typeof unit === "string" && unit ? unit : "sat" } : null;
}

function fromBase64(text: string): Uint8Array {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Enough CBOR (RFC 8949) for a cashuB token: definite lengths, integers, bytes, text, arrays, maps, tags, simple values. */
function decodeCbor(bytes: Uint8Array): unknown {
  let at = 0, depth = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size || at + size > bytes.length) throw new Error("cbor");
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i];
    at += size;
    return value;
  };
  const item = (): unknown => {
    if (at >= bytes.length || ++depth > 32) throw new Error("cbor");
    const head = bytes[at++], major = head >> 5, info = head & 31;
    try {
      if (major === 7) {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { at += 2; return NaN; } // a half float: never in a token
        if (info === 26) { at += 4; return view.getFloat32(at - 4); }
        if (info === 27) { at += 8; return view.getFloat64(at - 8); }
        throw new Error("cbor");
      }
      const n = length(info);
      switch (major) {
        case 0: return n;
        case 1: return -1 - n;
        case 2: case 3: {
          if (at + n > bytes.length) throw new Error("cbor");
          const slice = bytes.subarray(at, (at += n));
          return major === 2 ? slice : new TextDecoder("utf-8", { fatal: true }).decode(slice);
        }
        case 4: {
          if (n > bytes.length - at) throw new Error("cbor");
          return Array.from({ length: n }, item);
        }
        case 5: {
          if (n > bytes.length - at) throw new Error("cbor");
          const map: Record<string, unknown> = Object.create(null);
          for (let i = 0; i < n; i++) { const key = item(); map[String(key)] = item(); }
          return map;
        }
        default: return item(); // a tag: the value it tags
      }
    } finally { depth--; }
  };
  return item();
}
