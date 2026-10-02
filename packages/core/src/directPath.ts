/**
 * Whether this device's own WebRTC attempts say that direct connections do not get through its network: a VPN that
 * takes every packet through its tunnel, a firewall that drops UDP, a carrier's NAT. The app cannot see a VPN; it can
 * see that its attempts keep failing the same way, and say so where people look at the connection (the chat's
 * connection panel, Settings → Network). Chats still go live through a relayed transport, or carry short texts on the
 * DHT.
 *
 * What an attempt says (`DataLink` tells, per attempt):
 * - `open`: a WebRTC connection opened (`closed`: that one ended). Direct connections work here, whatever failed before.
 * - `no-public`: the attempt did not connect, and this device had gathered no public candidate for it (none at all, or
 *   host addresses only: no STUN server answered). Its own evidence: nothing of the contact's is in it.
 * - `symmetric`: it did not connect, and this device's public address was a different port for each STUN server it
 *   asked (`symmetricNat`): its network maps every destination apart, so a contact cannot reach the port it was told.
 *   Its own evidence too.
 * - `no-path`: this device's offer was answered, it had public candidates that read as reachable, and no pair
 *   connected. The contact may be the one behind the network that blocks; several contacts are this device.
 *
 * The rule, on purpose slow to say yes: no WebRTC connection open now and none opened since, and either
 * `DIRECT_OWN_ATTEMPTS` attempts with this device's own evidence, or attempts that failed with `DIRECT_PEERS`
 * different contacts (a contact who is also a member of a group counts under each key, so two is not enough). One
 * failed dial never shows anything. It clears by itself: on the first connection that opens, when the network changes
 * (`reset`), and once the evidence is older than `DIRECT_EVIDENCE_MS` (a network that changed without the app hearing
 * of it).
 */
export type DirectEvidence = "open" | "closed" | "no-public" | "symmetric" | "no-path";

/** Evidence older than this says nothing about the network now. */
export const DIRECT_EVIDENCE_MS = 30 * 60_000;
/** Attempts with this device's own evidence (`no-public`, `symmetric`) that it takes. */
export const DIRECT_OWN_ATTEMPTS = 2;
/** Different contacts the attempts must have failed with, whatever their kind. */
export const DIRECT_PEERS = 3;
/** Failures kept: the rule needs a few, and a group's edges may bring many. */
const KEPT = 64;
/** Server reflexive candidates on one address with this many different ports: a mapping per destination. */
const SYMMETRIC_PORTS = 3;

export interface DirectFailure { peer: string; kind: "no-public" | "symmetric" | "no-path"; at: number }

/**
 * Whether a local description shows a NAT that maps each destination apart: the app asks several STUN servers from one
 * socket, and a NAT that keeps one mapping answers with one address and port (the browser lists it once). Three ports
 * on one address, not two: a device on two interfaces behind one router (Wi-Fi and a cable) has two.
 */
export function symmetricNat(sdp: string | undefined | null): boolean {
  const ports = new Map<string, Set<string>>();
  for (const [, address, port] of (sdp ?? "").matchAll(/^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ srflx\b/gim)) {
    const seen = ports.get(address) ?? new Set<string>();
    ports.set(address, seen.add(port));
  }
  return [...ports.values()].some(seen => seen.size >= SYMMETRIC_PORTS);
}

/** The rule alone: whether `failures` (every one after the last `open`) say direct connections are blocked at `now`. */
export function directBlocked(failures: readonly DirectFailure[], now: number): boolean {
  const fresh = failures.filter(f => now - f.at < DIRECT_EVIDENCE_MS);
  if (fresh.filter(f => f.kind !== "no-path").length >= DIRECT_OWN_ATTEMPTS) return true;
  return new Set(fresh.map(f => f.peer)).size >= DIRECT_PEERS;
}

export class DirectPathWatch {
  private failures: DirectFailure[] = [];
  /** Contacts a WebRTC connection is open with now. */
  private readonly open = new Set<string>();
  private was = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange`: `blocked` changed (evidence came, a connection opened, the network changed, the evidence aged out). */
  constructor(private readonly onChange: (blocked: boolean) => void = () => {}, private readonly now: () => number = Date.now) {}

  /** One WebRTC attempt with `peer` ended this way (or its open connection closed). */
  note(peer: string, evidence: DirectEvidence): void {
    if (evidence === "open") { this.open.add(peer); this.failures = []; }
    else if (evidence === "closed") this.open.delete(peer);
    else this.failures = [...this.failures, { peer, kind: evidence, at: this.now() }].slice(-KEPT);
    this.settle();
  }

  /** The network changed: what failed on the old one says nothing about this one. */
  reset(): void {
    this.failures = [];
    this.settle();
  }

  get blocked(): boolean { return !this.open.size && directBlocked(this.failures, this.now()); }

  /** Stops the timer that lets the evidence age out. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private settle(): void {
    this.close();
    const blocked = this.blocked;
    if (blocked) {
      // Looked at again when the oldest evidence ages out: what is left may no longer be enough.
      const oldest = Math.min(...this.failures.map(f => f.at));
      this.timer = setTimeout(() => { this.failures = this.failures.filter(f => this.now() - f.at < DIRECT_EVIDENCE_MS); this.settle(); },
        Math.max(1_000, oldest + DIRECT_EVIDENCE_MS - this.now()));
      (this.timer as { unref?: () => void }).unref?.();
    }
    if (blocked === this.was) return;
    this.was = blocked;
    this.onChange(blocked);
  }
}
