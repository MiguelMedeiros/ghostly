import type { PeerLinkState } from "./platform";
import { englishT, type Translate } from "../locales/translate";

/** Why apps cannot travel in this chat right now, as a kind (`servicesUnavailable` says it in words). */
export type ServicesBlock = "not-live" | "contact-older" | "contact-cannot";

export function servicesBlock(peer: PeerLinkState | null | undefined): ServicesBlock | null {
  if (!peer?.sessionOffers || peer.capabilities?.services) return null;
  if (!peer.sessionOffers.mine.includes("services/1")) return null;
  if (peer.pairing?.status !== "ready" || peer.dataLink !== "open") return "not-live";
  if (!peer.sessionOffers.peer) return "contact-older";
  return "contact-cannot";
}

/**
 * Why apps cannot travel in this chat right now, if they cannot. A paired chat carries them over its live
 * session, once both apps offer `services/1`; an older chat has its own rules and says nothing here.
 */
export function servicesUnavailable(peer: PeerLinkState | null | undefined, name: string, tr: Translate = englishT): string | null {
  switch (servicesBlock(peer)) {
    case "not-live": return tr("chat.services.notLive");
    case "contact-older": return tr("chat.services.contactOlder", { name });
    case "contact-cannot": return tr("chat.services.contactCannot", { name });
    default: return null;
  }
}
