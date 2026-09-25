import { inviteLink, readInviteCode, type InviteRefusal, type LinkParams } from "@ghostly/core";
import type { SessionKeys } from "./storage";

/**
 * Where a chat lives in the app: by the id of its stored session. The keys
 * stay in storage; an address ends up in the history, and with Chrome Sync on
 * other machines, so it must not carry them.
 */
export function chatPath(sessionId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}`;
}

/**
 * The keys a joined invite gives. Never a delivery mode: DHT only is a choice made in a chat (WISP 400), so a
 * `pair2d/` code joins like any other and the chat upgrades by itself; the inviter's choice arrives in its envelopes.
 */
function keysOf(params: LinkParams): SessionKeys {
  return {
    seedB64: params.seedB64, peerPubKeyB64: params.peerPubKeyZ32, encKeyB64: params.encKeyB64, profile: params.profile,
    ...(params.peerParticipationKeyZ32 ? { peerParticipationKeyB64: params.peerParticipationKeyZ32 } : {}),
  };
}

/** The invite a route carries, if it carries one: `/ghostly1…` (the hash of a shared link) or `/chat/<code>`. */
export function inviteRouteCode(pathname: string): string | null {
  return pathname.match(/^\/?(ghostly1[^/]*)$/i)?.[1] ?? pathname.match(/^\/chat\/(.+)$/)?.[1] ?? null;
}

/** What reading a pasted, scanned or opened invite gave: the keys, or the one reason the UI says. */
export type InviteInput = { ok: true; keys: SessionKeys } | { ok: false; reason: InviteRefusal };

/**
 * What someone may paste to join: an invite link (`https://ghostly.tools/#ghostly1…`,
 * `app.ghostly.tools/#…`, an older `#/chat/…` link), a `/chat/…` path or the bare code.
 */
export function readInvite(input: string): InviteInput {
  const trimmed = input.trim();
  const idx = trimmed.indexOf("/chat/");
  const reading = readInviteCode(!trimmed.includes("#") && idx !== -1 ? trimmed.slice(idx) : trimmed);
  return reading.ok ? { ok: true, keys: keysOf(reading.params) } : { ok: false, reason: reading.reason };
}

/** The keys of an invite, or null when it is refused (`readInvite` says why). */
export function parseInvite(input: string): SessionKeys | null {
  const reading = readInvite(input);
  return reading.ok ? reading.keys : null;
}

/** The message key for each refusal (WISP 801, "Reading an invite"). */
export const INVITE_REFUSAL_MESSAGE = {
  typo: "join.typo",
  update: "join.update",
  "not-ghostly": "join.notGhostly",
  damaged: "join.damaged",
} as const satisfies Record<InviteRefusal, string>;

export function buildInviteCode(
  seedB: string,
  pubKeyA: string,
  encKey: string,
): string {
  return `${seedB}/${pubKeyA}/${encKey}`;
}

/** A link for the other person: opening it joins the chat, and the app takes the keys out of the address at once. */
export function buildInviteUrl(
  origin: string,
  seedB: string,
  pubKeyA: string,
  encKey: string,
): string {
  return `${origin}/#/chat/${seedB}/${pubKeyA}/${encKey}`;
}

/**
 * The chat a `/chat/…` address points at, or null when the address is not a
 * chat or still carries the keys (`ChatLinkIntake` turns that one into this).
 */
export function chatRouteSession(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)\/?$/);
  // A `ghostly1` code is one segment too, but it is keys, never a session id.
  return match && !/^ghostly1/i.test(match[1]) ? decodeURIComponent(match[1]) : null;
}

/** What Copy and Share hand over: a `ghostly1` code as its link on ghostly.tools, an older code as it is. */
export function inviteShareText(code: string): string {
  return /^ghostly1/i.test(code) ? inviteLink(code) : code;
}
