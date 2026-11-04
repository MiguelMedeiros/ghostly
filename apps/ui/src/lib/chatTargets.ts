import type { KeyboardEvent, RefObject } from "react";

/** The chats whose name holds what was typed, in any case, in the list's order; all of them while nothing is typed. */
export function findChatTargets<T extends { name: string }>(targets: readonly T[], query: string): readonly T[] {
  const words = query.trim().toLocaleLowerCase();
  return words ? targets.filter(target => target.name.toLocaleLowerCase().includes(words)) : targets;
}

/** The rows of a picker's list that can take the focus now. */
export const chatTargetRows = (list: HTMLElement | null) => [...list?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];

/**
 * The arrow keys, Home and End on a picker's list: from chat to chat, and up from the first back to the search. Enter
 * or Space picks the chat in focus, as a click does.
 */
export function chatTargetKeys(search: RefObject<HTMLInputElement | null>) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = chatTargetRows(e.currentTarget);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0 && search.current) { search.current.focus(); return; }
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
      : e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
    rows[next]!.focus();
  };
}
