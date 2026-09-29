import type { PairedTransport } from "@ghostly/core";

/**
 * Each transport's own mark, distinct by shape (never by colour alone) and legible at the header's 18 px:
 * WebRTC a globe (the browser's web), Iroh two endpoints joined straight (a direct QUIC path), HyperDHT a
 * triangle of peers (a DHT mesh).
 */
export function TransportIcon({ transport, size = 14, weight = 1.7 }: { transport?: PairedTransport; size?: number; weight?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round"
    className="shrink-0" data-transport-icon={transport ?? "webrtc/1"}>
    {transport === "iroh/1" ? <><circle cx="5" cy="12" r="3" /><circle cx="19" cy="12" r="3" /><path d="M8 12h8" /></>
      : transport === "hyperdht/1" ? <><circle cx="12" cy="4.5" r="2.5" /><circle cx="4.5" cy="18.5" r="2.5" /><circle cx="19.5" cy="18.5" r="2.5" /><path d="m10.8 6.7-5 9.6m8.4-9.6 5 9.6M7 18.5h10" /></>
      : <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>}
  </svg>;
}
