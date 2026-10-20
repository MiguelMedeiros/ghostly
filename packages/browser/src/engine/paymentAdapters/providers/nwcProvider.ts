import type { LightningProviderDescriptor } from "./lightning";
import { PROVIDER_PLATFORMS } from "./types";

/**
 * Nostr Wallet Connect as the source picker lists it, and its connection URI. The client (`./nwc`) and its NIP-04 /
 * NIP-44 encryption load when a wallet connects, not with the app.
 */

const MAX_URI = 2048;
const MAX_RELAYS = 5;
const HEX64 = /^[0-9a-f]{64}$/;
const bytes = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  /** The client key the wallet granted: a secret. */
  secret: Uint8Array;
}

/** Only secure relays, except on this machine (a local test relay). */
function checkRelay(address: string): string {
  let relay: URL;
  try { relay = new URL(address); } catch { throw new Error("The connection URI has a relay that is not a URL"); }
  if (relay.username || relay.password || relay.hash) throw new Error("The connection URI has a relay with credentials in it");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(relay.hostname);
  if (!(relay.protocol === "wss:" || (relay.protocol === "ws:" && loopback))) throw new Error("Use a wallet whose relay is secure (wss://)");
  return relay.href;
}

/** Reads a `nostr+walletconnect://` URI. Its errors never repeat it: it holds a secret. */
export function parseNwcUri(input: string): NwcConnection {
  const text = (input ?? "").trim();
  if (text.length > MAX_URI) throw new Error("That connection URI is too long");
  const match = /^(?:nostr\+walletconnect|nostrwalletconnect):(?:\/\/)?([0-9a-fA-F]{64})\/?\?([^#]*)$/.exec(text);
  if (!match) throw new Error("That is not a Nostr Wallet Connect URI (nostr+walletconnect://…)");
  const params = new URLSearchParams(match[2]);
  const secret = (params.get("secret") ?? "").toLowerCase();
  if (!HEX64.test(secret) || /^0+$/.test(secret)) throw new Error("The connection URI has no valid secret");
  const relays = [...new Set(params.getAll("relay").map(checkRelay))];
  if (!relays.length) throw new Error("The connection URI names no relay");
  if (relays.length > MAX_RELAYS) throw new Error("The connection URI names too many relays");
  return { walletPubkey: match[1].toLowerCase(), relays, secret: bytes(secret) };
}

export const nwc: LightningProviderDescriptor = {
  id: "nwc",
  label: "Nostr Wallet Connect",
  kind: "lightning",
  description: "A wallet you connect with its NWC URI (Alby Hub, a node's NWC service, a hosted wallet). That wallet holds the sats and sets its own fee limit: custodial or not depends on the wallet.",
  networks: ["bitcoin", "testnet", "signet", "mutinynet", "regtest"],
  platforms: PROVIDER_PLATFORMS,
  fields: [{
    name: "uri", label: "Connection URI", kind: "secret", placeholder: "nostr+walletconnect://…",
    help: "From your wallet's app connections. Allow making, paying and looking up invoices, and reading the balance.",
  }],
  validate({ secrets }) { parseNwcUri(secrets.uri ?? ""); },
  async create({ secrets }, host) {
    const { NwcLightning } = await import("./nwc");
    return NwcLightning.connect(secrets.uri, { signal: host.signal });
  },
};
