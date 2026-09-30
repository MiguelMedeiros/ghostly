import { createPairedChat } from "./pairedChat";
import { getInviteCode, loadSession, saveSession } from "./storage";
import { inviteShareText } from "./url";

/**
 * A compatibility chat (WISP 402, a v0.4 code) cannot be converted in place: it has no participation keys to
 * pin. It moves on by a new chat, whose invite is sent as a message in the old one. A contact on a current
 * app opens it and the two pair as any chat does; one still on 0.4 sees a code its app cannot read.
 */
export async function continueInNewChat(oldSessionId: string): Promise<{ sessionId: string; message: string } | null> {
  const old = loadSession(oldSessionId);
  if (!old || old.profile) return null;
  const sessionId = await createPairedChat();
  const code = getInviteCode(sessionId);
  if (!code) return null;
  saveSession({ ...old, continuedIn: sessionId });
  window.dispatchEvent(new Event("session-updated"));
  return { sessionId, message: `Let's continue in a new chat. Open this with an updated Ghostly: ${inviteShareText(code)}` };
}
