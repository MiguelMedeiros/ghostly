/**
 * A circuit breaker per Pkarr relay. A relay that failed `threshold` times in a row (no answer, a server error,
 * its own rate limit, 429, or an answer too slow to use, `SLOW_MS` in relay.ts) is left alone for a while: a minute the first time, twice as long each time it
 * trips again, five minutes at most. When the wait is over, one request goes to it (the probe); an answer
 * closes the breaker, a failure opens it again for longer. The relays still closed take its turns meanwhile.
 *
 * Only what the relay did counts: a request this client held back for its own budget is not a failure, and an
 * answer the protocol expects (404, 409, 412, 428) is a relay working as it should.
 */

/** Failures in a row that trip a relay's breaker. */
export const BREAKER_THRESHOLD = 3;
/** How long a relay is left alone the first time its breaker trips; doubled on each trip in a row. */
export const BREAKER_BASE_MS = 60_000;
/** The longest a relay is left alone. */
export const BREAKER_MAX_MS = 5 * 60_000;
/**
 * While every relay is left alone for failing, one of them is asked this often anyway: with nothing else to try, a
 * long wait only delays noticing that they answer again (a link stayed down minutes after the relays came back).
 */
export const BREAKER_ALL_DOWN_PROBE_MS = 15_000;

/** Why a request to a relay failed: its rate limit (`throttled`), or anything else (`error`). */
export type RelayFailure = "throttled" | "error";

/** A relay as the connection panel shows it: `ok`, `throttled` (its rate limit) or `failing`, until when. */
export interface RelayHealth {
  relay: string;
  state: "ok" | "throttled" | "failing";
  /** When the relay is asked again (ms since the epoch), while it is left alone. */
  until?: number;
  /** What went wrong last, in a few words; never a key. */
  reason?: string;
}

/**
 * How this client reaches Pkarr right now, for the connection panel: the path its last read took ("dht", or
 * the relay that answered), and the health of each relay it uses (none where it reads the DHT alone).
 */
export interface DiscoveryStatus {
  path: { via: "dht" } | { via: "relay"; relay: string } | null;
  relays: RelayHealth[];
}

export interface RelayBreakerOptions {
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
  /** `BREAKER_ALL_DOWN_PROBE_MS`. */
  allDownProbeMs?: number;
  now?: () => number;
  /** Told each time a relay trips: which, why, and for how long. */
  onTrip?: (relay: string, reason: string, forMs: number) => void;
  /** Told when a tripped relay answered its probe. */
  onRecover?: (relay: string) => void;
}

interface Circuit {
  failures: number;
  /** Trips in a row, without an answer in between: the next wait doubles with each. */
  trips: number;
  /** Left alone until then (0: closed). */
  openUntil: number;
  /** The one request allowed once the wait is over is out. */
  probing: boolean;
  kind?: RelayFailure;
  reason?: string;
}

export class RelayBreaker {
  private readonly circuits = new Map<string, Circuit>();
  private readonly threshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly allDownProbeMs: number;
  private readonly now: () => number;
  /** When a relay was last asked because every relay was left alone. */
  private lastAllDownProbe = -Infinity;

  constructor(private readonly options: RelayBreakerOptions = {}) {
    this.threshold = options.threshold ?? BREAKER_THRESHOLD;
    this.baseMs = options.baseMs ?? BREAKER_BASE_MS;
    this.maxMs = options.maxMs ?? BREAKER_MAX_MS;
    this.allDownProbeMs = options.allDownProbeMs ?? BREAKER_ALL_DOWN_PROBE_MS;
    this.now = options.now ?? Date.now;
  }

  private circuit(relay: string): Circuit {
    let circuit = this.circuits.get(relay);
    if (!circuit) this.circuits.set(relay, circuit = { failures: 0, trips: 0, openUntil: 0, probing: false });
    return circuit;
  }

  /** How long the relay is still left alone, in ms; 0 when a request may go (closed, or its probe is due). */
  blockedFor(relay: string): number {
    const circuit = this.circuits.get(relay);
    if (!circuit || circuit.openUntil === 0) return 0;
    const left = circuit.openUntil - this.now();
    if (left > 0) return left;
    // The wait is over: one probe at a time, the others wait for its answer.
    return circuit.probing ? this.baseMs : 0;
  }

  /** Why the relay is left alone, while it is: its rate limit or failures. */
  blockedKind(relay: string): RelayFailure | undefined {
    return this.blockedFor(relay) > 0 ? this.circuits.get(relay)?.kind : undefined;
  }

  /** A request is going to the relay now: its probe, when the wait is over. Call only when `blockedFor` is 0. */
  begin(relay: string): void {
    const circuit = this.circuits.get(relay);
    if (circuit && circuit.openUntil !== 0 && circuit.openUntil <= this.now()) circuit.probing = true;
  }

  /**
   * When every relay of `relays` is left alone for failing (none for its rate limit, none with its probe due or out),
   * the one whose wait ends first may be asked now, once every `BREAKER_ALL_DOWN_PROBE_MS`. Returns it, or null. The
   * caller marks the request with `beginAllDown` when it really goes (a request its budget holds back is no probe).
   */
  allDownProbe(relays: string[]): string | null {
    const now = this.now();
    if (!relays.length || now - this.lastAllDownProbe < this.allDownProbeMs) return null;
    let pick: string | null = null, soonest = Infinity;
    for (const relay of relays) {
      const circuit = this.circuits.get(relay);
      if (!circuit || circuit.openUntil <= now || circuit.probing || circuit.kind !== "error") return null;
      if (circuit.openUntil < soonest) { soonest = circuit.openUntil; pick = relay; }
    }
    return pick;
  }

  /** The probe `allDownProbe` named is going now: its answer closes the breaker, a failure trips it again. */
  beginAllDown(relay: string): void {
    const circuit = this.circuits.get(relay);
    if (circuit) circuit.probing = true;
    this.lastAllDownProbe = this.now();
  }

  /**
   * A request that went to the relay was dropped before it answered, by this client (another relay answered first), or
   * its answer says nothing either way: a probe among them is no longer out, and the next request may probe again.
   */
  cancel(relay: string): void {
    const circuit = this.circuits.get(relay);
    if (circuit) circuit.probing = false;
  }

  /** The relay answered: whatever was wrong is over. */
  success(relay: string): void {
    const circuit = this.circuits.get(relay);
    if (!circuit) return;
    const recovered = circuit.openUntil !== 0;
    this.circuits.delete(relay);
    if (recovered) this.options.onRecover?.(relay);
  }

  /** The relay failed a request; a probe that fails trips it again at once. */
  failure(relay: string, kind: RelayFailure, reason: string): void {
    const circuit = this.circuit(relay);
    circuit.failures++;
    circuit.kind = kind;
    circuit.reason = reason;
    if (circuit.probing || circuit.failures >= this.threshold) this.trip(relay, circuit);
  }

  private trip(relay: string, circuit: Circuit): void {
    // What just failed was an answer of sorts: the next early probe (`allDownProbe`) is a full interval away.
    this.lastAllDownProbe = Math.max(this.lastAllDownProbe, this.now());
    const forMs = Math.min(this.baseMs * 2 ** circuit.trips, this.maxMs);
    circuit.openUntil = this.now() + forMs;
    circuit.trips++;
    circuit.failures = 0;
    circuit.probing = false;
    this.options.onTrip?.(relay, circuit.reason ?? "", forMs);
  }

  /** How long until a relay left alone is asked again: its wait, or the next probe while every relay of `relays` is left alone. */
  askedAgainIn(relay: string, relays: string[]): number {
    const wait = this.blockedFor(relay);
    if (!relays.every((r) => this.blockedFor(r) > 0)) return wait;
    return Math.min(wait, Math.max(0, this.lastAllDownProbe + this.allDownProbeMs - this.now()));
  }

  /** A new network: every relay starts fresh. */
  reset(): void {
    this.circuits.clear();
    this.lastAllDownProbe = -Infinity;
  }

  /** Each relay's health, in the order given. */
  health(relays: string[]): RelayHealth[] {
    return relays.map((relay) => {
      const circuit = this.circuits.get(relay);
      if (!circuit || circuit.openUntil === 0 || this.blockedFor(relay) === 0) return { relay, state: "ok" };
      return { relay, state: circuit.kind === "throttled" ? "throttled" : "failing", until: Math.max(circuit.openUntil, this.now()), ...(circuit.reason && { reason: circuit.reason }) };
    });
  }
}
