import type { LinkView } from "@ghostly/browser/shared/types";
import { useEngineValue } from "../lib/engineState";

/**
 * What the chat page shows of its link: its id, the pin, whether the contact can be woken for a call, and the timeline's
 * transport and identity lines. The rest changes all the time with nothing of it on the page (each poll, the contact
 * typing or coming online, the last message's time): the parts that show those read the link themselves.
 */
export type ChatLinkShown = Pick<LinkView, "id" | "pin" | "peerWakes" | "transportLog" | "identityTimeline" | "identities">;

const shown = (link: LinkView): ChatLinkShown => ({
  id: link.id, pin: link.pin, peerWakes: link.peerWakes, transportLog: link.transportLog, identityTimeline: link.identityTimeline, identities: link.identities,
});

/** The chat's link as the page shows it (`ChatLinkShown`), by the contact's key: drawn again only when that changes. */
export function useChatLink(peerKey: string): ChatLinkShown | undefined {
  return useEngineValue((state) => {
    const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
    return link && shown(link);
  });
}
