import type { GhostlyNode } from "@ghostly/browser/engine/node";
import type { EventHub } from "./events";

/**
 * What the app's chat screen does by itself, done here for a profile no screen shows (src/hooks/useChat.ts): the side
 * that joined says "👋 <name> joined" once the chat first goes live, and the side that invited answers once. Contacts
 * see the bot arrive as they see a person; each is said once per chat, across restarts.
 */
export function announceJoins(hub: EventHub, node: GhostlyNode): () => void {
  const say = (chat: string) => {
    if (hub.said(chat, "join")) return;
    hub.markSaid(chat, "join");
    const nick = node.getState().settings.nick?.trim();
    void node.sendMessage({ linkId: chat, text: nick ? `👋 ${nick} joined` : "👋 joined" }).catch(() => {});
  };
  return hub.onEvent((event) => {
    const chat = event.chat as string | undefined;
    if (!chat) return;
    const link = node.getState().links.find((l) => l.id === chat);
    if (!link?.profile) return;
    // The joiner once its first pairing is live; the other side when a notice arrives (said once either way).
    if (event.type === "chat.connection" && event.live && link.pairingProgress?.role === "joiner") say(chat);
    else if (event.type === "chat.joined") say(chat);
  });
}
