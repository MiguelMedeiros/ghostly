import type { PeerLinkState } from "./platform";

/** A successful discovery read is not evidence of a live contact. */
export function contactStatus(peer: PeerLinkState | null | undefined, paired: boolean, status: string): string {
  if (status === "offline") return "Offline";
  if (peer?.pairing?.keyMismatch) return "Identity mismatch";
  if (peer?.pairing?.status === "error" || peer?.pairing?.transitionError) return "Connection issue";
  if (peer?.deliveryMode !== "dht" && peer?.dataLink === "open" && (!paired || peer.pairing?.status === "ready")) return "Connected";
  if (status === "error") return "Discovery unavailable";
  if (peer?.textDelivery === "hold") return "Away · messages are held";
  if (peer?.deliveryMode === "dht" || peer?.textDelivery === "dht") return "DHT text · presence unknown";
  if (peer?.pairing?.status === "confirm") return "Confirm contact";
  if (peer?.dataLink === "connecting" || peer?.pairing?.transitionTarget) return "Connecting";
  return "Waiting for contact";
}
