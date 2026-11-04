/*
 * A row's place in the chat list is changed there: dragged (hooks/useRowReorder.ts), or Alt+↑/↓ on its focused row for
 * the keyboard and a screen reader. The new place is read out.
 */

/** The line a screen reader hears after a move (hooks/usePinMoveNote.ts). */
export function PinMoveNote({ text }: { text: string }) {
  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-pin-announcement">{text}</p>;
}
