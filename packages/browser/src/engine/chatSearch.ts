import { foldText } from "../shared/fold";
import type { StoredMessage } from "../shared/types";

/**
 * How long the chats' folded texts stay after the last search: a search asks again at each letter typed, and each chat
 * is read from the store once for all of them. Then they go: the extension's engine runs with no page open, and would
 * keep every chat's text for good after one search.
 */
export const SEARCH_KEPT_MS = 60_000;

/**
 * Formatting's marks, which a bubble does not show, and a `[label](link)`'s brackets and link: "*hello* world" reads
 * "hello world". The pages parse a text to read it as it shows (apps/ui lib/chatSearch `searchText`); the engine has
 * no parser, so it leaves every such mark out of both the text and the query. That finds what the pages find (but by
 * a query of marks alone) and a little more ("*hello*" finds "hello"). A link is still found by its address.
 */
const MARKS = /[*_~|`[\]]/g;
const LINK = /\]\([^)\s]*\)/g;
const loose = (folded: string) => folded.replace(MARKS, "");

/** What a message offers the chat list's search, folded and loose: a file's name, a text's words; nothing for a payment. */
function searchTexts(message: StoredMessage): string[] {
  if (message.paymentId) return [];
  if (message.file) return [loose(foldText(message.file.name))];
  if (!message.text) return [];
  const folded = foldText(message.text);
  const shown = loose(folded.replace(LINK, "]"));
  const withLinks = loose(folded);
  return shown === withLinks ? [shown] : [shown, withLinks];
}

/**
 * The chat list's search over the chats' whole histories, in the engine (`chatsFound`): a page that holds a chat's
 * newest page only (the extension's) finds it by an older message too, without being sent its whole history. Each chat's
 * texts are read and folded once, and read again only after the chat changed (`changed`, as the pages hear it).
 */
export class ChatTextSearch {
  /** Per chat, its messages' texts folded, as read after its last change. */
  private readonly texts = new Map<string, Promise<string[]>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly read: (linkId: string) => Promise<StoredMessage[]>) {}

  /** The chats among `linkIds` with a message whose text holds `query` (folded as `foldText` does, marks out), in that order. */
  async found(linkIds: readonly string[], query: string): Promise<string[]> {
    const q = loose(foldText(query));
    if (!q) return [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.texts.clear(); }, SEARCH_KEPT_MS);
    // It keeps no process up (the CLI's).
    (this.timer as { unref?: () => void }).unref?.();
    const hits = await Promise.all(linkIds.map(async (linkId) => (await this.textsOf(linkId)).some((text) => text.includes(q))));
    return linkIds.filter((_, i) => hits[i]);
  }

  /** A chat's history changed: its texts are read again at the next search. A read still out stays the one it began as. */
  changed(linkId: string): void {
    this.texts.delete(linkId);
  }

  private textsOf(linkId: string): Promise<string[]> {
    let texts = this.texts.get(linkId);
    if (!texts) {
      texts = this.read(linkId).then((messages) => messages.flatMap(searchTexts));
      this.texts.set(linkId, texts);
      // A read that failed is not kept: the next search reads again.
      texts.catch(() => { if (this.texts.get(linkId) === texts) this.texts.delete(linkId); });
    }
    return texts;
  }
}
