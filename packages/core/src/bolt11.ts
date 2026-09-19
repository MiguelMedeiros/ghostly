/**
 * Reads what a Lightning invoice (BOLT11) asks for, so a pasted invoice can be
 * shown as an amount and a description instead of a wall of characters. It
 * checks the bech32 checksum but not the signature: this is for display, the
 * wallet that pays is the one that must verify.
 */
export interface Bolt11Invoice {
  /** The invoice as it should be handed to a wallet: lower case, no `lightning:` prefix. */
  invoice: string;
  network: "bitcoin" | "testnet" | "signet" | "regtest";
  /** Null for an invoice that lets the payer choose the amount. */
  amountMsat: bigint | null;
  /** Rounded up to whole sats; null when the payer chooses. */
  amountSat: number | null;
  /** Seconds since the UNIX epoch. */
  createdAt: number;
  expiresAt: number;
  description?: string;
  paymentHash?: string;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const NETWORKS = { bc: "bitcoin", tb: "testnet", tbs: "signet", bcrt: "regtest" } as const;
const MSAT_PER_UNIT: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };
const SIGNATURE_WORDS = 104;
const CHECKSUM_WORDS = 6;
const TIMESTAMP_WORDS = 7;
const DEFAULT_EXPIRY = 3600;
const MAX_LENGTH = 7089;

/** Finds an invoice inside free text. The match still has to pass `decodeBolt11`. */
export const BOLT11_PATTERN = /(?:lightning:)?(ln(?:bcrt|tbs|bc|tb)[0-9]*[munp]?1[02-9ac-hj-np-z]{100,})/i;

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}

function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >>> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

function wordsToInt(words: number[]): number {
  return words.reduce((value, word) => value * 32 + word, 0);
}

/** Regroups 5-bit words into bytes, dropping the padding bits at the end. */
function wordsToBytes(words: number[]): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const word of words) {
    buffer = (buffer << 5) | word;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function decodeBolt11(text: string): Bolt11Invoice | null {
  const invoice = text.trim().toLowerCase().replace(/^lightning:/, "");
  if (invoice.length > MAX_LENGTH) return null;
  const separator = invoice.lastIndexOf("1");
  if (separator < 4) return null;

  const hrp = invoice.slice(0, separator);
  const prefix = /^ln(bcrt|tbs|bc|tb)(?:([0-9]+)([munp]?))?$/.exec(hrp);
  if (!prefix) return null;

  const words: number[] = [];
  for (const char of invoice.slice(separator + 1)) {
    const word = CHARSET.indexOf(char);
    if (word < 0) return null;
    words.push(word);
  }
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS + CHECKSUM_WORDS) return null;
  if (polymod([...expandHrp(hrp), ...words]) !== 1) return null;

  let amountMsat: bigint | null = null;
  if (prefix[2] !== undefined) {
    const digits = BigInt(prefix[2]);
    if (prefix[3] === "p") {
      // A pico-bitcoin is a tenth of a millisatoshi, so only multiples of ten exist.
      if (digits % 10n !== 0n) return null;
      amountMsat = digits / 10n;
    } else {
      amountMsat = digits * MSAT_PER_UNIT[prefix[3]];
    }
  }

  const data = words.slice(0, -(SIGNATURE_WORDS + CHECKSUM_WORDS));
  const createdAt = wordsToInt(data.slice(0, TIMESTAMP_WORDS));
  let expiry = DEFAULT_EXPIRY;
  let description: string | undefined;
  let paymentHash: string | undefined;

  for (let at = TIMESTAMP_WORDS; at + 3 <= data.length; ) {
    const tag = CHARSET[data[at]];
    const length = data[at + 1] * 32 + data[at + 2];
    const field = data.slice(at + 3, at + 3 + length);
    if (field.length < length) return null;
    at += 3 + length;

    if (tag === "d") {
      description = new TextDecoder().decode(wordsToBytes(field)).trim() || undefined;
    } else if (tag === "x") {
      expiry = wordsToInt(field);
    } else if (tag === "p" && length === 52) {
      paymentHash = [...wordsToBytes(field)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }

  return {
    invoice,
    network: NETWORKS[prefix[1] as keyof typeof NETWORKS],
    amountMsat,
    amountSat: amountMsat === null ? null : Number((amountMsat + 999n) / 1000n),
    createdAt,
    expiresAt: createdAt + expiry,
    description,
    paymentHash,
  };
}

/** The first valid invoice in a chat message, with whatever else the message says. */
export function findBolt11(text: string): { invoice: Bolt11Invoice; rest: string } | null {
  const match = BOLT11_PATTERN.exec(text);
  if (!match) return null;
  const invoice = decodeBolt11(match[1]);
  if (!invoice) return null;
  return { invoice, rest: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim() };
}
