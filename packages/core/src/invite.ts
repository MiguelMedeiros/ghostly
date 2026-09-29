import { bech32, bech32m } from "@scure/base";
import { generateEncryptionKey } from "./crypto";
import { createIdentity, identityFromSeedB64 } from "./identity";
import { fromBase64Url, fromZ32, toBase64Url, toZ32 } from "./bytes";

/**
 * A link between two peers: my identity, the peer's public key and the shared
 * secretbox key. The slash forms are the invite formats of Ghostly 0.4
 * (`<seed>/<peer public key>/<encryption key>`) and of pre-0.5 builds
 * (`pair1/…`, `pair2d/…`); a current app reads them and makes only `ghostly1…`
 * codes (WISP 801).
 */
export interface LinkParams {
  profile?: "paired-chat/1";
  deliveryMode?: "stream" | "dht";
  seedB64: string;
  peerPubKeyZ32: string;
  encKeyB64: string;
  /**
   * The inviter's participation public key, carried by a `ghostly1` code: the
   * joiner pins the inviter from it before either path answers.
   */
  peerParticipationKeyZ32?: string;
  /**
   * The inviter's own participation seed, on the inviter's side only (the one
   * whose public key its invite carries). Never part of a code.
   */
  participationSeedB64?: string;
}

/** The human-readable part of every invite code: codes read `ghostly1…`. */
export const INVITE_HRP = "ghostly";
/** The format version this build makes; the first data symbol (`p`). */
export const INVITE_VERSION = 1;
/** Decoders refuse anything longer before computing a checksum (WISP 801 lifts bech32's 90). */
export const INVITE_MAX_LENGTH = 1023;
/** The canonical link host (Q11): the code travels in the fragment, never sent to a server. */
export const INVITE_LINK_ORIGIN = "https://ghostly.tools";
const V1_BYTES = 128;

/** Why a code was refused, each with the one message the UI shows for it. */
export type InviteRefusal = "typo" | "update" | "not-ghostly" | "damaged";

/** What reading a pasted or scanned invite gives: the chat's parameters, or why not. */
export type InviteReading =
  | { ok: true; params: LinkParams; format: "ghostly1" | "pair1" | "pair2d" | "legacy" }
  | { ok: false; reason: InviteRefusal; detail?: string };

/** The `ghostly1…` code of a new chat. `params` must carry the inviter's participation key. */
export function encodeGhostlyInvite(params: LinkParams): string {
  if (!params.peerParticipationKeyZ32) throw new Error("A ghostly1 invite needs the inviter's participation key");
  const payload = new Uint8Array(V1_BYTES);
  const fields = [fromBase64Url(params.seedB64), fromZ32(params.peerPubKeyZ32), fromBase64Url(params.encKeyB64), fromZ32(params.peerParticipationKeyZ32)];
  fields.forEach((field, index) => {
    if (field.length !== 32) throw new Error("Every field of a ghostly1 invite is 32 bytes");
    payload.set(field, index * 32);
  });
  return bech32m.encode(INVITE_HRP, [INVITE_VERSION, ...bech32m.toWords(payload)], false);
}

/**
 * The code for these parameters: `ghostly1…` when they carry the inviter's
 * participation key (every invite a current app makes), else the slash form
 * they were read from, so a stored older code round-trips.
 */
export function encodeInviteCode(params: LinkParams): string {
  if (params.peerParticipationKeyZ32) return encodeGhostlyInvite(params);
  return `${params.profile ? (params.deliveryMode === "dht" ? "pair2d/" : "pair1/") : ""}${params.seedB64}/${params.peerPubKeyZ32}/${params.encKeyB64}`;
}

/** `https://ghostly.tools/#ghostly1…`: the form an invite is shared in. */
export function inviteLink(code: string, origin = INVITE_LINK_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/#${code}`;
}

/** What goes in a QR code: upper case, so the code fits the alphanumeric mode. Older codes stay as they are. */
export function inviteQrText(code: string): string {
  return /^ghostly1/i.test(code) ? code.toUpperCase() : code;
}

/**
 * The QR segments of an invite's link, in capitals: `HTTPS://GHOSTLY.TOOLS/`
 * and the code in alphanumeric mode, the `#` between them in byte mode (QR
 * version 9 at level M). An encoder that takes a list of strings picks each
 * one's mode; one string with the `#` in it would be all bytes. Older codes
 * stay one segment, as they are.
 */
export function inviteQrSegments(code: string, origin = INVITE_LINK_ORIGIN): string[] {
  if (!/^ghostly1/i.test(code)) return [code];
  return [`${origin.replace(/\/+$/, "")}/`.toUpperCase(), "#", code.toUpperCase()];
}

/** The code inside whatever was pasted or scanned: after the last `#`, without a leading `chat/`. */
function inviteBody(input: string): string {
  return input.trim().replace(/^.*#/, "").replace(/^\/?chat\//, "");
}

function readGhostly(code: string): InviteReading {
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
  if (version !== INVITE_VERSION) return { ok: false, reason: "update", detail: `Version ${version}` };
  const payload = bech32m.fromWordsUnsafe(words);
  if (!payload) return { ok: false, reason: "damaged", detail: "Padding" };
  if (payload.length !== V1_BYTES) return { ok: false, reason: "damaged", detail: `${payload.length} bytes, not ${V1_BYTES}` };
  const field = (index: number) => payload.slice(index * 32, index * 32 + 32);
  return {
    ok: true,
    format: "ghostly1",
    params: {
      profile: "paired-chat/1",
      seedB64: toBase64Url(field(0)),
      peerPubKeyZ32: toZ32(field(1)),
      encKeyB64: toBase64Url(field(2)),
      peerParticipationKeyZ32: toZ32(field(3)),
    },
  };
}

const B64_KEY = /^[A-Za-z0-9_-]{43}$/;
const Z32_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

function readSlashForm(code: string): InviteReading {
  const dht = code.startsWith("pair2d/");
  const profile = (dht || code.startsWith("pair1/")) ? "paired-chat/1" as const : undefined;
  const parts = (profile ? code.slice(dht ? 7 : 6) : code).split("/");
  if (parts.length !== 3) {
    // A string of another kind (`npub1…`, `lnbc1…`, a word): not a Ghostly invite. A known prefix that lost a part: damaged.
    return profile ? { ok: false, reason: "damaged", detail: "Three fields expected" } : { ok: false, reason: "not-ghostly" };
  }
  const [seedB64, peerPubKeyZ32, encKeyB64] = parts;
  const bad = !B64_KEY.test(seedB64) ? "The seed" : !Z32_KEY.test(peerPubKeyZ32) ? "The contact's key" : !B64_KEY.test(encKeyB64) ? "The shared key" : null;
  if (bad) return { ok: false, reason: "damaged", detail: `${bad} is malformed` };
  return {
    ok: true,
    format: profile ? (dht ? "pair2d" : "pair1") : "legacy",
    params: { seedB64, peerPubKeyZ32, encKeyB64, ...(profile ? { profile, ...(dht ? { deliveryMode: "dht" as const } : {}) } : {}) },
  };
}

/**
 * Reads an invite by the rules of WISP 801: a `ghostly1…` code in any case, bare
 * or in a link (`https://ghostly.tools/#…`, `app.ghostly.tools/#…`), or one of
 * the older slash forms. A refused code is never retried as another format.
 */
export function readInviteCode(input: string): InviteReading {
  const code = inviteBody(input);
  if (!code) return { ok: false, reason: "not-ghostly" };
  if (/^ghostly1/i.test(code)) return readGhostly(code.toLowerCase());
  return readSlashForm(code);
}

/** The parameters of an invite, or null when it is refused (`readInviteCode` says why). */
export function decodeInviteCode(input: string): LinkParams | null {
  const reading = readInviteCode(input);
  return reading.ok ? reading.params : null;
}

/** Creates both ends of a link: keep `mine`, hand `invite` to the peer. */
export function createLink(): { mine: LinkParams; invite: LinkParams } {
  const a = createIdentity();
  const b = createIdentity();
  const encKeyB64 = toBase64Url(generateEncryptionKey());
  return {
    mine: { seedB64: a.seedB64, peerPubKeyZ32: b.pubKeyZ32, encKeyB64 },
    invite: { seedB64: b.seedB64, peerPubKeyZ32: a.pubKeyZ32, encKeyB64 },
  };
}

/**
 * A new chat, the way a current app makes one: `mine` keeps this side's
 * participation seed, `invite` carries its public key, and `inviteCode` is the
 * `ghostly1…` code to hand over.
 */
export function createChatInvite(): { mine: LinkParams; invite: LinkParams; inviteCode: string } {
  const { mine, invite } = createLink();
  const participation = createIdentity();
  const pairedMine: LinkParams = { ...mine, profile: "paired-chat/1", participationSeedB64: participation.seedB64 };
  const pairedInvite: LinkParams = { ...invite, profile: "paired-chat/1", peerParticipationKeyZ32: participation.pubKeyZ32 };
  return { mine: pairedMine, invite: pairedInvite, inviteCode: encodeGhostlyInvite(pairedInvite) };
}

/** A chat this side already has, as `inviteOwnership` reads it: its own seed and the contact's link key. */
export interface KnownLink {
  seedB64: string;
  peerPubKeyZ32: string;
}

/**
 * Whose invite a code is, among the chats a profile already has: `own` when this profile made it (the
 * invite's seed derives the contact key one of its chats waits for, which holds for every format, since
 * an inviter keeps the contact's public key), `joined` when this profile already joined by it (the
 * invite's seed is a chat's own), `new` otherwise. Another profile's chats are never passed, so its
 * invites read as new: two profiles on one app may chat with each other.
 */
export type InviteOwnership<T extends KnownLink> = { kind: "own" | "joined"; link: T } | { kind: "new" };

export function inviteOwnership<T extends KnownLink>(invite: Pick<LinkParams, "seedB64">, links: Iterable<T>): InviteOwnership<T> {
  const known = [...links];
  const joined = known.find((link) => link.seedB64 === invite.seedB64);
  if (joined) return { kind: "joined", link: joined };
  const inviteKey = identityFromSeedB64(invite.seedB64).pubKeyZ32;
  const own = known.find((link) => link.peerPubKeyZ32 === inviteKey);
  return own ? { kind: "own", link: own } : { kind: "new" };
}

const OWN_INVITE_PREFIX = "own-invite";

/**
 * A join refused because the invite is this profile's own (WISP 801 Q9). The message carries the reason
 * and the chat that owns the invite, so a client on the other side of an RPC (which gets the message and
 * nothing else) reads them back with `ownInviteRefusal`.
 */
export class OwnInviteError extends Error {
  readonly reason = OWN_INVITE_PREFIX;
  constructor(readonly linkId: string | null) {
    super(`${OWN_INVITE_PREFIX}${linkId ? ` ${linkId}` : ""}: This is your own invite. Share it with a contact; they join with it.`);
    this.name = "OwnInviteError";
  }
}

/** The refusal an error (or an error's message, as an RPC hands it over) carries, or null when it is another error. */
export function ownInviteRefusal(error: unknown): { linkId: string | null } | null {
  if (error instanceof OwnInviteError) return { linkId: error.linkId };
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = message.match(/^own-invite(?: (\S+))?: /);
  return match ? { linkId: match[1] ?? null } : null;
}
