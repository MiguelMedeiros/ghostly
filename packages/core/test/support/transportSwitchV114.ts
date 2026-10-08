// The switch as v1.1.4 shipped it (`git show v1.1.4:packages/core/src/transportSwitch.ts`), unchanged but for this
// header and the import path: the contact's app a newer one still meets. Not to be edited to follow `src`.
import { rankTransports, relayedTransports, transportOrder, TRANSPORTS, type PairedTransport, type TransportDescriptors } from "../../src/pairedTransports";

export interface TransportPolicy {
  revision: number;
  intent: number;
  preferred: PairedTransport;
  fallback: boolean;
  available: PairedTransport[];
  descriptors: TransportDescriptors;
}
export interface SwitchPlan {
  id: string;
  local: TransportPolicy;
  remote: TransportPolicy;
  choices: PairedTransport[];
  /**
   * Nobody chose: the session is on a relayed transport and a direct one ranks first, and both sides said they move
   * (`upgrade`). Quiet: no transport shown as wanted, no row when it does not connect, and tried once.
   */
  upgrade?: boolean;
}
export const allowedTransports = (policy: TransportPolicy) => transportOrder(policy.available, policy.preferred, policy.fallback);

function parsePolicy(raw: unknown): TransportPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as TransportPolicy;
  if (!Number.isSafeInteger(p.revision) || p.revision < 0 || !Number.isSafeInteger(p.intent) || p.intent < 0 ||
    !TRANSPORTS.includes(p.preferred) || typeof p.fallback !== "boolean" || !Array.isArray(p.available) ||
    p.available.length > 3 || new Set(p.available).size !== p.available.length || p.available.some(t => !TRANSPORTS.includes(t)) ||
    !p.descriptors || typeof p.descriptors !== "object" || JSON.stringify(p.descriptors).length > 4096) return null;
  const descriptors: TransportDescriptors = {};
  for (const t of ["iroh/1", "hyperdht/1"] as const) if (p.descriptors[t]) descriptors[t] = p.descriptors[t];
  return { revision: p.revision, intent: p.intent, preferred: p.preferred, fallback: p.fallback, available: [...p.available], descriptors };
}

/** Runs only inside a participation-authenticated channel. Both roles may propose;
 * the lower rendezvous key coordinates a revision-checked plan, never both dials.
 * The existing channel stays alive while a replacement proves its own binding. */
export class TransportSwitch {
  private context = "";
  private revision = 0;
  private intent = 0;
  private remote: TransportPolicy | null = null;
  /** The contact's policy as it last said it, kept across sessions: where the next reconnect dials first. */
  private lastRemote: TransportPolicy | null = null;
  private actual?: PairedTransport;
  private plan: SwitchPlan | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = "";
  private failed = "";
  private preparing = false;
  /** This side chose while no session was open: the next one begins with it as a choice. */
  private apart = false;
  constructor(private readonly options: {
    key: string; peerKey: string;
    policy(): Omit<TransportPolicy, "revision" | "intent">;
    send(frame: object): void;
    peer(policy: TransportPolicy): void;
    state(error?: string, target?: PairedTransport): void;
    prepare(plan: SwitchPlan, dial: boolean): void;
    cancel(): void;
    /** A plan's target could not be reached and the session stayed on the current transport (fallback allowed it). */
    kept?(target: PairedTransport, reason?: string): void;
    /**
     * A plan's target could not be reached, and nothing kept the chat on another transport: the chat waits for it
     * (WISP 100, "A chosen transport not reached yet") rather than failing, and is told why here, not as an error.
     * `reason` is known on the side that dialled. Without this callback, the failure is an error state, as before.
     */
    unreached?(target: PairedTransport, reason?: string): void;
    /** Both sides move a session off a relayed transport to a direct one ranked first, nobody having chose (`upgrade/1`). */
    upgrade?(): boolean;
    timeoutMs?: number;
  }) {}

  get peerPolicy(): TransportPolicy | null { return this.remote; }
  /**
   * The transport a standing explicit choice names (the higher intent; the lower key on a tie), from this side's
   * policy and the contact's last one, when both can use it. None when neither side chose: the rank sum decides.
   * Both sides get the same answer, so whichever redials after a drop lands where the agreement would move it.
   */
  get chosenTarget(): PairedTransport | undefined {
    const local = this.local(), remote = this.lastRemote;
    if (!remote) return undefined;
    const winner = this.winner(local, remote);
    if (winner.intent === 0) return undefined;
    return rankTransports(allowedTransports(local), allowedTransports(remote)).includes(winner.preferred) ? winner.preferred : undefined;
  }
  private winner(local: TransportPolicy, remote: TransportPolicy): TransportPolicy {
    return local.intent > remote.intent || (local.intent === remote.intent && this.options.key < this.options.peerKey) ? local : remote;
  }
  get pending(): SwitchPlan | null { return this.plan; }
  /**
   * Where the policies put the chat while a session is open, and whose choice that is: the agreed target, or, when
   * the two sides' transports do not overlap, the winning side's preferred. `by` is absent when nobody chose (a
   * policy alone, such as Fallback off, names it). Both sides get the same answer.
   */
  wanted(): { transport: PairedTransport; by?: "you" | "contact" } | undefined {
    if (!this.context || !this.remote) return undefined;
    const local = this.local(), remote = this.remote, winner = this.winner(local, remote);
    const transport = this.choices(local, remote)[0] ?? winner.preferred;
    return { transport, ...(winner.intent > 0 ? { by: winner === local ? "you" as const : "contact" as const } : {}) };
  }
  private local(): TransportPolicy { return { ...this.options.policy(), revision: this.revision, intent: this.intent }; }
  private signature(local: TransportPolicy, remote: TransportPolicy): string {
    return this.options.key < this.options.peerKey ? `${local.revision}:${remote.revision}` : `${remote.revision}:${local.revision}`;
  }
  private send(frame: object): void { if (this.context) this.options.send({ ...frame, context: this.context }); }
  private announce(): void { this.send({ t: "paired-policy", policy: this.local() }); }

  /**
   * A session is ready. `migrated`: it is the one a plan dialled, so that plan is done, even on a fallback choice.
   * Otherwise it is a fresh session (a reconnect after a drop): a plan still pending from the old one did not happen,
   * and what the old one kept or gave up on does not bind this one. Both sides agree again from their policies, so
   * the chat ends on the same transport whichever side dialled.
   * A plan that landed on a fallback choice (its target did not connect, a later choice did) is a target not reached,
   * as when the current transport is kept: its owner waits for it and tries it again (WISP 100).
   */
  begin(context: string, actual: PairedTransport, migrated = false): void {
    const landed = migrated ? this.plan : null;
    this.settled = landed ? this.signature(landed.local, landed.remote) : "";
    // A fresh session may be the contact's app started again, which counts its revisions from 0: its policy is heard
    // anew (it announces it on this session). One kept from the old session made every newer policy look older, and
    // no change ever moved the chat after a contact's crash and resume (`attachReplacement` stops nothing here).
    if (!migrated) { this.failed = ""; this.remote = null; }
    // A choice made while apart is a choice now: above the contact's last intent, as one made on a session would be.
    if (this.apart) { this.intent = Math.max(this.intent, this.lastRemote?.intent ?? 0) + 1; this.apart = false; }
    this.clearPlan();
    this.context = context; this.actual = actual;
    this.options.state(); this.announce();
    if (landed && landed.choices[0] !== actual) this.options.kept?.(landed.choices[0]);
  }
  /** `automatic`: no choice of this side's any more; the contact's explicit one wins, and without one the
   * current transport is kept while it is allowed. */
  changed(userIntent: boolean | "automatic" = true): void {
    this.revision++;
    if (userIntent === "automatic") { this.intent = 0; this.apart = false; }
    else if (userIntent) this.intent = Math.max(this.intent, this.remote?.intent ?? 0) + 1;
    this.failed = "";
    this.announce(); this.reconcile();
  }
  /**
   * This side's user chose the transport its policy now names. `again`: the one it named already. Choosing again
   * what this side's standing choice names raises no intent: it would move nothing, and a raised intent could beat
   * a newer choice of the contact's still on its way (the tie goes to the lower key). It still counts as a retry.
   * Choosing again while the contact's choice stands is an override, and raises it.
   */
  chose(again = false): void { this.changed(!(again && this.standing)); }
  /**
   * This side's user chose with no session open (WISP 100, "A choice made while not live"). Nothing to announce it on:
   * the next session begins with it as a choice, so the chat moves there if that session opened elsewhere.
   */
  choseApart(): void { this.revision++; this.apart = true; this.failed = ""; }
  /** This side's explicit choice is the one that stands (its intent is the higher, or wins the tie). */
  get standing(): boolean {
    if (this.intent === 0) return false;
    const local = this.local();
    return !this.remote || this.winner(local, this.remote) === local;
  }
  keep(reason?: string): void {
    const target = this.plan?.choices[0];
    if (this.plan) this.settled = this.signature(this.plan.local, this.plan.remote);
    if (target && target !== this.actual && !this.plan?.upgrade) this.options.kept?.(target, reason);
    this.send({ t: "paired-switch-keep", id: this.plan?.id });
    this.clearPlan(); this.options.state(); this.reconcile();
  }
  retry(): void { this.failed = ""; this.announce(); this.reconcile(); }
  /**
   * Tries the target again after it did not connect (WISP 100: retried, never given up), also when a fallback kept
   * the chat on another transport. The coordinator plans again. The other side cannot: its policy goes out again under
   * a new revision, which the coordinator reconciles afresh, whatever it had given up on.
   */
  again(): void {
    if (!this.context || !this.remote || this.plan) return;
    this.failed = this.settled = "";
    if (this.options.key > this.options.peerKey) { this.revision++; this.announce(); }
    this.reconcile();
  }
  stop(): void { this.clearPlan(); this.context = ""; this.remote = null; }
  private clearPlan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.plan = null; this.preparing = false;
  }
  fail(error: string): void {
    const target = this.plan?.choices[0], upgrade = !!this.plan?.upgrade;
    if (this.plan) this.failed = this.signature(this.plan.local, this.plan.remote);
    this.send({ t: "paired-switch-failed", id: this.plan?.id });
    this.clearPlan(); this.options.cancel();
    // A move off a relay that did not connect: the chat stays where it is, as it would have without it.
    if (upgrade) this.options.state(); else this.unreached(target, error, error);
    this.replanIfMoved();
  }
  /**
   * A choice made while a move was dialling could not cut in (WISP 100): once that move failed, it is planned at once.
   * Policies that are still the failed plan's are not planned again here; the owner's retry pace does that.
   */
  private replanIfMoved(): void {
    if (this.context && this.remote && this.failed && this.signature(this.local(), this.remote) !== this.failed) this.reconcile();
  }
  /** Waiting for `target`, not failed, where the owner says why; an error state for an owner that does not. */
  private unreached(target: PairedTransport | undefined, error: string, reason?: string): void {
    if (target && this.options.unreached) { this.options.unreached(target, reason); this.options.state(); }
    else this.options.state(error);
  }
  private choices(local: TransportPolicy, remote: TransportPolicy): PairedTransport[] {
    const relayed = relayedTransports(local.descriptors, remote.descriptors);
    const ranked = rankTransports(allowedTransports(local), allowedTransports(remote), relayed);
    if (!ranked.length) return [];
    const winner = this.winner(local, remote);
    // Nobody chose: the current transport stays, a relayed one too (no probing while live, WISP 100); the next
    // dial ranks direct paths first again. Unless both sides move off a relay (`upgrade`): then a direct transport
    // ranked first is where the chat goes, once (a plan that does not connect is not made again for these policies).
    const upgrade = this.upgrading(winner, ranked, relayed);
    const target = upgrade ? ranked[0] : winner.intent === 0 && this.actual && ranked.includes(this.actual) ? this.actual
      : ranked.includes(winner.preferred) ? winner.preferred : ranked[0];
    return [target, ...(local.fallback && remote.fallback ? ranked.filter(t => t !== target) : [])];
  }
  /** Nobody chose, the session is on a relayed transport, a direct one ranks first, and both sides move (`upgrade/1`). */
  private upgrading(winner: TransportPolicy, ranked: PairedTransport[], relayed: readonly string[]): boolean {
    return winner.intent === 0 && !!this.actual && relayed.includes(this.actual) && ranked.includes(this.actual)
      && ranked[0] !== this.actual && !relayed.includes(ranked[0]) && !!this.options.upgrade?.();
  }
  private isUpgrade(local: TransportPolicy, remote: TransportPolicy): boolean {
    const relayed = relayedTransports(local.descriptors, remote.descriptors);
    return this.upgrading(this.winner(local, remote), rankTransports(allowedTransports(local), allowedTransports(remote), relayed), relayed);
  }
  /**
   * Something `upgrade` depends on changed (what the contact's app offers on this session, said once it is ready): plan
   * again. The session's first agreement, made before that, settled on the relay it is on; a move off it is not that.
   */
  reconsider(): void {
    if (this.context && this.remote && !this.plan && this.isUpgrade(this.local(), this.remote) && this.settled === this.signature(this.local(), this.remote)) this.settled = "";
    this.reconcile();
  }
  private install(plan: SwitchPlan): void {
    this.clearPlan(); this.plan = plan;
    this.options.state(undefined, plan.upgrade ? undefined : plan.choices[0]);
    this.timer = setTimeout(() => this.fail("Transport change timed out. Your previous connection is kept when available; retry or choose another transport."), this.options.timeoutMs ?? 30_000);
  }
  private reconcile(): void {
    if (!this.context || !this.remote || this.plan) return;
    const local = this.local(), remote = this.remote;
    const choices = this.choices(local, remote);
    if (!choices.length) {
      this.clearPlan();
      // A transport one side does not run (yet) is waited for, and its owner says why; only choices that exclude
      // each other (both limited to different transports) are an error.
      const wanted = this.winner(local, remote).preferred;
      const missing = !local.available.includes(wanted) || !remote.available.includes(wanted);
      this.options.state(missing && this.options.unreached ? undefined
        : "Transport preferences do not overlap. Enable fallback or choose the same supported transport on both sides.");
      return;
    }
    const signature = this.signature(local, remote);
    if (choices[0] === this.actual || (signature === this.settled && this.actual && choices.includes(this.actual))) {
      this.settled = signature; this.clearPlan(); this.options.state(); return;
    }
    if (signature === this.failed) return;
    const upgrade = this.isUpgrade(local, remote);
    this.options.state(undefined, upgrade ? undefined : choices[0]);
    if (this.options.key > this.options.peerKey) {
      if (!this.timer) this.timer = setTimeout(() => {
        this.failed = signature; this.clearPlan();
        if (upgrade) { this.options.state(); return; }
        this.unreached(choices[0], "Your contact did not acknowledge the transport change. Retry when both peers are connected.", "Your contact did not answer");
      }, this.options.timeoutMs ?? 30_000);
      return;
    }
    const plan = { id: `${signature}:${choices[0]}`, local, remote, choices, ...(upgrade && { upgrade }) };
    this.install(plan);
    this.send({ t: "paired-switch-plan", id: plan.id, revisions: [local.revision, remote.revision], target: choices[0] });
  }
  handle(frame: Record<string, unknown>): boolean {
    if (!["paired-policy", "paired-switch-plan", "paired-switch-ready", "paired-switch-go", "paired-switch-keep", "paired-switch-failed"].includes(String(frame.t))) return false;
    if (!this.context || frame.context !== this.context) return true;
    if (frame.t === "paired-policy") {
      const policy = parsePolicy(frame.policy);
      if (!policy || (this.remote && (policy.revision < this.remote.revision ||
        (policy.revision === this.remote.revision && JSON.stringify(policy) !== JSON.stringify(this.remote))))) return true;
      const changed = !this.remote || policy.revision !== this.remote.revision;
      this.remote = this.lastRemote = policy; this.options.peer(policy);
      if (changed && this.plan && !this.preparing) this.clearPlan();
      this.reconcile(); return true;
    }
    if (frame.t === "paired-switch-plan") {
      if (this.options.key < this.options.peerKey || !this.remote) return true;
      const local = this.local(), remote = this.remote, choices = this.choices(local, remote);
      if (!Array.isArray(frame.revisions) || frame.revisions[0] !== remote.revision || frame.revisions[1] !== local.revision ||
        choices[0] !== frame.target || frame.id !== `${this.signature(local, remote)}:${choices[0]}`) { this.announce(); return true; }
      if (!this.plan || this.plan.id !== frame.id) this.install({ id: String(frame.id), local, remote, choices, ...(this.isUpgrade(local, remote) && { upgrade: true }) });
      // Permission is installed before the ACK; a native channel may arrive before
      // the subsequent GO frame on the old channel. Its fresh proof is still mandatory.
      this.options.prepare(this.plan!, false);
      this.send({ t: "paired-switch-ready", id: frame.id }); return true;
    }
    if (!this.plan || frame.id !== this.plan.id) return true;
    if (frame.t === "paired-switch-failed") {
      const target = this.plan.choices[0], upgrade = !!this.plan.upgrade;
      this.failed = this.signature(this.plan.local, this.plan.remote);
      this.clearPlan(); this.options.cancel();
      if (upgrade) this.options.state();
      else this.unreached(target, "The transport change failed. Retry or choose another transport.");
      this.replanIfMoved(); return true;
    }
    if (frame.t === "paired-switch-keep") {
      if (this.actual && this.plan.choices.includes(this.actual)) {
        if (this.plan.choices[0] !== this.actual && !this.plan.upgrade) this.options.kept?.(this.plan.choices[0]);
        this.settled = this.signature(this.plan.local, this.plan.remote);
        this.clearPlan(); this.options.state(); this.reconcile();
      }
      return true;
    }
    if (frame.t === "paired-switch-ready" && this.options.key < this.options.peerKey && !this.preparing) {
      if (!this.remote || this.signature(this.local(), this.remote) !== this.signature(this.plan.local, this.plan.remote)) {
        this.clearPlan(); this.announce(); this.reconcile(); return true;
      }
      this.preparing = true;
      this.send({ t: "paired-switch-go", id: frame.id });
      this.options.prepare(this.plan, true);
    } else if (frame.t === "paired-switch-go" && this.options.key > this.options.peerKey) this.preparing = true;
    return true;
  }
}
