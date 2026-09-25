import type { Identity } from "./identity";
import type { GhostRecord, SignedPacket } from "./pkarr";

/**
 * How a Ghostly peer reaches Pkarr. Desktop talks to the Mainline DHT directly
 * through the Rust client; browsers cannot open UDP sockets, so they go through
 * Pkarr relays. Both end up in the same DHT and see each other's packets.
 */
/**
 * `background`: a request that can wait (a periodic look at a shared record, not a link's
 * signaling). A transport with a request budget spends only part of it on these, so they never
 * starve the links; one without ignores it.
 */
/**
 * `urgent`: a signal is due any moment (a link polling fast). A transport with more than one relay may
 * ask a second one when the first had nothing new: relays behind one name do not all serve a fresh
 * packet at the same moment.
 */
export interface PkarrRequestOptions { background?: boolean; urgent?: boolean }

/**
 * A request the transport held back to stay within a request budget, its own or a relay's rate limit: nothing went
 * out, and the same request goes through once the budget frees one, in about `retryInMs`. A wait, never a failure:
 * whoever publishes tries again then, and says nothing is wrong meanwhile.
 */
export class DiscoveryBudgetError extends Error {
  readonly code = "discovery-budget";
  constructor(readonly retryInMs: number, message = "Discovery request budget reached; retry shortly") {
    super(message);
    this.name = "DiscoveryBudgetError";
  }
}

/** Whether `error` is a request the budget held back (`DiscoveryBudgetError`), also from another copy of this module. */
export function isDiscoveryBudgetError(error: unknown): error is DiscoveryBudgetError {
  return error instanceof DiscoveryBudgetError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "discovery-budget"
    && typeof (error as { retryInMs?: unknown }).retryInMs === "number");
}

/** When to try again after the budget held a request back: when it frees one, but never sooner than `min` nor later than `max`. */
export function budgetRetryMs(error: DiscoveryBudgetError, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(error.retryInMs) ? error.retryInMs : max));
}

export interface PkarrTransport {
  publish(identity: Identity, records: GhostRecord[], options?: PkarrRequestOptions): Promise<void>;
  /**
   * Puts a relay payload signed elsewhere, byte for byte (a did:dht document: its own record names and
   * a sequence number in seconds). A transport without it cannot publish one.
   */
  publishPayload?(pubKeyZ32: string, payload: Uint8Array, options?: PkarrRequestOptions): Promise<void>;
  /** Most recent packet known for this key, or null when nothing is published. */
  resolve(pubKeyZ32: string, options?: PkarrRequestOptions): Promise<SignedPacket | null>;
  describe(): { protocol: string; relays: string[] };
}
