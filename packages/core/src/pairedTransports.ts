import type { FrameChannel } from "./frames";

export const TRANSPORTS = ["iroh/1", "hyperdht/1", "webrtc/1"] as const;
export type PairedTransport = typeof TRANSPORTS[number];
export type NativeTransport = Exclude<PairedTransport, "webrtc/1">;

/** Supplied only by the local adapter after its real cryptographic handshake.
 * Iroh uses a TLS exporter; HyperDHT uses its Noise handshake hash. */
export interface NativeBinding {
  transport: NativeTransport;
  context: string;
  identities: [string, string];
}
export interface BoundChannel { channel: FrameChannel; binding: NativeBinding }
export interface NativeEndpoint {
  transport: NativeTransport;
  descriptor: unknown;
  connect(descriptor: unknown): Promise<BoundChannel>;
  close(): Promise<void>;
  onConnection: ((connection: BoundChannel) => void) | null;
  onDescriptor: (() => void) | null;
  onUnavailable?: (() => void) | null;
}
export type TransportDescriptors = Partial<Record<NativeTransport, unknown>>;

/**
 * One spelling per Iroh relay. Iroh compares relay URLs as text, and its own relays are named with the trailing dot
 * of a fully qualified name (`https://use1-1.relay.n0.iroh.link./`): the same server written without the dot is
 * another relay to it, and an endpoint dialling a contact there opens a second connection to the server it is already
 * homed on, which the server answers by setting the first one aside.
 *
 * So every relay URL is put in one spelling before it goes into an Iroh endpoint (the relays it homes on, a contact's
 * descriptor before a dial), and which one depends on the endpoint:
 * - `"dotted"`, the name with its trailing dot: what native Iroh homes on by default (the Desktop), and the form to
 *   compare two relays in.
 * - `"plain"`, the name without it: the only one every browser opens. WebKit (Safari, the iPhone app) refuses a
 *   host name that ends in a dot, for `fetch` and for a WebSocket alike, so nothing a browser's Iroh is given has one.
 *
 * An IP address and a single-label name (a search domain may complete it) stay as written; `localhost.` loses its dot
 * in both, the form the relay settings accept. What does not parse comes back untouched, for the caller's own check.
 */
export type IrohRelaySpelling = "dotted" | "plain";
export function irohRelayUrl(value: string, spelling: IrohRelaySpelling = "dotted"): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  const host = url.hostname, name = host.replace(/\.$/, "");
  if (!name.includes(".") && name !== "localhost") return value;
  if (name.startsWith("[") || /^\d+(\.\d+){3}$/.test(name)) return value;
  const wanted = spelling === "plain" || name === "localhost" ? name : `${name}.`;
  if (wanted === host) return value;
  url.hostname = wanted;
  return url.href;
}

/** An Iroh descriptor with its relay in one spelling (`irohRelayUrl`); anything else as it is. */
export function irohDescriptor<T>(descriptor: T, spelling: IrohRelaySpelling = "dotted"): T {
  const relay = (descriptor as { relay?: unknown } | null | undefined)?.relay;
  if (typeof relay !== "string") return descriptor;
  const canonical = irohRelayUrl(relay, spelling);
  return canonical === relay ? descriptor : { ...descriptor, relay: canonical };
}

/**
 * Relay only (WISP 100, "Relayed"): the transport reaches this contact only through a relay server, never
 * directly. A descriptor says so with `relayed: true`, and an Iroh descriptor with no direct address is relayed
 * too (a browser's, WISP 102). Either side being relay only makes the whole path relayed. Both sides hold both
 * descriptors after the exchange, so they agree, and the rank stays symmetric.
 */
export function relayedTransports(local: TransportDescriptors, remote: TransportDescriptors): NativeTransport[] {
  const relayOnly = (transport: NativeTransport, descriptor: unknown): boolean => {
    if (!descriptor || typeof descriptor !== "object") return false;
    const d = descriptor as { relayed?: unknown; addresses?: unknown };
    return d.relayed === true || (transport === "iroh/1" && Array.isArray(d.addresses) && d.addresses.length === 0);
  };
  return (["iroh/1", "hyperdht/1"] as const).filter(t => relayOnly(t, local[t]) || relayOnly(t, remote[t]));
}

/** Symmetric rank sum; the fixed order breaks ties deterministically. Neither
 * a remote list nor a preference can add an unavailable local adapter. A
 * relayed transport ranks after every direct one: it is where a failed direct
 * path goes, never ahead of one that works. */
export function rankTransports(local: readonly string[], remote: readonly string[], relayed: readonly string[] = []): PairedTransport[] {
  const penalty = (t: PairedTransport) => relayed.includes(t) ? 1 : 0;
  return TRANSPORTS.filter(t => local.includes(t) && remote.includes(t))
    .sort((a, b) => penalty(a) - penalty(b)
      || (local.indexOf(a) + remote.indexOf(a)) - (local.indexOf(b) + remote.indexOf(b))
      || TRANSPORTS.indexOf(a) - TRANSPORTS.indexOf(b));
}

/**
 * What a chat prefers when nobody chose (Automatic): WebRTC where the app has it, else the first transport it has
 * (a Linux Desktop: WebKitGTK has no WebRTC). With nothing at all, WebRTC, which the offer then leaves out.
 */
export function automaticTransport(available: readonly PairedTransport[]): PairedTransport {
  return available.includes("webrtc/1") ? "webrtc/1" : TRANSPORTS.find(t => available.includes(t)) ?? "webrtc/1";
}

export function transportOrder(available: readonly PairedTransport[], preferred: PairedTransport,
  fallback: boolean): PairedTransport[] {
  const rest = TRANSPORTS.filter(t => available.includes(t) && t !== preferred);
  return [...(available.includes(preferred) ? [preferred] : []), ...(fallback ? rest : [])];
}
