import type { PairedTransport } from "./pairedTransports";

/**
 * How far a first pairing got, as one side can know it. Shared by the engine (which measures it) and
 * the UI (which shows it), the way a group join's stages are (`GroupJoinStage`).
 */

/** Who this side is: the one who made the invite, or the one who joined with it. */
export type PairingRole = "inviter" | "joiner";

/**
 * The stages, in the order they come. `publishing`: the inviter is putting its invite on the network.
 * `waiting`: the inviter waits for someone to read it. `resolving`: the joiner is looking the invite up
 * (relay, then DHT). `knocking`: this side sent its offer. `answering`: this side is answering the other's
 * offer. `connecting`: offer and answer met; the transport is coming up. `live`: the chat is open.
 * `failed`: this attempt did not make it (`reason`), and the engine tries again by itself when
 * `retryable`. On a first pairing the joiner knocks and the inviter answers; an inviter that sees a joiner
 * from before that rule knocks itself after a grace, so either role can be at either.
 */
export type PairingStage = "publishing" | "waiting" | "resolving" | "knocking" | "answering" | "connecting" | "live" | "failed";

/**
 * Why an attempt failed, in a word the UI has words for. `publish`: this side could not publish
 * (discovery unreachable). `timeout`: the offer was not answered in time. `transport`: offer and answer
 * met but no connection came up. `rejected`: the authenticated session failed, or a signal was forged or
 * unauthenticated (never retried). `key-mismatch`: the contact's key is not the one saved (never retried).
 * `offline`: this side went offline.
 */
export type PairingFailureReason = "publish" | "timeout" | "transport" | "rejected" | "key-mismatch" | "offline";

export interface PairingProgress {
  role: PairingRole;
  stage: PairingStage;
  /** When this stage began (ms since the epoch). */
  since: number;
  /** When the pairing began: the invite was made, or joined (ms since the epoch). */
  startedAt: number;
  /** Connection attempts so far, from 1. A failed attempt is followed by the next one. */
  attempt: number;
  /** A short technical note (an error message), when there is one. */
  detail?: string;
  /** Only when `stage` is `failed`: why, and whether the engine tries again on its own. */
  reason?: PairingFailureReason;
  retryable?: boolean;
  /** The contact's packet was seen (they are on the network); their offer or answer is what is awaited. */
  peerSeen?: boolean;
  /** `connecting` and `live`: the transport coming up, or in use. */
  transport?: PairedTransport;
}

const FIRST_STAGE: Record<PairingRole, PairingStage> = { inviter: "publishing", joiner: "resolving" };

/**
 * Keeps one side's `PairingProgress` from what the link reports, and says when it changed. Stops at
 * `live`: what happens to a paired chat afterwards is its connection state, not its pairing.
 */
export class PairingTracker {
  progress: PairingProgress;
  private peerSeen = false;
  /** An attempt is open from its offer until it ends (live, failed, or torn down). */
  private attemptOpen = false;
  private attempts = 0;

  constructor(role: PairingRole, startedAt: number, private readonly changed: (progress: PairingProgress) => void, private readonly now: () => number = Date.now) {
    this.progress = { role, stage: FIRST_STAGE[role], since: startedAt, startedAt, attempt: 1 };
  }

  get done(): boolean { return this.progress.stage === "live"; }

  /** This side's packet is on the network (its first, or the one after a publish that failed). */
  published(): void {
    const { stage, reason } = this.progress;
    if (stage === "publishing" || (stage === "failed" && reason === "publish")) this.set(this.idle());
  }

  /** The contact's packet was seen: they are on the network. */
  sawPeer(): void {
    if (this.peerSeen) return;
    this.peerSeen = true;
    this.set(this.progress.stage);
  }

  offerSent(): void { this.attempt("knocking"); }
  offerReceived(): void { this.attempt("answering"); }
  answerSent(): void { if (this.progress.stage === "answering") this.set("connecting"); }
  answerReceived(): void { if (this.progress.stage === "knocking") this.set("connecting"); }

  live(transport?: PairedTransport): void {
    this.attemptOpen = false;
    this.set("live", transport ? { transport } : undefined);
  }

  failed(reason: PairingFailureReason, retryable: boolean, detail?: string): void {
    if (this.done) return;
    this.attemptOpen = false;
    this.set("failed", { reason, retryable, ...(detail ? { detail } : {}) });
  }

  /** The attempt ended without a word (the connection went away before the session was ready). */
  reset(): void {
    if (this.done || !this.attemptOpen) return;
    this.attemptOpen = false;
    this.set(this.idle());
  }

  private attempt(stage: "knocking" | "answering"): void {
    if (this.done) return;
    if (!this.attemptOpen) this.attempts++;
    this.attemptOpen = true;
    this.set(stage);
  }

  /** The stage this side is at between attempts. */
  private idle(): PairingStage { return this.progress.role === "inviter" ? "waiting" : "resolving"; }

  private set(stage: PairingStage, extra?: Pick<PairingProgress, "detail" | "reason" | "retryable" | "transport">): void {
    if (this.done) return;
    const { role, startedAt, since } = this.progress;
    // A stage that only gained a detail (the contact was seen) keeps the moment it began.
    this.progress = { role, stage, since: stage === this.progress.stage ? since : this.now(), startedAt, attempt: Math.max(1, this.attempts),
      ...(this.peerSeen ? { peerSeen: true } : {}), ...extra };
    this.changed(this.progress);
  }
}
