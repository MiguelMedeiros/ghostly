import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesEqual, concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Decode, utf8Encode } from "./bytes";
import { identityFromSeed, publicKeyFromZ32 } from "./identity";
import type { LinkParams } from "./invite";

/**
 * The cryptography of the `group-mesh/1` profile (WISP 900 / 9xx group mesh).
 *
 * One random 32-byte **epoch secret** per membership state. It never travels in
 * the clear: the committer seals it to each member of the new roster with an
 * ephemeral X25519 key against the member's Ed25519 member key. From it come
 * the message key of the epoch and the key of the confirmation tag that binds
 * the secret to its commit. Messages are XChaCha20-Poly1305 with the epoch
 * message key and the message header as associated data, and are signed by
 * the sender's member key, since the message key alone is shared by everyone.
 *
 * This is not MLS: there is no ratchet tree, member keys are static for the
 * life of the group, and the only source of post-compromise security is a
 * fresh random secret that a removed member is never sent.
 */
export const GROUP_PROFILE = "group-mesh/1" as const;
const NONCE_LENGTH = 24;

const info = (label: string) => utf8Encode(`ghostly-group/1 ${label}`);

/** The keys of one epoch, from its secret. */
export function epochKeys(secret: Uint8Array, groupId: string, epoch: number): { message: Uint8Array; confirm: Uint8Array } {
  if (secret.length !== 32) throw new Error("Invalid epoch secret");
  const salt = utf8Encode(`${groupId}/${epoch}`);
  return { message: hkdf(sha256, secret, salt, info("message"), 32), confirm: hkdf(sha256, secret, salt, info("confirm"), 32) };
}

export function newEpochSecret(): Uint8Array { return randomBytes(32); }

export interface SealedSecret { e: string; n: string; c: string }

/** The epoch secret for one member: an ephemeral X25519 exchange against the member's Ed25519 key. */
export function sealSecret(recipientZ32: string, secret: Uint8Array, aad: string): SealedSecret {
  const ephemeral = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeral);
  const recipient = ed25519.utils.toMontgomery(publicKeyFromZ32(recipientZ32));
  const key = sealKey(x25519.getSharedSecret(ephemeral, recipient), ephemeralPublic, recipientZ32);
  const nonce = randomBytes(NONCE_LENGTH);
  return { e: toBase64Url(ephemeralPublic), n: toBase64Url(nonce), c: toBase64Url(xchacha20poly1305(key, nonce, utf8Encode(aad)).encrypt(secret)) };
}

/** Null when the box was not sealed to this seed with this associated data. */
export function openSecret(mySeed: Uint8Array, myZ32: string, sealed: SealedSecret, aad: string): Uint8Array | null {
  try {
    const ephemeralPublic = fromBase64Url(sealed.e), nonce = fromBase64Url(sealed.n), box = fromBase64Url(sealed.c);
    if (ephemeralPublic.length !== 32 || nonce.length !== NONCE_LENGTH) return null;
    const key = sealKey(x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(mySeed), ephemeralPublic), ephemeralPublic, myZ32);
    const secret = xchacha20poly1305(key, nonce, utf8Encode(aad)).decrypt(box);
    return secret.length === 32 ? secret : null;
  } catch { return null; }
}

function sealKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientZ32: string): Uint8Array {
  return hkdf(sha256, shared, ephemeralPublic, concatBytes(info("seal"), utf8Encode(recipientZ32)), 32);
}

/**
 * Something for one member only, from another, inside a frame the whole group carries (`group-community/1`
 * pair payloads: payments between two members relayed by hubs). The key mixes an ephemeral X25519 exchange
 * against the recipient's member key with the static exchange between sender and recipient: only the
 * recipient can open it, only the sender (or the recipient) can have made it, and a later leak of the
 * sender's seed alone opens nothing. The associated data binds it to the frame that carries it.
 */
export function sealPair(senderSeed: Uint8Array, senderZ32: string, recipientZ32: string, plaintext: Uint8Array, aad: string): SealedSecret {
  const ephemeral = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeral);
  const recipient = ed25519.utils.toMontgomery(publicKeyFromZ32(recipientZ32));
  const key = pairKey(x25519.getSharedSecret(ephemeral, recipient), x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(senderSeed), recipient), ephemeralPublic, senderZ32, recipientZ32);
  const nonce = randomBytes(NONCE_LENGTH);
  return { e: toBase64Url(ephemeralPublic), n: toBase64Url(nonce), c: toBase64Url(xchacha20poly1305(key, nonce, utf8Encode(aad)).encrypt(plaintext)) };
}

/** Null unless `senderZ32` sealed it to this seed with this associated data. */
export function openPair(mySeed: Uint8Array, myZ32: string, senderZ32: string, sealed: SealedSecret, aad: string): Uint8Array | null {
  try {
    const ephemeralPublic = fromBase64Url(sealed.e), nonce = fromBase64Url(sealed.n);
    if (ephemeralPublic.length !== 32 || nonce.length !== NONCE_LENGTH) return null;
    const mine = ed25519.utils.toMontgomerySecret(mySeed);
    const key = pairKey(x25519.getSharedSecret(mine, ephemeralPublic), x25519.getSharedSecret(mine, ed25519.utils.toMontgomery(publicKeyFromZ32(senderZ32))), ephemeralPublic, senderZ32, myZ32);
    return xchacha20poly1305(key, nonce, utf8Encode(aad)).decrypt(fromBase64Url(sealed.c));
  } catch { return null; }
}

function pairKey(ephemeralShared: Uint8Array, staticShared: Uint8Array, ephemeralPublic: Uint8Array, senderZ32: string, recipientZ32: string): Uint8Array {
  return hkdf(sha256, concatBytes(ephemeralShared, staticShared), ephemeralPublic, concatBytes(utf8Encode("ghostly-group/2 pair"), utf8Encode(senderZ32), utf8Encode(recipientZ32)), 32);
}

/** Text under the epoch message key, bound to its header. */
export function encryptText(messageKey: Uint8Array, aad: string, text: string): { n: string; c: string } {
  const nonce = randomBytes(NONCE_LENGTH);
  return { n: toBase64Url(nonce), c: toBase64Url(xchacha20poly1305(messageKey, nonce, utf8Encode(aad)).encrypt(utf8Encode(text))) };
}

export function decryptText(messageKey: Uint8Array, aad: string, nonceB64: string, boxB64: string): string | null {
  try {
    const nonce = fromBase64Url(nonceB64);
    if (nonce.length !== NONCE_LENGTH) return null;
    return utf8Decode(xchacha20poly1305(messageKey, nonce, utf8Encode(aad)).decrypt(fromBase64Url(boxB64)));
  } catch { return null; }
}

/** Proves the committer holds the secret the commit distributes: HMAC of the commit's untagged hash. */
export function confirmationTag(confirmKey: Uint8Array, untaggedHashHex: string): string {
  return toBase64Url(hmac(sha256, confirmKey, utf8Encode(untaggedHashHex)));
}
export function confirmationMatches(confirmKey: Uint8Array, untaggedHashHex: string, tag: string): boolean {
  try { return bytesEqual(fromBase64Url(tag), hmac(sha256, confirmKey, utf8Encode(untaggedHashHex))); } catch { return false; }
}

export function sha256Hex(data: Uint8Array): string {
  return Array.from(sha256(data), b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The pairwise link two members of a group run between them, derived by both
 * from the X25519 secret of their member keys and nothing else: rendezvous
 * identities for each side and the symmetric key of their discovery records.
 * No third party, the admin included, can compute it; a member who left keeps
 * only the edges it was part of, and those are closed by the remaining side.
 */
export function edgeParams(groupId: string, mySeed: Uint8Array, myZ32: string, peerZ32: string): LinkParams {
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(mySeed), ed25519.utils.toMontgomery(publicKeyFromZ32(peerZ32)));
  const salt = utf8Encode(groupId);
  const seed = (owner: string) => hkdf(sha256, shared, salt, concatBytes(info("edge seed"), utf8Encode(owner)), 32);
  return {
    seedB64: toBase64Url(seed(myZ32)),
    peerPubKeyZ32: identityFromSeed(seed(peerZ32)).pubKeyZ32,
    encKeyB64: toBase64Url(hkdf(sha256, shared, salt, info("edge key"), 32)),
    profile: "paired-chat/1",
  };
}
