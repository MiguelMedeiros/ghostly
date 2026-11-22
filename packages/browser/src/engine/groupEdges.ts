import { PRESENCE_WINDOW, presenceSeenAt, type DataLinkState, type PairingState, type PeerPresence } from "@ghostly/core";
import type { GroupEdgeCause, GroupEdgeView } from "../shared/types";

/** What the engine knows of one edge's link, enough to say how it is doing. */
export interface EdgeLive {
  /** `edgeLive`: the edge was live when the app last ran. */
  stored: { id: string; edgeLive?: boolean };
  link: { groupsSupport: boolean; liveAttempt?: { retryAt?: number }; dialAttempts?: number } | null;
  pairing?: PairingState;
  discoveryError?: string;
  dataLink: DataLinkState;
  presence: Pick<PeerPresence, "lastPacketAt" | "seenAt">;
  /** The last moment the edge was open (when it opened, or when it stopped being open). */
  lastSyncAt: number;
  /** When the edge's link started in this run. */
  edgeStartedAt?: number;
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
  const cause = error ? (pairingError ? edgeErrorCause(pairingError) : "relays") : undefined;
  // Live before, in this run or when the app last ran, and down for nothing the app can't get past: it dials again by
  // itself (WISP 100 § Background retry), and the page says so rather than asking for a tap.
  // Only while the member is seen (its packet, or the drop, within presence's window): one not seen is not dialled, and
  // a member whose app closed days ago is last seen then, not "Reconnecting…" for good. Back after a restart, before
  // anything of the member is read, the resume dial is under way (WISP 100 § Back after a restart), for presence's
  // window from the link's start: past it, no read found a packet (the member's app closed longer than the relays keep
  // one), nothing is dialled, and the row said "Reconnecting…" for good.
  const heardAt = Math.max(presenceSeenAt(live.presence), live.lastSyncAt);
  const seen = heardAt > 0 ? now - heardAt < PRESENCE_WINDOW : !!live.stored.edgeLive && now - (live.edgeStartedAt ?? now) < PRESENCE_WINDOW;
  const reconnecting = !open && seen && (live.lastSyncAt > 0 || !!live.stored.edgeLive) && cause !== "other";
  const retryAt = reconnecting ? live.link?.liveAttempt?.retryAt : undefined;
  const attempt = reconnecting ? live.link?.dialAttempts ?? 0 : 0;
  return {
    linkId: live.stored.id, state,
    ...(open && live.pairing?.transport ? { transport: live.pairing.transport } : {}),
    // Open, it is heard all along: not "now", which made each engine state a change of every group with a member
    // connected (the chat list drew those rows again each time). Nothing shows it while open; closed, it is the close.
    lastSeenAt: heardAt,
    ...(error ? { error, cause } : {}),
    ...(reconnecting ? { reconnecting: true as const } : {}),
    ...(retryAt && retryAt > now ? { retryAt } : {}),
    ...(attempt > 0 ? { attempt } : {}),
  };
}

/**
 * The member whose edge a member of a private group keeps while the group is not on screen (WISP 902 § Transports,
 * revision 2026-11-04), from the roster in admission order (`GroupSession.admissionOrder`, the creator first): the
 * member admitted just before it, which it knows from its welcome. The first member keeps the edge to the second,
 * which keeps the same one: the one member every later member knows from its welcome, so the roster it learns there
 * reaches everyone (a member's edge to the newest would bring nothing: the newest knew it all, and nobody knows it
 * yet). The newest keeps the edge to the admin, which admitted it and so knows it at once (to the first member where
 * the admin is the newest); the admin answers it as one a member keeps (`chosenByPeer`). So the edges kept make a tree
 * over the whole roster (connected, N - 1 edges, each member on two of them at most, the admin on three where it is
 * not the first), both ends compute the same one from the same roster, and a join or a leave changes what two
 * members keep at most. Undefined when `me` is not in it or nobody else is.
 */
export function keptMeshPeer(order: readonly string[], admin: string | undefined, me: string): string | undefined {
  const at = order.indexOf(me), last = order.length - 1;
  if (at < 0 || last < 1) return undefined;
  if (at === 0) return order[1];
  if (at < last) return order[at - 1];
  return admin !== undefined && admin !== me && order.includes(admin) ? admin : order[0];
}

/** The members whose kept edge (`keptMeshPeer`) is the one to `me`: the edges this member answers by the rule. */
export function meshPeersKeeping(order: readonly string[], admin: string | undefined, me: string): string[] {
  return order.filter(key => key !== me && keptMeshPeer(order, admin, key) === me);
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
