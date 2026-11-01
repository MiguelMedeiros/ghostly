import type { MessagePage, StoredMessage } from "@ghostly/browser/shared/types";

/**
 * The engine's `messagePage` over an in-memory history, for fakes: the same order (time, then id) and the same cut as
 * the store's (`packages/browser/test/messagePage.test.ts` holds the store to it).
 */
export function pageOf(messages: readonly StoredMessage[], { limit = 50, before, after }: { limit?: number; before?: string | number; after?: string | number }): MessagePage {
  const sorted = messages.slice().sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** Where a bound falls: the messages before it are `sorted.slice(0, place)`; `past` takes a message's own place too. */
  const place = (bound: string | number, past: boolean) => {
    if (typeof bound === "number") return sorted.filter((m) => (past ? m.timestamp <= bound : m.timestamp < bound)).length;
    const at = sorted.findIndex((m) => m.id === bound);
    if (at === -1) throw new Error(`No message ${bound}`);
    return past ? at + 1 : at;
  };
  const end = before === undefined ? sorted.length : place(before, false);
  if (after === undefined) return { messages: sorted.slice(Math.max(0, end - limit), end), more: end > limit };
  const start = place(after, true);
  return { messages: sorted.slice(start, Math.max(start, Math.min(end, start + limit))), more: end - start > limit };
}
