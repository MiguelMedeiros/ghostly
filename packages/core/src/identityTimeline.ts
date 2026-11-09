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
  /**
   * Unique in the chat: side, proof and one past the highest number that proof's kept entries on that side have. A
   * contact's later attempt that took the entry over keeps it (see applyIdentityEvent).
   */
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

/** The contact's share of this kind still not verified (checking, or failed): the one its next attempt takes over. */
const unverifiedOf = (timeline: readonly IdentityTimelineEntry[], provider: string | undefined) => {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.side === "theirs" && e.kind === "shared" && e.state !== "verified" && e.provider === provider) return i;
  }
  return -1;
};

/**
 * The timeline after one step. A share already on it is updated in place, never repeated: a request sent again at
 * a reconnect, a second share of a proof the contact already verified. A new attempt after a failure or a stop is
 * a new entry, except the contact's own not verified: those keep one entry per kind, which its next attempt takes
 * over in place (its id and time stay, so no new sound and the chat does not move). The ids and the kind are the
 * contact's to choose, so otherwise its requests alone could push every other entry, this side's too, out of the
 * bound. A stop is written once; a withdrawal later found revoked becomes a revocation in place.
 */
export function applyIdentityEvent(timeline: readonly IdentityTimelineEntry[], event: IdentityTimelineEvent, at: number): IdentityTimelineEntry[] {
  const out = [...timeline];
  const i = lastOf(out, event.side, event.type === "result" ? [event.proof, event.requested] : [event.proof]);
  const last = i >= 0 ? out[i] : undefined;
  /** Puts the contact's attempt on the entry of its kind still not verified, if there is one. */
  const takeOver = (entry: Omit<IdentityTimelineEntry, "id" | "at" | "side" | "kind">) => {
    const j = event.side === "theirs" ? unverifiedOf(out, entry.provider) : -1;
    if (j < 0) return false;
    out[j] = { id: out[j].id, proof: entry.proof, side: "theirs", kind: "shared", provider: entry.provider, ...(entry.subject ? { subject: entry.subject } : {}),
      state: entry.state, ...(entry.error ? { error: entry.error } : {}), at: out[j].at };
    return true;
  };
  const add = (entry: Omit<IdentityTimelineEntry, "id" | "at">) => {
    // One past the highest number kept, not the count: the bound may have cut this proof's earlier entries.
    const prefix = `${entry.side}:${entry.proof}:`;
    let n = 0;
    for (const e of out) if (e.id.startsWith(prefix)) n = Math.max(n, Number(e.id.slice(prefix.length)) + 1 || 0);
    out.push({ ...entry, id: `${prefix}${n}`, at });
  };
  switch (event.type) {
    case "shared":
      if (last?.kind === "shared" && last.state !== "failed") {
        out[i] = { ...last, provider: event.provider, subject: event.subject ?? last.subject };
        break;
      }
      if (takeOver({ proof: event.proof, provider: event.provider, subject: event.subject, state: "verifying" })) break;
      add({ proof: event.proof, side: event.side, kind: "shared", provider: event.provider, ...(event.subject ? { subject: event.subject } : {}), state: "verifying" });
      break;
    case "result": {
      const settled = { state: event.ok ? "verified" as const : "failed" as const, ...(event.ok || !event.error ? {} : { error: event.error }) };
      if (last?.kind === "shared") {
        const { error: _, ...rest } = last;
        out[i] = { ...rest, proof: event.proof, provider: event.provider ?? last.provider, subject: event.subject ?? last.subject, ...settled };
        break;
      }
      // Its start is no longer kept (the timeline is bounded, or a later attempt took it over): the outcome stands
      // alone, a failed one on the contact's entry of its kind still not verified.
      if (!event.ok && event.provider && takeOver({ proof: event.proof, provider: event.provider, subject: event.subject, ...settled })) break;
      if (event.provider) add({ proof: event.proof, side: event.side, kind: "shared", provider: event.provider, ...(event.subject ? { subject: event.subject } : {}), ...settled });
      break;
    }
    case "stopped":
      // A revocation found after the withdrawal (a removal is both, WISP 300) says what the stop was: the same entry.
      if (last?.kind === "stopped") { if (last.reason === "withdrawn" && event.reason === "revoked") out[i] = { ...last, reason: "revoked" }; break; }
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
