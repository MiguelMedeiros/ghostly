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

/** Symmetric rank sum; the fixed order breaks ties deterministically. Neither
 * a remote list nor a preference can add an unavailable local adapter. */
export function rankTransports(local: readonly string[], remote: readonly string[]): PairedTransport[] {
  return TRANSPORTS.filter(t => local.includes(t) && remote.includes(t))
    .sort((a, b) => (local.indexOf(a) + remote.indexOf(a)) - (local.indexOf(b) + remote.indexOf(b))
      || TRANSPORTS.indexOf(a) - TRANSPORTS.indexOf(b));
}

export function transportOrder(available: readonly PairedTransport[], preferred: PairedTransport,
  fallback: boolean): PairedTransport[] {
  const rest = TRANSPORTS.filter(t => available.includes(t) && t !== preferred);
  return [...(available.includes(preferred) ? [preferred] : []), ...(fallback ? rest : [])];
}
