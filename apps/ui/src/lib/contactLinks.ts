import { encodeContactLink, readContactLink } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { ensureSession, findSession, updateSessionLabel } from "./storage";

/**
 * A chat the engine made by itself for a contact link (WISP 8xx: a request accepted, or one sent through someone's
 * link), taken into this app's chat list as a chat the app made: the app keeps its own list of chats, and drops a
 * link that has none (`platform/sync.ts`). The chat's id here, for its address.
 */
export async function adoptEngineChat(linkId: string): Promise<string> {
  const peer = engine.state?.links.find((l) => l.id === linkId)?.peerPubKeyZ32;
  const link = (await engine.call("exportLinks")).find((l) => l.peerPubKeyZ32 === peer);
  if (!peer || !link) throw new Error("The chat was not made. Try again.");
  const existing = findSession(link.seedB64, link.peerPubKeyZ32);
  const id = existing?.id ?? ensureSession(
    { profile: link.profile, deliveryMode: link.deliveryMode, seedB64: link.seedB64, peerPubKeyB64: link.peerPubKeyZ32, encKeyB64: link.encKeyB64 },
    { inviteCode: link.inviteCode, createdAt: link.createdAt },
  );
  if (!existing && link.label) updateSessionLabel(id, link.label);
  window.dispatchEvent(new Event("session-updated"));
  return id;
}

/** Said on `window` when a contact link was opened or pasted: the request form takes it (`takeContactLink`). */
export const CONTACT_LINK_EVENT = "ghostly-contact-link";
let pending: string | null = null;

/** Whether this text is someone's contact link (`ghostly1r…`, bare or in a link), not a chat invite. */
export function isContactLink(value: string): boolean {
  return readContactLink(value).ok;
}

/** Hands a contact link to the request form. Opening it sends nothing: the person writes and taps Send. */
export function offerContactLink(value: string): void {
  const reading = readContactLink(value);
  // The code alone: a link's host and anything around it go no further.
  pending = reading.ok ? encodeContactLink(reading.linkKeyZ32) : value.trim();
  window.dispatchEvent(new Event(CONTACT_LINK_EVENT));
}

/** The contact link handed over, once. */
export function takeContactLink(): string | null {
  const value = pending;
  pending = null;
  return value;
}
