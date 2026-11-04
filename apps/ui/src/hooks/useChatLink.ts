import type { LinkView } from "@ghostly/browser/shared/types";
import { useEngineValue } from "../lib/engineState";

/** The chat's link as the engine shows it, by the contact's key: drawn again only when that link changes. */
export function useChatLink(peerKey: string): LinkView | undefined {
  return useEngineValue((state) => state?.links.find(l => l.peerPubKeyZ32 === peerKey));
}
