import { useCallback, useReducer } from "react";

/*
 * The edit open in each chat's composer, kept while the chat's page is away: the Share to… picker shown instead of it
 * (a share from another app goes there first), another chat opened meanwhile. Back on the chat, the edit is open again
 * with the words typed into it, and the draft set aside is still aside, as the draft itself is kept per chat. Only in
 * memory, as the page's own state was: a reload ends the edit, and the draft (in storage) is the field's again.
 *
 * Two halves, as the page and its composer hold them: which message is edited (the page: Chat, GroupChat), and the
 * words typed for it so far (the composer, MessageInput). A chat is the composer's draft id: a session id, or
 * `group:<id>`.
 */
const edited = new Map<string, unknown>();
const words = new Map<string, { key: string; text: string }>();

/** The message edited in this chat, as its page chose it; null when none is. */
export function keptEdit<T>(chat: string): T | null {
  return (edited.get(chat) as T | undefined) ?? null;
}

/** The message this chat's composer edits from now on; null ends the edit, its words with it. */
export function keepEdit<T>(chat: string, message: T | null): void {
  if (message) edited.set(chat, message);
  else { edited.delete(chat); words.delete(chat); }
}

/** The words typed so far for the edit of `key` in this chat, if the composer went while it was open. */
export function keptEditWords(chat: string, key: string): string | undefined {
  const kept = words.get(chat);
  return kept?.key === key ? kept.text : undefined;
}

/** The edit field's words now; a null key: the edit ended, nothing to keep. */
export function keepEditWords(chat: string, key: string | null, text = ""): void {
  if (key) words.set(chat, { key, text });
  else words.delete(chat);
}

/** Every chat's (a test's start). */
export function forgetKeptEdits(): void {
  edited.clear();
  words.clear();
}

/**
 * The page's edit, as `useState` would hold it but kept per chat across the page going and coming back. A page that
 * changes chats (GroupChat stays mounted from one group to the next) shows the new chat's edit, if it has one.
 */
export function useKeptEdit<T>(chat: string): [T | null, (message: T | null) => void] {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const set = useCallback((message: T | null) => { keepEdit(chat, message); redraw(); }, [chat]);
  return [keptEdit<T>(chat), set];
}
