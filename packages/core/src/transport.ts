import type { DiscoveryStatus } from "./relayBreaker";
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
/**
 * `group`: a group's request (its edges' signaling, a knock, a community's shared records). A transport with a
 * request budget keeps the last part of each minute for a 1:1 chat it had to hold back; one without ignores it.
 */
/** What changed in how discovery goes: a relay tripped (left alone), or one answered again. */
export type DiscoveryChange = "tripped" | "recovered";

/**
 * `door`: a community door reading its knock bell. A background read, but not held to the small share while a link
 * signals (`BACKGROUND_WHILE_SIGNALING`): the door admitting one person opens links that signal, and the next person's
 * knock would wait for them (2026-09-28).
 *
 * `signal`: a link's WebRTC signaling, what its contact waits for: the write of a new offer or answer, or a read for
 * the answer while this side's offer is out, or the reads of a DHT-only contact's mailbox once it shows it is leaving,
 * up to three while it still says DHT only (the live link waits on them). A 1:1 chat's may go a little over the relay's minute
 * (`SIGNALING_ALLOWANCE_SHARE` in relay.ts).
 */
export interface PkarrRequestOptions { background?: boolean; urgent?: boolean; group?: boolean; door?: boolean; signal?: boolean }

/**
 * `transport` with `extra` added to every request's options: a group's edges say `group` so. The optional methods
 * stay optional (a caller reads `configure` as "the DHT is reached directly").
 */
export function withRequestOptions(transport: PkarrTransport, extra: PkarrRequestOptions): PkarrTransport {
  const wrapped: PkarrTransport = {
    publish: (identity, records, options) => transport.publish(identity, records, { ...options, ...extra }),
    resolve: (pubKeyZ32, options) => transport.resolve(pubKeyZ32, { ...options, ...extra }),
    describe: () => transport.describe(),
  };
  if (transport.publishPayload) wrapped.publishPayload = (pubKeyZ32, payload, options) => transport.publishPayload!(pubKeyZ32, payload, { ...options, ...extra });
  if (transport.discovery) wrapped.discovery = () => transport.discovery!();
  if (transport.subscribe) wrapped.subscribe = (listener) => transport.subscribe!(listener);
  if (transport.networkChanged) wrapped.networkChanged = () => transport.networkChanged!();
  if (transport.readAnsweredAt) wrapped.readAnsweredAt = (pubKeyZ32) => transport.readAnsweredAt!(pubKeyZ32);
  if (transport.onServerTime) wrapped.onServerTime = (listener) => transport.onServerTime!(listener);
  if (transport.configure) wrapped.configure = (options) => transport.configure!(options);
  return wrapped;
}

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

/**
 * A server's own time: the `Date` header (ms, to the second) of its answer to a request that went out at `sent` and
 * came back at `received`, both by this device's clock. `source` names the server (a relay's origin), never a key.
 */
export interface ServerTime { source: string; date: number; sent: number; received: number }

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
  /** How reads go and how each relay is doing, for the connection panel; absent where nothing is known. */
  discovery?(): DiscoveryStatus;
  /**
   * Called when that changes in a way worth showing (a relay trips or recovers), with `"recovered"` when a relay
   * answered again after failing: links then look and publish at once rather than at their pace. Returns the unsubscribe.
   */
  subscribe?(listener: (change?: DiscoveryChange) => void): () => void;
  /** The device changed networks (back online): what was learnt about failing relays is forgotten, and links look again. */
  networkChanged?(): void;
  /**
   * When the network last answered a read of this key (this clock), whatever it answered. A `resolve` may hand back a
   * copy it kept (the budget held the read, every relay was resting, the same key was read a moment ago): a caller
   * that reasons from "the record did not have this at my last read" asks this to know the read was one. Absent
   * where the transport cannot say; such a caller then takes no read for one.
   */
  readAnsweredAt?(pubKeyZ32: string): number | undefined;
  /**
   * Called with each time a server gave (`ServerTime`), where the transport can read one: what `ClockWatch` holds this
   * device's clock against. Returns the unsubscribe.
   */
  onServerTime?(listener: (time: ServerTime) => void): () => void;
  /**
   * Where the DHT is reached directly (Desktop): the relays from Settings, and whether reads may use them too
   * (`readRelays`, "Also use Pkarr relays"). Writes go to them either way, so browser contacts see this peer's packets.
   */
  configure?(options: { relays: string[]; readRelays: boolean }): void;
}
