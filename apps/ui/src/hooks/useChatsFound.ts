import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { sessionIdForPeer } from "../lib/storage";

const NONE: ReadonlySet<string> = new Set();

/**
 * The chats the chat list's search finds by a message this page does not hold: where the engine sent each chat's newest
 * page only (the extension's pages), the engine searches their whole histories (`chatsFound`) and answers which chats,
 * by their session ids. Asking for every whole history instead sent each one across as JSON, on the first letter typed.
 * None where every chat's whole history is here (Web, Desktop): the list finds them all itself.
 */
export function useChatsFound(query: string): ReadonlySet<string> {
  const [found, setFound] = useState<{ query: string; chats: ReadonlySet<string> }>({ query: "", chats: NONE });
  useEffect(() => {
    if (!query) return;
    const links = (engine.state?.links ?? []).filter((link) => !engine.whole(link.id));
    if (!links.length) return;
    let current = true;
    const peers = new Map(links.map((link) => [link.id, link.peerPubKeyZ32]));
    engine.call("chatsFound", { query, linkIds: links.map((link) => link.id) }).then((ids) => {
      if (current) setFound({ query, chats: new Set(ids.flatMap((id) => sessionIdForPeer(peers.get(id) ?? "") ?? [])) });
    }, () => {});
    return () => { current = false; };
  }, [query]);
  // An answer for another search finds nothing for this one.
  return found.query === query ? found.chats : NONE;
}
