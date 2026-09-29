import { createChatInvite, type LinkParams } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { ensureSession } from "./storage";

/**
 * Default for new chats: a `ghostly1` invite (WISP 801); this side keeps the participation seed whose public
 * key the code carries. Existing conversations and older invites keep their profile. The keys come from
 * the engine when it answers in time: it keeps a pair warmed on the network, so the contact's first packet
 * lands in under a second instead of the seconds a key nobody has heard of takes (`takeInvite`).
 */
export async function createPairedChat(): Promise<string> {
  const { mine, inviteCode } = await takeInvite();
  const sessionId = ensureSession(
    { seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1", participationSeedB64: mine.participationSeedB64 },
    { inviteCode },
  );
  window.dispatchEvent(new Event("session-updated"));
  return sessionId;
}

/** The engine's warmed keys, or fresh ones made here when it does not answer within a moment. */
async function takeInvite(): Promise<{ mine: LinkParams; inviteCode: string }> {
  const fresh = () => {
    const { mine, inviteCode } = createChatInvite();
    return { mine, inviteCode };
  };
  try {
    return await Promise.race([
      engine.call("takeInvite"),
      new Promise<ReturnType<typeof fresh>>((resolve) => setTimeout(() => resolve(fresh()), 1_500)),
    ]);
  } catch { return fresh(); }
}
