import { createLink, encodeInviteCode } from "@ghostly/core";
import { ensureSession } from "./storage";

/** Default for new chats. Existing conversations and legacy invites keep their profile. */
export function createPairedChat(): string {
  const { mine, invite } = createLink();
  const sessionId = ensureSession(
    { seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1" },
    { inviteCode: encodeInviteCode({ ...invite, profile: "paired-chat/1" }) },
  );
  window.dispatchEvent(new Event("session-updated"));
  return sessionId;
}
