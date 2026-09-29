import type { IdentityLedger, PairingProgress } from "@ghostly/core";
import type { AttentionCue } from "../shared/rpc";
import type { TransportEntry, TransportEvent } from "./transportLog";

/*
 * Which facts deserve a sound of their own (Settings > Notifications and sounds), read off the engine's own records.
 * Each returns the cue and a key for it: the engine's `feedback` plays one sound per key, so the same fact seen again
 * (a record saved twice, a state pushed twice) stays one sound.
 */

export interface Cue { cue: AttentionCue; key: string }

/** A payment record as the desk shows it. */
export interface CuePayment { id: string; kind: string; direction: string; state: string; createdAt: number; closed?: boolean; error?: string }

/**
 * A request that just came in, or a payment of mine that did not go through: refused by the contact, or failed on
 * its way. Only what happened while this engine runs (`since`); a request the contact closed is theirs to close.
 */
export function paymentCue(payment: CuePayment, since: number): Cue | undefined {
  if (payment.createdAt < since) return undefined;
  if (payment.kind === "request" && payment.direction === "in" && payment.state === "pending") return { cue: "request", key: payment.id };
  if (payment.kind === "payment" && payment.direction === "out" && (payment.state === "failed" || (payment.state === "reclaimed" && !!payment.error))) return { cue: "failed", key: payment.id };
  return undefined;
}

/** A timeline entry of an identity share (identityTimeline.ts), when the ledger keeps one. */
interface TimelineEntry { id: string; side: string; kind: string; state?: string }
const timelineOf = (ledger: IdentityLedger | undefined) => (ledger as { timeline?: TimelineEntry[] } | undefined)?.timeline;

/**
 * What changed in a chat's identities that the contact did: a proof they shared arrived (`shared`), or one of theirs
 * became verified (`checked`). With a timeline, its entries say it (a share arrives "verifying", then turns
 * "verified"); without one, the received list does, where a proof lands already verified: a share, and a proof back
 * to verified after a re-check.
 */
export function identityCues(before: IdentityLedger | undefined, after: IdentityLedger): Cue[] {
  const cues: Cue[] = [];
  const was = timelineOf(before), now = timelineOf(after);
  if (now) {
    for (const entry of now) {
      if (entry.side !== "theirs" || entry.kind !== "shared") continue;
      const old = was?.find((e) => e.id === entry.id);
      if (!old) cues.push(entry.state === "verified" ? { cue: "checked", key: entry.id } : { cue: "shared", key: entry.id });
      else if (entry.state === "verified" && old.state !== "verified") cues.push({ cue: "checked", key: entry.id });
    }
    return cues;
  }
  for (const proof of after.received) {
    const old = before?.received.find((r) => r.id === proof.id);
    if (!old) cues.push({ cue: "shared", key: `${proof.id}:${proof.verifiedAt}` });
    else if (proof.status === "verified" && old.status !== "verified") cues.push({ cue: "checked", key: `${proof.id}:${proof.checkedAt}` });
  }
  return cues;
}

/** The last row of a chat's transport timeline, and the last event of its history: what a change is measured from. */
export interface TransportMark { row?: string; event?: TransportEvent }
export const transportMark = (entries: readonly TransportEntry[], history: readonly TransportEvent[]): TransportMark => {
  const row = entries[entries.length - 1] as TransportEntry | undefined;
  return { row: row && `${row.id}:${row.kind}:${row.transport ?? ""}`, event: history[history.length - 1] as TransportEvent | undefined };
};

/**
 * The transport timeline gained a row worth a sound: a live switch or someone's choice landing (never this app
 * starting, nor a reconnect that came back elsewhere after a short drop), or the chat back after an outage (the
 * #227 row that says how long it was down). A drop itself is silent.
 */
export function transportCue(before: TransportMark, entries: readonly TransportEntry[], history: readonly TransportEvent[]): Cue | undefined {
  const after = transportMark(entries, history), row = entries[entries.length - 1] as TransportEntry | undefined;
  if (!row || after.row === before.row || after.event === before.event) return undefined;
  if (row.kind === "switched" && after.event?.kind === "switched") return { cue: "switched", key: `${row.id}:${row.transport}` };
  if (row.kind === "back" && row.downMs !== undefined) return { cue: "back", key: row.id };
  return undefined;
}

/**
 * The contact came with my invite: the first time the inviter's pairing shows them (their packet seen, or past the
 * wait), after it did not. The same test as the invite card's (src/lib/pairingProgress.ts `contactArrived`).
 */
export function knockCue(before: PairingProgress | undefined, after: PairingProgress): boolean {
  const arrived = (p: PairingProgress | undefined) => !!p && (!!p.peerSeen || ["answering", "connecting", "live", "on-dht"].includes(p.stage));
  return after.role === "inviter" && !!before && !arrived(before) && arrived(after);
}

/** A group's own line that says I made it or joined it (not someone else joining). */
export const groupCue = (message: { event?: string; member?: string }): AttentionCue | undefined =>
  message.event === "created" || (message.event === "joined" && !message.member) ? "group" : undefined;
