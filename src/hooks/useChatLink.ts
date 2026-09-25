import { useSyncExternalStore } from "react";
import type { LinkView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;

/** The chat's link as the engine shows it, by the contact's key. */
export function useChatLink(peerKey: string): LinkView | undefined {
  const state = useSyncExternalStore(subscribe, snapshot);
  return state?.links.find(l => l.peerPubKeyZ32 === peerKey);
}
