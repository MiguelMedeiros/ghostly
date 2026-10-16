import { engine } from "@ghostly/browser/platform/engine";
import { ensureSession, findSession, updateSessionLabel } from "./storage";

/**
 * A chat the engine made by itself for a contact link (WISP 8xx: a request accepted, or one sent through someone's
 * link), taken into this app's chat list as a chat the app made: the app keeps its own list of chats, and drops a
 * link that has none (`platform/sync.ts`). The chat's id here, for its address.
 */
export async function adoptEngineChat(linkId: string): Promise<string> {
  const peer = engine.state?.links.find((l) => l.id === linkId)?.peerPubKeyZ32;
  const link = (await engine.call("exportLinks")).find((l) => l.peerPubKeyZ32 === peer);
  if (!peer || !link) throw new Error("The chat was not made. Try again.");
  const existing = findSession(link.seedB64, link.peerPubKeyZ32);
  const id = existing?.id ?? ensureSession(
    { profile: link.profile, deliveryMode: link.deliveryMode, seedB64: link.seedB64, peerPubKeyB64: link.peerPubKeyZ32, encKeyB64: link.encKeyB64 },
    { inviteCode: link.inviteCode, createdAt: link.createdAt },
  );
  if (!existing && link.label) updateSessionLabel(id, link.label);
  window.dispatchEvent(new Event("session-updated"));
  return id;
}
