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
export interface PkarrRequestOptions { background?: boolean }

export interface PkarrTransport {
  publish(identity: Identity, records: GhostRecord[], options?: PkarrRequestOptions): Promise<void>;
  /** Most recent packet known for this key, or null when nothing is published. */
  resolve(pubKeyZ32: string, options?: PkarrRequestOptions): Promise<SignedPacket | null>;
  describe(): { protocol: string; relays: string[] };
}
