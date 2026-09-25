import type { PeerLinkState } from "./platform";

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
export function servicesUnavailable(peer: PeerLinkState | null | undefined, name: string): string | null {
  switch (servicesBlock(peer)) {
    case "not-live": return "Shared apps open while you are connected live.";
    case "contact-older": return `${name} needs an updated Ghostly to open shared apps.`;
    case "contact-cannot": return `${name}'s app cannot open or share apps (the web app cannot reach local apps).`;
    default: return null;
  }
}
