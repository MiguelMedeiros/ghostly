/**
 * The person's name in a chat, for an app granted `name` (WISP 1200 § Permissions): the name this profile tells the
 * contact of that chat (WISP 04), as the contact's app shows it. Never more than the contact was told:
 *
 * - no name while the profile does not share its name and picture (`shareProfile`, absent meaning on), or has none;
 * - no name outside a paired 1:1 chat, and none before the contact was heard from there (`peerNick` absent): both
 *   sides say their names when a session opens, so until then the contact may not have it;
 * - the name as the contact's app keeps it (`sanitizeNick`: no hidden characters, 64 at most), so a name that would
 *   reach the contact as none is none here too.
 *
 * It is always the profile's own name. An identity shared in the chat (Nostr, Pubky...) changes nothing the profile
 * says: the contact may choose to show the profile as one of them, or under a nickname, on their device only, and
 * that choice is never sent.
 */
import { sanitizeNick } from "@ghostly/core";
import type { EngineState } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";

export function nameToldIn(state: Pick<EngineState, "settings" | "links"> | null | undefined, linkId: string): string | undefined {
  if (!state || state.settings.shareProfile === false) return undefined;
  const link = state.links.find((l) => l.id === linkId);
  if (link?.profile !== "paired-chat/1" || link.peerNick === undefined) return undefined;
  return sanitizeNick(state.settings.nick);
}

/** What every client's opener is given (`nameIn`): read when the app opens. */
export const nameInChat = (linkId: string): string | undefined => nameToldIn(engine.state, linkId);
