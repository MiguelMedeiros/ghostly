import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual, concatBytes, fromBase64Url, randomBytes, toBase64Url, toZ32, utf8Encode } from "./bytes";
import { identityFromSeed, verify } from "./identity";
import type { LinkParams } from "./invite";
import type { PairingCredentials } from "./pairedSession";
import type { Signer } from "./signer";

/*
 * Device links (WISP 06 § Terms): the channel between two of a person's devices. It is an ordinary paired session
 * whose keys nobody exchanged: both ends derive them from the device-set secret `D` and the two device signing keys.
 * So any two enrolled devices have a link without ever having met, and a device that does not hold the current `D`
 * has none: under another `D` every key below is another key.
 *
 * - `linkSecret = HKDF-SHA256(ikm = D, salt = "ghostly-devices/1", info = "link" || lowerKey || higherKey, 32)`;
 * - each side's rendezvous seed: `HKDF-SHA256(linkSecret, salt, info = "rv" || ownSigningKey, 32)`;
 * - the key that seals the link's records: `HKDF-SHA256(linkSecret, salt, info = "enc", 32)`.
 *
 * The WISP names no salt for the last two; the device set's own (`ghostly-devices/1`) is used, and the vectors in
 * `packages/core/test/vectors/device-links.json` pin it. "Lower" and "higher" compare the two 32-byte keys as bytes.
 *
 * Each side's participation key is its device signing key, pinned from the turn record: a holder of `D` can compute
 * both rendezvous seeds and so disturb the rendezvous, and cannot pass the session's authentication without a device
 * signing key. Nothing here touches the network.
 */

const SALT = utf8Encode("ghostly-devices/1");

/**
 * A new device-set secret `D`: 32 random bytes (WISP 06 § Terms). The first `D` of a profile is not random, it comes
 * from the DID key's seed (`firstDeviceSetSecret`); every later one, made when a device is removed, is.
 */
export const newDeviceSetSecret = (): Uint8Array => randomBytes(32);

/** -1, 0 or 1: two keys compared as bytes. */
function compareKeys(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function checkKeys(d: Uint8Array, a: Uint8Array, b: Uint8Array): void {
  if (d.length !== 32) throw new Error("The device-set secret is 32 bytes");
  if (a.length !== 32 || b.length !== 32) throw new Error("A device signing key is 32 bytes");
  if (bytesEqual(a, b)) throw new Error("A device has no link with itself");
}

/** The secret of the link between two devices of the set that holds `D`. The same whichever key is given first. */
export function deviceLinkSecret(d: Uint8Array, keyA: Uint8Array, keyB: Uint8Array): Uint8Array {
  checkKeys(d, keyA, keyB);
  const [lower, higher] = compareKeys(keyA, keyB) < 0 ? [keyA, keyB] : [keyB, keyA];
  return hkdf(sha256, d, SALT, concatBytes(utf8Encode("link"), lower, higher), 32);
}

/** One side's rendezvous seed on a link: the identity its packets of that link are published under. */
export function deviceLinkRendezvousSeed(linkSecret: Uint8Array, signingKey: Uint8Array): Uint8Array {
  return hkdf(sha256, linkSecret, SALT, concatBytes(utf8Encode("rv"), signingKey), 32);
}

/** The key that seals the link's discovery records. */
export function deviceLinkSealKey(linkSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, linkSecret, SALT, utf8Encode("enc"), 32);
}

/**
 * The link from the device with `ownKey` to the one with `peerKey`, as a paired link's parameters: this side's
 * rendezvous seed, the other side's rendezvous key, and the shared sealing key.
 */
export function deviceLinkParams(d: Uint8Array, ownKey: Uint8Array, peerKey: Uint8Array): LinkParams {
  const secret = deviceLinkSecret(d, ownKey, peerKey);
  return {
    seedB64: toBase64Url(deviceLinkRendezvousSeed(secret, ownKey)),
    peerPubKeyZ32: identityFromSeed(deviceLinkRendezvousSeed(secret, peerKey)).pubKeyZ32,
    encKeyB64: toBase64Url(deviceLinkSealKey(secret)),
    profile: "paired-chat/1",
  };
}

/** A device signing key as a session names a participation key (z-base-32). */
export const deviceKeyZ32 = (signingKey: Uint8Array): string => toZ32(signingKey);

/*
 * A device link's transports in its own packet (`_tr`, as a group's link has them): which layer-1 transports the app
 * runs and how to dial its native ones. The packet is published under a key derived from `D`, so any holder of `D`
 * could write a `_tr` there: endpoints of its own, or "no WebRTC", and stall the link. So on a device link the value
 * is signed with the device signing key, over the two rendezvous keys and the value, and a reader takes only one
 * signed by the key it pinned.
 */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const transportsMessage = (from: string, to: string, t: unknown, d: unknown) =>
  utf8Encode(JSON.stringify(["ghostly-device-transports", 1, from, to, t, d ?? null]));

/** A `_tr` value signed by this device: `{"t":…,"d":…,"s":"<signature>"}`. `from`/`to`: the link's two rendezvous keys, this side's first. */
export async function signDeviceTransports(value: string, signer: Signer, from: string, to: string): Promise<string> {
  const parsed = JSON.parse(value) as { t?: unknown; d?: unknown };
  const signature = await signer.sign(transportsMessage(from, to, parsed.t, parsed.d));
  return JSON.stringify({ t: parsed.t, d: parsed.d, s: toBase64Url(signature) });
}

/** The unsigned `_tr` value of one signed by `signingKey`, or null for anything else (unsigned, another key, another link). */
export function verifyDeviceTransports(value: string, from: string, to: string, signingKey: Uint8Array): string | null {
  try {
    if (value.length > 1_200) return null;
    const parsed = JSON.parse(value) as { t?: unknown; d?: unknown; s?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.s !== "string" || !SIGNATURE.test(parsed.s)) return null;
    if (!verify(fromBase64Url(parsed.s), transportsMessage(from, to, parsed.t, parsed.d), signingKey)) return null;
    return JSON.stringify({ t: parsed.t, d: parsed.d });
  } catch { return null; }
}

/** What a paired link needs to be a device link: its derived parameters and its pinned, signer-backed pairing. */
export interface DeviceLinkPairing {
  params: LinkParams;
  pairing: { credentials: PairingCredentials; pinPeer: (key: string) => Promise<void>; trustOnFirstUse: false };
}

/**
 * The link from this device (its signer) to the device with `peerKey`, ready for a `GhostLink`. The other device's
 * signing key is pinned before anything is said, as the turn record names it: there is nothing to trust on first
 * use, and no other key is ever saved in its place. Signals in the link's packets must be signed by that key too.
 */
export function deviceLinkPairing(d: Uint8Array, signer: Signer, peerKey: Uint8Array): DeviceLinkPairing {
  const peer = deviceKeyZ32(peerKey);
  return {
    params: deviceLinkParams(d, signer.publicKey, peerKey),
    pairing: {
      credentials: { seedB64: "", signer, peerKey: peer, expectedPeerKey: peer, verifiedPeerKey: peer, requireSignedSignals: true },
      pinPeer: async (key) => { if (key !== peer) throw new Error("Not the device this link belongs to"); },
      trustOnFirstUse: false,
    },
  };
}

/*
 * Frames. Everything two devices say to each other travels on a device link only, under a capability that only
 * device links offer (WISP 06 § Removing a device, § Frames, § Adding a device). A frame's `t` says which:
 *
 * | `t` starts with | Capability   | Part of the WISP                   |
 * |-----------------|--------------|------------------------------------|
 * | `device-`       | `devices/1`  | the link itself (ping and echo)    |
 * | `set-`          | `devices/1`  | removing a device                  |
 * | `handoff-`      | `handoff/1`  | the handoff                        |
 * | `enroll-`       | `enroll/1`   | adding a device                    |
 *
 * A frame is handed on only when both ends announced its capability on the open session, so a chat (which offers
 * none of them) drops every one. The frames carry no message id, as other session frames that older apps drop.
 * This part offers `devices/1` and defines `device-ping` and `device-echo`; the others are the later parts'.
 */
export const DEVICES_CAPABILITY = "devices/1";
export const HANDOFF_CAPABILITY = "handoff/1";
export const ENROLL_CAPABILITY = "enroll/1";
export type DeviceCapability = typeof DEVICES_CAPABILITY | typeof HANDOFF_CAPABILITY | typeof ENROLL_CAPABILITY;
export const DEVICE_CAPABILITIES: readonly DeviceCapability[] = [DEVICES_CAPABILITY, HANDOFF_CAPABILITY, ENROLL_CAPABILITY];

const FRAME_PREFIXES: readonly [string, DeviceCapability][] = [
  ["device-", DEVICES_CAPABILITY], ["set-", DEVICES_CAPABILITY], ["handoff-", HANDOFF_CAPABILITY], ["enroll-", ENROLL_CAPABILITY],
];

/** The capability a frame of this type travels under, or null when it is no device frame. */
export function deviceFrameCapability(type: unknown): DeviceCapability | null {
  if (typeof type !== "string") return null;
  return FRAME_PREFIXES.find(([prefix]) => type.startsWith(prefix) && type.length > prefix.length)?.[1] ?? null;
}

/** A frame between two devices: `t` names it, the rest is its body. */
export interface DeviceFrame {
  t: string;
  [field: string]: unknown;
}

export const DEVICE_PING_FRAME = "device-ping";
export const DEVICE_ECHO_FRAME = "device-echo";
const PING_NONCE = /^[A-Za-z0-9_-]{22}$/;

/** `{"t":"device-ping","n":"<16 random bytes, base64url>"}`: asks the other device to say the nonce back. */
export function devicePingFrame(nonce: Uint8Array = randomBytes(16)): DeviceFrame & { n: string } {
  if (nonce.length !== 16) throw new Error("A ping's nonce is 16 bytes");
  return { t: DEVICE_PING_FRAME, n: toBase64Url(nonce) };
}

/** The echo of a ping, or null when the frame is not a well-formed ping. */
export function deviceEchoFrame(ping: DeviceFrame): (DeviceFrame & { n: string }) | null {
  if (ping.t !== DEVICE_PING_FRAME || typeof ping.n !== "string" || !PING_NONCE.test(ping.n)) return null;
  return { t: DEVICE_ECHO_FRAME, n: ping.n };
}

/** The nonce an echo says back, or null when the frame is not a well-formed echo. */
export function deviceEchoNonce(frame: DeviceFrame): string | null {
  return frame.t === DEVICE_ECHO_FRAME && typeof frame.n === "string" && PING_NONCE.test(frame.n) ? frame.n : null;
}
