import { useSyncExternalStore } from "react";
import type { PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** The chat's link as the engine shows it, by the contact's key. */
export function useChatLink(peerKey: string): LinkView | undefined {
  const state = useSyncExternalStore(subscribe, snapshot);
  return state?.links.find(l => l.peerPubKeyZ32 === peerKey);
}

/** The live transport of a chat: on it, and nothing moving. */
export function liveTransport(link?: LinkView): PairedTransport | undefined {
  const pair = link?.pairing;
  return link?.dataLink === "open" && pair?.status === "ready" && link.deliveryMode !== "dht" ? pair.transport : undefined;
}
