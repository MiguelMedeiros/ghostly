/**
 * Who plays white: a commit-reveal coin toss, so neither side picks its colour.
 *
 * 1. Each side draws a secret 32-byte salt and sends only its commitment, SHA-256("ghostly-chess/1 commit", 0, salt).
 * 2. A side reveals its salt only once it holds the other side's commitment, so the other salt is fixed before it
 *    can be seen.
 * 3. Both compute SHA-256("ghostly-chess/1 deal", 0, salt of the lower commitment, salt of the higher one). Its first
 *    8 bytes are the game id; the low bit of the 9th says whether the side with the lower commitment is white.
 *
 * Neither salt alone decides the result, and the salts travel in every catch-up (`sync`), so a side that kept its
 * own salt can check the colours the other side claims. What a toss cannot stop: a side that sees the result and
 * walks away before revealing can start over. The other side then draws a new salt (an old one is known by then)
 * and the app says the toss restarted, so the person sees it.
 *
 * SHA-256 is @noble/hashes in plain JavaScript: crypto.subtle needs a secure context, which an app frame or a
 * custom-scheme window may not be.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Colour } from "./protocol.ts";

export type Random = (bytes: number) => Uint8Array;

export const cryptoRandom: Random = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

const tagged = (tag: string, ...parts: Uint8Array[]) => {
  const head = utf8ToBytes(tag);
  const out = new Uint8Array(head.length + 1 + parts.reduce((n, p) => n + p.length, 0));
  out.set(head, 0);
  let at = head.length + 1;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return sha256(out);
};

/** A fresh secret salt, as hex. */
export function newSalt(random: Random = cryptoRandom): string {
  return bytesToHex(random(32));
}

/** The commitment to a salt, as hex. */
export function commitment(salt: string): string {
  return bytesToHex(tagged("ghostly-chess/1 commit", hexToBytes(salt)));
}

/** The game the two salts make, from one side's point of view. Throws when the salts are equal. */
export function deal(mySalt: string, peerSalt: string): { g: string; me: Colour } {
  const mine = commitment(mySalt);
  const theirs = commitment(peerSalt);
  if (mine === theirs) throw new Error("chess: both sides used the same salt");
  const meLow = mine < theirs;
  const [low, high] = meLow ? [mySalt, peerSalt] : [peerSalt, mySalt];
  const digest = tagged("ghostly-chess/1 deal", hexToBytes(low), hexToBytes(high));
  const lowIsWhite = (digest[8] & 1) === 0;
  return { g: bytesToHex(digest.subarray(0, 8)), me: meLow === lowIsWhite ? "w" : "b" };
}
