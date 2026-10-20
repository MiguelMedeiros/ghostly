import { bech32, bech32m } from "@scure/base";
import { toZ32 } from "./bytes";
import { createIdentity, publicKeyFromZ32 } from "./identity";
import { DEVICE_INVITE_VERSION, INVITE_HRP, INVITE_MAX_LENGTH, INVITE_VERSION } from "./invite";
import { trimEndOf } from "./text";

/*
 * A contact link (WISP 8xx Contact Links): one link a person can post anywhere, naming nobody. It is a `ghostly1…`
 * code of version 3 (so every one starts `ghostly1r`) whose payload is 32 bytes, the link key: an Ed25519 public key
 * made for the link and for nothing else. Its seed stays on the owner's device. The chat reader and the device reader
 * still answer it as a newer version until the app reads contact links.
 */

/** The version symbol of a contact link (`r`): 1 is a chat's invite, 2 a device's code. */
export const CONTACT_LINK_VERSION = 3;
/** The payload: the link key alone. */
export const CONTACT_LINK_BYTES = 32;

/** Why a contact link was refused. `chat` and `device`: a code of the other kinds. The others as for an invite (WISP 801). */
export type ContactLinkRefusal = "typo" | "update" | "not-ghostly" | "damaged" | "chat" | "device";

export type ContactLinkReading = { ok: true; linkKeyZ32: string } | { ok: false; reason: ContactLinkRefusal; detail?: string };

/** The `ghostly1r…` code of the link with this key. */
export function encodeContactLink(linkKeyZ32: string): string {
  return bech32m.encode(INVITE_HRP, [CONTACT_LINK_VERSION, ...bech32m.toWords(publicKeyFromZ32(linkKeyZ32))], false);
}

/** The code inside whatever was pasted or scanned: after the last `#`, trimmed. */
const body = (input: string) => input.trim().replace(/^.*#/, "");

function read(input: string): ContactLinkReading {
  const code = body(input).toLowerCase();
  if (!code.startsWith(`${INVITE_HRP}1`)) return { ok: false, reason: "not-ghostly" };
  if (code.length > INVITE_MAX_LENGTH) return { ok: false, reason: "not-ghostly", detail: "Longer than 1,023 characters" };
  const decoded = bech32m.decodeUnsafe(code, INVITE_MAX_LENGTH);
  if (!decoded) {
    // A valid bech32 (not bech32m) checksum is another kind of string, not a typo.
    if (bech32.decodeUnsafe(code, INVITE_MAX_LENGTH)) return { ok: false, reason: "not-ghostly", detail: "bech32, not bech32m" };
    return { ok: false, reason: "typo" };
  }
  if (decoded.prefix !== INVITE_HRP) return { ok: false, reason: "typo" };
  const [version, ...words] = decoded.words;
  if (version === undefined || version === 0) return { ok: false, reason: "not-ghostly", detail: "Version 0 is reserved" };
  if (version > CONTACT_LINK_VERSION) return { ok: false, reason: "update", detail: `Version ${version}` };
  if (version === INVITE_VERSION) return { ok: false, reason: "chat" };
  if (version === DEVICE_INVITE_VERSION) return { ok: false, reason: "device" };
  const payload = bech32m.fromWordsUnsafe(words);
  if (!payload) return { ok: false, reason: "damaged", detail: "Padding" };
  if (payload.length !== CONTACT_LINK_BYTES) return { ok: false, reason: "damaged", detail: `${payload.length} bytes, not ${CONTACT_LINK_BYTES}` };
  return { ok: true, linkKeyZ32: toZ32(payload) };
}

/**
 * Reads a contact link, bare, in capitals from a QR code, or in a link (`https://ghostly.tools/#ghostly1r…`). Copied
 * from the end of a sentence, it is read once more without the punctuation, and taken only when that reads.
 */
export function readContactLink(input: string): ContactLinkReading {
  const reading = read(input);
  if (reading.ok) return reading;
  const bare = trimEndOf(input.trim(), ".,)!");
  if (bare !== input.trim()) {
    const again = read(bare);
    if (again.ok) return again;
  }
  return reading;
}

/** A new contact link: the owner keeps `seedB64` in its profile and hands out `code`. */
export function createContactLink(): { seedB64: string; linkKeyZ32: string; code: string } {
  const identity = createIdentity();
  return { seedB64: identity.seedB64, linkKeyZ32: identity.pubKeyZ32, code: encodeContactLink(identity.pubKeyZ32) };
}
