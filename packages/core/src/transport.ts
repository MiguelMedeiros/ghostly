import type { Identity } from "./identity";
import type { GhostRecord, SignedPacket } from "./pkarr";

/**
 * How a Ghostly peer reaches Pkarr. Desktop talks to the Mainline DHT directly
 * through the Rust client; browsers cannot open UDP sockets, so they go through
 * Pkarr relays. Both end up in the same DHT and see each other's packets.
 */
export interface PkarrTransport {
  publish(identity: Identity, records: GhostRecord[]): Promise<void>;
  /** Most recent packet known for this key, or null when nothing is published. */
  resolve(pubKeyZ32: string): Promise<SignedPacket | null>;
  describe(): { protocol: string; relays: string[] };
}
