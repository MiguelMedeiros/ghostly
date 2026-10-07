import { presenceSeenAt, type DataLinkState, type PairingState, type PeerPresence } from "@ghostly/core";
import type { GroupEdgeCause, GroupEdgeView } from "../shared/types";

/** What the engine knows of one edge's link, enough to say how it is doing. */
export interface EdgeLive {
  stored: { id: string };
  link: { groupsSupport: boolean } | null;
  pairing?: PairingState;
  discoveryError?: string;
  dataLink: DataLinkState;
  presence: Pick<PeerPresence, "lastPacketAt" | "seenAt">;
  /** The last moment the edge was open (when it opened, or when it stopped being open). */
  lastSyncAt: number;
}

/**
 * An edge of a group as the group page shows it (WISP 902 § Mesh): open means group frames flow, which
 * is what "reachable" means everywhere else in groups; what carries it; when the member was last heard.
 */
export function edgeView(live: EdgeLive, now = Date.now(), noSlot = false): GroupEdgeView {
  const open = !!live.link?.groupsSupport;
  // Its member is reached over a native transport, and this device has no free native slot for it (WISP 902 § Transports).
  if (!open && noSlot) return { linkId: live.stored.id, state: "waiting", noSlot: true, lastSeenAt: Math.max(presenceSeenAt(live.presence), live.lastSyncAt) };
  const pairingError = live.pairing?.status === "error" ? live.pairing.error : undefined;
  const error = open ? undefined : pairingError ?? live.discoveryError;
  // Presence stays "online" for minutes after an app closes: only a channel being set up counts as connecting.
  const state = open ? "open" : error ? "error" : live.dataLink !== "idle" ? "connecting" : "waiting";
  return {
    linkId: live.stored.id, state,
    ...(open && live.pairing?.transport ? { transport: live.pairing.transport } : {}),
    lastSeenAt: open ? now : Math.max(presenceSeenAt(live.presence), live.lastSyncAt),
    ...(error ? { error, cause: pairingError ? edgeErrorCause(pairingError) : "relays" } : {}),
  };
}

/**
 * A pairing error the session ends with when nothing is wrong with the member: an attempt dialled again. Their
 * English is `PairedSession`'s and `GhostLink`'s (packages/core).
 */
// "Session frame too large" is no drop: the member's app broke the protocol (an `other`).
const SESSION_DROPS = [/^Session receive queue full$/, /^The peer did not finish authentication\b/, /^Invalid session negotiation$/];

/** What an edge's pairing error comes down to: the relays (its signal could not go out), a session dropped, or else. */
export function edgeErrorCause(error: string): GroupEdgeCause {
  if (error.startsWith("Could not publish connection details:") || /^Could not (publish|read) discovery:/.test(error)) return "relays";
  return SESSION_DROPS.some(drop => drop.test(error)) ? "session" : "other";
}
