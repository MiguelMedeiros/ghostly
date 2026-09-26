/**
 * What a chat's timeline shows of the identity-proof exchange (WISP 300, "In the conversation"): one entry when
 * an identity is shared, on both sides, turning verified or failed as the exchange settles, and one when it stops
 * (withdrawn by its owner, or found revoked). Local only: made from the exchange's own steps, stored with the
 * chat's identity ledger, never sent. Nothing new goes on the wire.
 */

/** "mine": this side shared it. "theirs": the contact did. */
export type IdentityTimelineSide = "mine" | "theirs";
export type IdentityTimelineState = "verifying" | "verified" | "failed";

export interface IdentityTimelineEntry {
  /** Unique in the chat: side, proof and how many entries that proof already had on that side. */
  id: string;
  /** The proof's id (identityStatement().id). */
  proof: string;
  side: IdentityTimelineSide;
  kind: "shared" | "stopped";
  provider: string;
  /** The identity, once known: at once on the sharer's side, from the presentation on the contact's. */
  subject?: string;
  /** A share only: where the contact's check stands. */
  state?: IdentityTimelineState;
  /** A failed share: why, as the verifier said it. */
  error?: string;
  /** A stop only: its owner withdrew it here, or its proof key published a revocation. */
  reason?: "withdrawn" | "revoked";
  /** Milliseconds. When it happened; later steps of the same share leave it in place. */
  at: number;
}

/** One step of the exchange, as the timeline needs it. */
export type IdentityTimelineEvent =
  /** A share began: this side shared, or the contact asked for a challenge. `requested`: the id the request named. */
  | { type: "shared"; side: IdentityTimelineSide; proof: string; provider: string; subject?: string }
  /** The contact's check settled. `requested`: the id the request named, when the presented proof is another. */
  | { type: "result"; side: IdentityTimelineSide; proof: string; requested?: string; provider?: string; subject?: string; ok: boolean; error?: string }
  | { type: "stopped"; side: IdentityTimelineSide; proof: string; provider: string; subject?: string; reason: "withdrawn" | "revoked" }
  /** A share taken back before it ever left this side (queued, the contact never heard of it): its entry goes. */
  | { type: "unsent"; side: "mine"; proof: string };

/** Entries a chat keeps, newest last. */
export const IDENTITY_TIMELINE_MAX = 100;

const lastOf = (timeline: readonly IdentityTimelineEntry[], side: IdentityTimelineSide, proofs: readonly (string | undefined)[]) => {
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].side === side && proofs.includes(timeline[i].proof)) return i;
  return -1;
};

/**
 * The timeline after one step. A share already on it is updated in place, never repeated: a request sent again at
 * a reconnect, a second share of a proof the contact already verified. A new attempt after a failure or a stop is
 * a new entry. A stop is written once.
 */
export function applyIdentityEvent(timeline: readonly IdentityTimelineEntry[], event: IdentityTimelineEvent, at: number): IdentityTimelineEntry[] {
  const out = [...timeline];
  const i = lastOf(out, event.side, event.type === "result" ? [event.proof, event.requested] : [event.proof]);
  const last = i >= 0 ? out[i] : undefined;
  const add = (entry: Omit<IdentityTimelineEntry, "id" | "at">) => {
    const n = out.filter(e => e.side === entry.side && e.proof === entry.proof).length;
    out.push({ ...entry, id: `${entry.side}:${entry.proof}:${n}`, at });
  };
  switch (event.type) {
    case "shared":
      if (last?.kind === "shared" && last.state !== "failed") {
        out[i] = { ...last, provider: event.provider, subject: event.subject ?? last.subject };
        break;
      }
      add({ proof: event.proof, side: event.side, kind: "shared", provider: event.provider, ...(event.subject ? { subject: event.subject } : {}), state: "verifying" });
      break;
    case "result": {
      const settled = { state: event.ok ? "verified" as const : "failed" as const, ...(event.ok || !event.error ? {} : { error: event.error }) };
      if (last?.kind === "shared") {
        const { error: _, ...rest } = last;
        out[i] = { ...rest, proof: event.proof, provider: event.provider ?? last.provider, subject: event.subject ?? last.subject, ...settled };
        break;
      }
      // Its start is no longer kept (the timeline is bounded): the outcome stands alone.
      if (event.provider) add({ proof: event.proof, side: event.side, kind: "shared", provider: event.provider, ...(event.subject ? { subject: event.subject } : {}), ...settled });
      break;
    }
    case "stopped":
      if (last?.kind === "stopped") break;
      add({ proof: event.proof, side: event.side, kind: "stopped", provider: event.provider, subject: event.subject ?? last?.subject, reason: event.reason });
      break;
    case "unsent":
      if (last?.kind === "shared" && last.state === "verifying") out.splice(i, 1);
      break;
  }
  return out.length > IDENTITY_TIMELINE_MAX ? out.slice(-IDENTITY_TIMELINE_MAX) : out;
}

/** When the contact last shared an identity here (milliseconds), for the chat list: 0 when never. */
export function lastSharedWithMe(timeline: readonly IdentityTimelineEntry[] | undefined): number {
  let at = 0;
  for (const e of timeline ?? []) if (e.side === "theirs" && e.kind === "shared" && e.at > at) at = e.at;
  return at;
}
