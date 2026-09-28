import type { MessagePage, StoredMessage } from "@ghostly/browser/shared/types";

/**
 * The engine's `messagePage` over an in-memory history, for fakes: the same order (time, then id) and the same cut as
 * the store's (`packages/browser/test/messagePage.test.ts` holds the store to it).
 */
export function pageOf(messages: readonly StoredMessage[], { limit = 50, before }: { limit?: number; before?: string | number }): MessagePage {
  const sorted = messages.slice().sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let end = sorted.length;
  if (typeof before === "number") end = sorted.filter((m) => m.timestamp < before).length;
  else if (before !== undefined) {
    end = sorted.findIndex((m) => m.id === before);
    if (end === -1) throw new Error(`No message ${before}`);
  }
  return { messages: sorted.slice(Math.max(0, end - limit), end), more: end > limit };
}
