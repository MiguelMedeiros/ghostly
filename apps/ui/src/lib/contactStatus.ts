import type { PeerLinkState } from "./platform";
import { transportName } from "./connection";
import type { Translate, TranslationKey } from "../locales/translate";

/** A successful discovery read is not evidence of a live contact. */
export function contactStatus(peer: PeerLinkState | null | undefined, paired: boolean, status: string): string {
  if (status === "offline") return "Offline";
  if (peer?.pairing?.keyMismatch) return "Identity mismatch";
  if (peer?.pairing?.status === "error" || peer?.pairing?.transitionError) return "Connection issue";
  if (peer?.deliveryMode !== "dht" && peer?.dataLink === "open" && (!paired || peer.pairing?.status === "ready")) return "Connected";
  if (status === "error") return "Discovery unavailable";
  if (peer?.textDelivery === "hold") return "Away · messages are held";
  // The one chat's states (WISP 400): DHT only by choice, or on the DHT while a live link is retried.
  if (peer?.deliveryMode === "dht") return "DHT only · chosen by you";
  if (peer?.textDelivery === "dht" && peer.dhtDelivery?.peerMode === "dht") return "DHT only · chosen by your contact";
  // A chosen transport not reached yet, with nothing else allowed to carry the chat (WISP 100): not a connection issue.
  if (peer?.transportWait && !peer.transportWait.live && !peer.pairing?.transitionTarget) {
    const t = transportName(peer.transportWait.transport);
    return peer.textDelivery === "dht" ? `On DHT · waiting for ${t}` : `Waiting for ${t}`;
  }
  if (peer?.textDelivery === "dht") return "On DHT · retrying live";
  if (peer?.pairing?.status === "confirm") return "Confirm contact";
  if (peer?.dataLink === "connecting" || peer?.pairing?.transitionTarget) return "Connecting";
  return "Waiting for contact";
}

/**
 * A v0.4-code chat's status, as `contactStatus` has it (in English: it is also the `data-status` tests read), in the
 * person's language. One this does not know stays as it is.
 */
export function statusWords(status: string, t: Translate): string {
  const fixed: Record<string, TranslationKey> = {
    "Offline": "connection.state.offline", "Identity mismatch": "connection.state.identityMismatch", "Connection issue": "connection.state.issue",
    "Connected": "connection.state.connectedPlain", "Discovery unavailable": "connection.state.discoveryUnavailable", "Away · messages are held": "connection.state.held",
    "DHT only · chosen by you": "connection.state.dhtByYou", "DHT only · chosen by your contact": "connection.state.dhtByContact",
    "On DHT · retrying live": "connection.state.onDht", "Confirm contact": "connection.state.confirmContact", "Connecting": "connection.state.connecting",
    "Waiting for contact": "connection.state.waitingContact",
  };
  if (fixed[status]) return t(fixed[status]);
  const waiting = /^(On DHT · waiting|Waiting) for (.+)$/.exec(status);
  if (waiting) return t(waiting[1] === "Waiting" ? "connection.waitingFor" : "connection.state.dhtWaitingFor", { transport: waiting[2] });
  return status;
}
