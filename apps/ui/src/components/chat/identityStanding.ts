import type { EngineState } from "@ghostly/browser/shared/types";
import { badgeState, isGood, type BadgeState } from "../identities/contactBadges";
import { contactName } from "../../lib/identities";
import { chatNamesForPeer } from "../../lib/storage";

/**
 * What the chats say about an identity, read from the engine's state (nothing on the network): this profile's own
 * proof or Ghostly DID, or a contact who proved it, the chat the message is in first. A contact's proof keeps its badge
 * state (verified, expiring, revoked, failed, expired); a good one wins over the rest.
 */
export type IdentityStanding =
  | { kind: "own"; label: string; of: "did" | "proof" }
  | { kind: "contact"; state: BadgeState; who: string }
  | { kind: "none" };

export function identityStanding(state: EngineState | null | undefined, provider: string, subject: string, peerPubKey?: string): IdentityStanding {
  if (!state) return { kind: "none" };
  if (provider === "did" && state.did?.id === subject) return { kind: "own", label: "Your Ghostly DID", of: "did" };
  if (state.identityProofs.some(p => p.provider === provider && p.subject === subject)) return { kind: "own", label: "Your identity", of: "proof" };
  const links = [...state.links].sort((a, b) => Number(b.peerPubKeyZ32 === peerPubKey) - Number(a.peerPubKeyZ32 === peerPubKey));
  let best: { state: BadgeState; who: string } | undefined;
  for (const link of links) {
    const r = link.identities?.received.find(x => x.provider === provider && x.subject === subject);
    const badge = r && badgeState(r);
    if (!badge) continue;
    // Only a contact who proved it is named: a card nobody proved reads no chat.
    const name = contactName(chatNamesForPeer(link.peerPubKeyZ32));
    // "" for a contact with no name: the card says "a contact" in the app's language.
    const who = name ? `~${name}` : "";
    if (isGood(badge)) return { kind: "contact", state: badge, who };
    best ??= { state: badge, who };
  }
  return best ? { kind: "contact", ...best } : { kind: "none" };
}
