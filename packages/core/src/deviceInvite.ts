import { bech32, bech32m } from "@scure/base";
import { fromBase64Url, fromZ32, toBase64Url, toZ32 } from "./bytes";
import { generateEncryptionKey } from "./crypto";
import { createIdentity, identityFromSeedB64 } from "./identity";
import { DEVICE_INVITE_VERSION, INVITE_HRP, INVITE_MAX_LENGTH, INVITE_VERSION, type LinkParams } from "./invite";

/*
 * The code that adds a device to a profile (WISP 06 § Adding a device): an invite of version 2, in the bech32m form of
 * WISP 800 (`ghostly1…`, version symbol 2, so every such code starts `ghostly1z`). It is not a chat invite: the chat
 * reader refuses it (`readInviteCode` answers `device`), and an app from before WISP 06 refuses it as a newer version.
 *
 * | Field                                       | Size     |
 * |---------------------------------------------|----------|
 * | One-time rendezvous seed for the joiner     | 32 bytes |
 * | One-time link key                           | 32 bytes |
 * | The inviter's one-time rendezvous key       | 32 bytes |
 * | The inviter's device signing key            | 32 bytes |
 * | Flags (bit 0: own device)                   | 1 byte   |
 * | Expires, UNIX seconds, big-endian           | 4 bytes  |
 *
 * The first three are the one-time link the enrollment session runs on, exactly as a chat invite's first three fields
 * are a chat's link. The fourth is what the joiner pins: the session's other end must be that key. Nothing in the code
 * is a long-lived secret: the device links are derived from `D`, which only the session hands over, after the digits.
 */

/** 4 fields of 32 bytes, the flags and the expiry. */
export const DEVICE_INVITE_BYTES = 133;
/** Bit 0 of the flags: the code adds a device to the inviter's own profile. The only kind there is. */
export const DEVICE_INVITE_OWN_DEVICE = 1;
/** How long a code is good for (WISP 06: the inviter enforces the 10 minutes). */
export const DEVICE_INVITE_LIFETIME_S = 600;

/** A device invite, as both sides hold it. Keys and seeds are the forms the link parameters use. */
export interface DeviceInvite {
  /** The joiner's one-time rendezvous seed, base64url. */
  joinerSeedB64: string;
  /** The one-time key that seals the session's rendezvous records, base64url. */
  linkKeyB64: string;
  /** The inviter's one-time rendezvous key, z-base-32. */
  inviterRendezvousZ32: string;
  /** The inviter's device signing key (Ed25519 public key, 32 bytes). */
  inviterKey: Uint8Array;
  flags: number;
  /** UNIX seconds. */
  expires: number;
}

/** Why a device code was refused. `chat`: it is a chat invite. `expired`: past its time. The others as for a chat invite (WISP 801). */
export type DeviceInviteRefusal = "typo" | "update" | "not-ghostly" | "damaged" | "chat" | "expired";

export type DeviceInviteReading = { ok: true; invite: DeviceInvite } | { ok: false; reason: DeviceInviteRefusal; detail?: string };

/** The `ghostly1z…` code of a device invite. */
export function encodeDeviceInvite(invite: DeviceInvite): string {
  const fields = [fromBase64Url(invite.joinerSeedB64), fromBase64Url(invite.linkKeyB64), fromZ32(invite.inviterRendezvousZ32), invite.inviterKey];
  const payload = new Uint8Array(DEVICE_INVITE_BYTES);
  fields.forEach((field, index) => {
    if (field.length !== 32) throw new Error("Every key of a device invite is 32 bytes");
    payload.set(field, index * 32);
  });
  if (!Number.isInteger(invite.flags) || invite.flags < 0 || invite.flags > 0xff) throw new Error("The flags are one byte");
  if (!Number.isInteger(invite.expires) || invite.expires < 0 || invite.expires > 0xffffffff) throw new Error("The expiry is 4 bytes of UNIX seconds");
  payload[128] = invite.flags;
  new DataView(payload.buffer).setUint32(129, invite.expires);
  return bech32m.encode(INVITE_HRP, [DEVICE_INVITE_VERSION, ...bech32m.toWords(payload)], false);
}

/** The code inside whatever was pasted or scanned: after the last `#`, trimmed. */
const body = (input: string) => input.trim().replace(/^.*#/, "").replace(/[.,)!]+$/, "");

/**
 * Reads a device code, pasted or scanned (bare, in capitals from a QR code, or after a `#`). `now` is in UNIX
 * seconds: a code past its expiry is refused here already, though only the inviter's word counts.
 */
export function readDeviceInvite(input: string, now: number = Math.floor(Date.now() / 1000)): DeviceInviteReading {
  const code = body(input).toLowerCase();
  if (!code.startsWith(`${INVITE_HRP}1`)) return { ok: false, reason: "not-ghostly" };
  if (code.length > INVITE_MAX_LENGTH) return { ok: false, reason: "not-ghostly", detail: "Longer than 1,023 characters" };
  const decoded = bech32m.decodeUnsafe(code, INVITE_MAX_LENGTH);
  if (!decoded) {
    if (bech32.decodeUnsafe(code, INVITE_MAX_LENGTH)) return { ok: false, reason: "not-ghostly", detail: "bech32, not bech32m" };
    return { ok: false, reason: "typo" };
  }
  if (decoded.prefix !== INVITE_HRP) return { ok: false, reason: "typo" };
  const [version, ...words] = decoded.words;
  if (version === undefined || version === 0) return { ok: false, reason: "not-ghostly", detail: "Version 0 is reserved" };
  // Newer than every version this reader knows (a chat's 1, a device's 2): a newer Ghostly made it.
  if (version > DEVICE_INVITE_VERSION) return { ok: false, reason: "update", detail: `Version ${version}` };
  if (version === INVITE_VERSION) return { ok: false, reason: "chat" };
  const payload = bech32m.fromWordsUnsafe(words);
  if (!payload) return { ok: false, reason: "damaged", detail: "Padding" };
  if (payload.length !== DEVICE_INVITE_BYTES) return { ok: false, reason: "damaged", detail: `${payload.length} bytes, not ${DEVICE_INVITE_BYTES}` };
  const flags = payload[128];
  // Bit 0 is the only kind of device invite there is. One without it is of a kind this build does not know.
  if (!(flags & DEVICE_INVITE_OWN_DEVICE)) return { ok: false, reason: "update", detail: `Flags ${flags}` };
  const expires = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(129);
  if (expires <= now) return { ok: false, reason: "expired" };
  const field = (index: number) => payload.slice(index * 32, index * 32 + 32);
  return {
    ok: true,
    invite: { joinerSeedB64: toBase64Url(field(0)), linkKeyB64: toBase64Url(field(1)), inviterRendezvousZ32: toZ32(field(2)), inviterKey: field(3), flags, expires },
  };
}

/** What the inviter keeps of a code it made: the invite, and its own end of the one-time link. Never written anywhere. */
export interface DeviceInviteSide {
  invite: DeviceInvite;
  code: string;
  /** The inviter's end: its one-time rendezvous seed, the joiner's rendezvous key, the link key. */
  params: LinkParams;
}

/** A new device code for the device with this signing key, good until `now + DEVICE_INVITE_LIFETIME_S`. */
export function createDeviceInvite(inviterKey: Uint8Array, now: number = Math.floor(Date.now() / 1000)): DeviceInviteSide {
  if (inviterKey.length !== 32) throw new Error("A device signing key is 32 bytes");
  const inviter = createIdentity(), joiner = createIdentity();
  const linkKeyB64 = toBase64Url(generateEncryptionKey());
  const invite: DeviceInvite = {
    joinerSeedB64: joiner.seedB64, linkKeyB64, inviterRendezvousZ32: inviter.pubKeyZ32, inviterKey: new Uint8Array(inviterKey),
    flags: DEVICE_INVITE_OWN_DEVICE, expires: now + DEVICE_INVITE_LIFETIME_S,
  };
  return {
    invite,
    code: encodeDeviceInvite(invite),
    params: { profile: "paired-chat/1", seedB64: inviter.seedB64, peerPubKeyZ32: joiner.pubKeyZ32, encKeyB64: linkKeyB64 },
  };
}

/** The joiner's end of the one-time link a device invite names. */
export function deviceInviteJoinerParams(invite: DeviceInvite): LinkParams {
  return { profile: "paired-chat/1", seedB64: invite.joinerSeedB64, peerPubKeyZ32: invite.inviterRendezvousZ32, encKeyB64: invite.linkKeyB64 };
}

/** The joiner's one-time rendezvous key: what the inviter's end of the link waits for. */
export const deviceInviteJoinerKeyZ32 = (invite: DeviceInvite): string => identityFromSeedB64(invite.joinerSeedB64).pubKeyZ32;
