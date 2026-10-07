import type { PeerLinkState } from "../platform";
import type { Translate } from "../../contexts/I18nContext";

/**
 * Why an app cannot talk to the same app on the contact's side right now (WISP 1200 § In a chat: `apps/1` goes on the
 * live session only, once both apps offer it), as a kind; `appsUnavailable` says it in words. Null when it can, and in
 * a chat that is not a paired one (it says nothing there).
 */
export type AppsBlock = "not-live" | "contact-older" | "contact-cannot";

export function appsBlock(peer: PeerLinkState | null | undefined): AppsBlock | null {
  const offers = peer?.sessionOffers;
  if (!offers || !offers.mine.includes("apps/1")) return null;
  if (offers.peer?.includes("apps/1") && peer.pairing?.status === "ready" && peer.dataLink === "open") return null;
  if (peer.pairing?.status !== "ready" || peer.dataLink !== "open") return "not-live";
  if (!offers.peer) return "contact-older";
  return "contact-cannot";
}

/** "Chess needs you both online", or why the contact's app cannot play, or null when it can. */
export function appsUnavailable(peer: PeerLinkState | null | undefined, title: string, name: string, t: Translate): string | null {
  switch (appsBlock(peer)) {
    case "not-live": return t("apps.card.needsOnline", { title });
    case "contact-older":
    case "contact-cannot": return t("apps.card.contactCannot", { name });
    default: return null;
  }
}
