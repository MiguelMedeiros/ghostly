import { useLayoutEffect, useRef, type RefObject } from "react";

/** A row's chat as the rail names it: a chat's id, or `group:<id>` (`groupChat`), whichever list it is in. */
const rowChat = (row: Element) => row.getAttribute("data-chat") ?? (row.hasAttribute("data-group") ? `group:${row.getAttribute("data-group")}` : null);

/**
 * The open chat's row (or its place on the rail) is brought into view once, when it is out of sight: a chat opened from
 * outside the list (a start of the app, a notification, a link) is shown where it is in a long list. Once per open chat
 * and per list drawn (the list and the rail are two): later draws, and the person's own scrolling, leave the list where
 * it is. A row clicked is in sight, so a click moves nothing. The open chat's id, or the open group's; null for none.
 */
export function useOpenRowInView(box: RefObject<HTMLElement | null>, open: { chat: string | null; group: string | null }, ready: boolean) {
  const shown = useRef<{ box: HTMLElement; chat: string } | null>(null);
  const chat = open.chat ?? (open.group === null ? null : `group:${open.group}`);
  useLayoutEffect(() => {
    const list = box.current;
    if (!list || !chat || !ready || (shown.current?.box === list && shown.current.chat === chat)) return;
    // Not drawn yet (the chats are read after the first draw, a new chat's row comes later): looked for at the next draw.
    const row = [...list.querySelectorAll("[data-chat],[data-group]")].find(r => rowChat(r) === chat);
    if (!row) return;
    shown.current = { box: list, chat };
    const at = row.getBoundingClientRect(), view = list.getBoundingClientRect();
    if (at.bottom <= view.top || at.top >= view.bottom) row.scrollIntoView?.({ block: "center" });
  });
}
