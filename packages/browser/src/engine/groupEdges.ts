import type { DataLinkState, PairingState, PeerPresence } from "@ghostly/core";
import type { GroupEdgeView } from "../shared/types";

/** What the engine knows of one edge's link, enough to say how it is doing. */
export interface EdgeLive {
  stored: { id: string };
  link: { groupsSupport: boolean } | null;
  pairing?: PairingState;
  discoveryError?: string;
  dataLink: DataLinkState;
  presence: Pick<PeerPresence, "lastPacketAt">;
  /** The last moment the edge was open (when it opened, or when it stopped being open). */
  lastSyncAt: number;
}

/**
 * An edge of a group as the group page shows it (WISP 9xx § Mesh): open means group frames flow, which
 * is what "reachable" means everywhere else in groups; what carries it; when the member was last heard.
 */
export function edgeView(live: EdgeLive, now = Date.now()): GroupEdgeView {
  const open = !!live.link?.groupsSupport;
  const error = open ? undefined : live.pairing?.status === "error" ? live.pairing.error : live.discoveryError;
  // Presence stays "online" for minutes after an app closes: only a channel being set up counts as connecting.
  const state = open ? "open" : error ? "error" : live.dataLink !== "idle" ? "connecting" : "waiting";
  return {
    linkId: live.stored.id, state,
    ...(open && live.pairing?.transport ? { transport: live.pairing.transport } : {}),
    lastSeenAt: open ? now : Math.max(live.presence.lastPacketAt, live.lastSyncAt),
    ...(error ? { error } : {}),
  };
}
