import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { sessionIdForPeer } from "../lib/storage";

const NONE: ReadonlySet<string> = new Set();

/**
 * How long a search stays as answered after what it asked about changed: a chat catching up changes many times a second,
 * and the engine reads a changed chat's whole history again for each answer.
 */
const ASK_AGAIN_MS = 250;

/**
 * The chats the chat list's search finds by a message this page does not hold: where the engine sent each chat's newest
 * page only (the extension's pages), the engine searches their whole histories (`chatsFound`) and answers which chats,
 * by their session ids. Asking for every whole history instead sent each one across as JSON, on the first letter typed.
 * None where every chat's whole history is here (Web, Desktop): the list finds them all itself.
 *
 * It asks again while the search stays typed, when a chat it asked about changed (a message edited, deleted or added) and
 * when the chats to ask about are others (the engine's links or a chat's newest page came after the search was typed).
 */
export function useChatsFound(query: string): ReadonlySet<string> {
  const [found, setFound] = useState<{ query: string; chats: ReadonlySet<string> }>({ query: "", chats: NONE });
  useEffect(() => {
    if (!query) return;
    let asked: ReadonlySet<string> = NONE;
    // Only the latest ask's answer counts: an earlier one read the histories before the change.
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const toAsk = () => (engine.state?.links ?? []).filter((link) => !engine.whole(link.id));
    const ask = () => {
      timer = null;
      const links = toAsk();
      const run = ++latest;
      if (!links.length && asked.size) setFound({ query, chats: NONE });
      asked = new Set(links.map((link) => link.id));
      if (!links.length) return;
      const peers = new Map(links.map((link) => [link.id, link.peerPubKeyZ32]));
      engine.call("chatsFound", { query, linkIds: links.map((link) => link.id) }).then((ids) => {
        if (run === latest) setFound({ query, chats: new Set(ids.flatMap((id) => sessionIdForPeer(peers.get(id) ?? "") ?? [])) });
      }, () => {});
    };
    const askSoon = () => { timer ??= setTimeout(ask, ASK_AGAIN_MS); };
    const others = () => {
      const links = toAsk();
      return links.length !== asked.size || links.some((link) => !asked.has(link.id));
    };
    ask();
    const stopMessages = engine.onMessages((linkId) => { if (asked.has(linkId) || others()) askSoon(); });
    const stopState = engine.subscribe(() => { if (others()) askSoon(); });
    return () => {
      latest = -1;
      if (timer) clearTimeout(timer);
      stopMessages();
      stopState();
    };
  }, [query]);
  // An answer for another search finds nothing for this one.
  return found.query === query ? found.chats : NONE;
}
