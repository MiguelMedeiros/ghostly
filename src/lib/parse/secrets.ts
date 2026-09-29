import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/**
 * What the composer asks about before a message goes: text that looks like a secret someone could take funds or an
 * identity with, or a Cashu token (bearer money: the text box would hand it to whoever reads the chat).
 *
 * Detection is local and synchronous, and a finding never carries the text it found: only what kind it is and, for
 * ecash, the amount decoded here. Ark, Spark and Fedimint wallets are BIP39 seeds or raw keys, caught by the rules
 * below; Fedimint ecash notes are plain base64 with no prefix, so they are not recognised.
 */
export type SecretFinding =
  | { kind: "mnemonic" | "nsec" | "bitcoin-key" | "hex-key" }
  | { kind: "cashu"; amount: number | null; unit: string };

export type SecretKind = SecretFinding["kind"];

const WORD_INDEX = new Map(wordlist.map((word, index) => [word, index]));
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];
/** Checksums tried per message at most: a 16 KiB run of seed words stays a few milliseconds. */
const CHECKSUM_BUDGET = 4096;

const NSEC = /\bnsec1[02-9ac-hj-np-z]{58}(?![02-9ac-hj-np-z])/i;
const EXTENDED_PRIVATE = /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,}/;
const WIF = /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const HEX_SECRET = /\b(?:0x)?(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64})\b/g;
const SECRET_CONTEXT = /priv(?:ate)?[\s_-]*key|secret|seed|mnemonic|nsec|xprv|\bwif\b|recovery|passphrase/i;
/** How far from a 64-hex string a word like "seed" still counts as saying what it is. */
const CONTEXT_REACH = 48;
const CASHU_TOKEN = /\bcashu([AB])([A-Za-z0-9_\-+/]{20,}={0,2})/g;

const base58check = createBase58check(sha256);

/** The first secret in `text`, keys and seeds before ecash; null for anything else. */
export function findSecret(text: string): SecretFinding | null {
  if (hasMnemonic(text)) return { kind: "mnemonic" };
  if (NSEC.test(text)) return { kind: "nsec" };
  if (EXTENDED_PRIVATE.test(text) || hasWif(text)) return { kind: "bitcoin-key" };
  if (hasHexSecret(text)) return { kind: "hex-key" };
  return findCashu(text);
}

/**
 * 12 to 24 words in a row from the English BIP39 list whose checksum holds, anywhere in the text; or a message that
 * is nothing but 12, 15, 18, 21 or 24 of those words (a seed with one word mistyped is still most of a seed). Prose
 * breaks a run at once: "the", "a", "is", "to", "and", "of" and "I" are not on the list.
 */
function hasMnemonic(text: string): boolean {
  const tokens = text.toLowerCase().match(/[a-z]+/g);
  if (!tokens || tokens.length < 12) return false;
  let budget = CHECKSUM_BUDGET;
  let run: number[] = [];
  const check = () => {
    if (run.length >= 12) {
      for (const length of MNEMONIC_LENGTHS) {
        for (let start = 0; start + length <= run.length && budget > 0; start++, budget--) {
          if (checksumHolds(run.slice(start, start + length))) return true;
        }
      }
      if (run.length === tokens.length && MNEMONIC_LENGTHS.includes(run.length)) return true;
    }
    run = [];
    return false;
  };
  for (const token of tokens) {
    const index = WORD_INDEX.get(token);
    if (index !== undefined) run.push(index);
    else if (check()) return true;
  }
  return check();
}

/** BIP39: the words' 11-bit indices are the entropy followed by the first bits of its SHA-256. */
function checksumHolds(indices: number[]): boolean {
  const bits = indices.length * 11, checksumBits = bits / 33, entropyBytes = (bits - checksumBits) / 8;
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  indices.forEach((index, i) => {
    for (let b = 0; b < 11; b++) if (index & (1 << (10 - b))) { const at = i * 11 + b; bytes[at >> 3] |= 0x80 >> (at & 7); }
  });
  const expected = sha256(bytes.subarray(0, entropyBytes))[0] >> (8 - checksumBits);
  const got = bytes[entropyBytes] >> (8 - checksumBits);
  return expected === got;
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

/** 64 or 128 hex digits with "private key", "secret", "seed" or the like close by. A bare hash is not asked about. */
function hasHexSecret(text: string): boolean {
  for (const match of text.matchAll(HEX_SECRET)) {
    const before = text.slice(Math.max(0, match.index - CONTEXT_REACH), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + CONTEXT_REACH);
    if (SECRET_CONTEXT.test(before) || SECRET_CONTEXT.test(after)) return true;
  }
  return false;
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
