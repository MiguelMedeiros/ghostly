import { foldText } from "../shared/fold";
import { isSystemLine } from "../shared/systemLines";
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

/**
 * What a message offers the chat list's search, folded and loose: a file's name, a text's words; nothing for a payment
 * or a line the pages draw as the app's own (a joined line, a refused payment's: `isSystemLine`), which their search
 * leaves out too.
 */
function searchTexts(message: StoredMessage): string[] {
  if (message.paymentId || isSystemLine(message)) return [];
  if (message.file) return [loose(foldText(message.file.name))];
  if (!message.text) return [];
  const folded = foldText(message.text);
  const shown = loose(folded.replace(LINK, "]"));
  const withLinks = loose(folded);
  return shown === withLinks ? [shown] : [shown, withLinks];
}

/** A chat's texts as kept: by message, and the messages changed since, to read again at the next search. */
interface Kept { texts: Promise<Map<string, string[]>>; changed: Set<string> }

/**
 * The chat list's search over the chats' whole histories, in the engine (`chatsFound`): a page that holds a chat's
 * newest page only (the extension's) finds it by an older message too, without being sent its whole history. Each chat's
 * texts are read and folded once, and after a change only the rows that changed are read again (`changed`, as the pages
 * hear it): a chat catching up while a search is typed changes many times a second, and its whole history read again
 * for each answer took the engine's thread (a 20,000-message chat, about 150 ms a read, up to four a second).
 */
export class ChatTextSearch {
  /** Per chat, its messages' texts folded. */
  private readonly texts = new Map<string, Kept>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly read: (linkId: string) => Promise<StoredMessage[]>,
    /** These rows of a chat as stored now, `undefined` for one not there any more. */
    private readonly readRows: (linkId: string, ids: readonly string[]) => Promise<(StoredMessage | undefined)[]>,
  ) {}

  /** The chats among `linkIds` with a message whose text holds `query` (folded as `foldText` does, marks out), in that order. */
  async found(linkIds: readonly string[], query: string): Promise<string[]> {
    const q = loose(foldText(query));
    if (!q) return [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.texts.clear(); }, SEARCH_KEPT_MS);
    // It keeps no process up (the CLI's).
    (this.timer as { unref?: () => void }).unref?.();
    const found = (texts: Map<string, string[]>) => { for (const one of texts.values()) if (one.some((text) => text.includes(q))) return true; return false; };
    const hits = await Promise.all(linkIds.map(async (linkId) => found(await this.textsOf(linkId))));
    return linkIds.filter((_, i) => hits[i]);
  }

  /**
   * These rows of a chat changed (added, edited or deleted): they are read again at the next search. One that changed
   * while the chat's history was still being read is read again after it, whatever that read found.
   */
  changed(linkId: string, ids: readonly string[]): void {
    const kept = this.texts.get(linkId);
    if (kept) for (const id of ids) kept.changed.add(id);
  }

  /**
   * A chat deleted: its texts go. The same invite joined again is a chat of the same id, and only the rows it changes
   * are read again: it was found by the deleted chat's words for as long as a search went on.
   */
  forget(linkId: string): void {
    this.texts.delete(linkId);
  }

  private textsOf(linkId: string): Promise<Map<string, string[]>> {
    let kept = this.texts.get(linkId);
    if (!kept) {
      const texts = this.read(linkId).then((messages) => new Map(messages.map((message) => [message.id, searchTexts(message)])));
      kept = { texts, changed: new Set() };
      this.texts.set(linkId, kept);
    } else if (kept.changed.size) {
      const ids = [...kept.changed];
      kept.changed.clear();
      kept.texts = kept.texts.then(async (texts) => {
        const rows = await this.readRows(linkId, ids);
        ids.forEach((id, i) => { const row = rows[i]; if (row) texts.set(id, searchTexts(row)); else texts.delete(id); });
        return texts;
      });
    } else return kept.texts;
    const { texts } = kept;
    // A read that failed is not kept: the next search reads the whole chat again.
    texts.catch(() => { if (this.texts.get(linkId)?.texts === texts) this.texts.delete(linkId); });
    return texts;
  }
}
