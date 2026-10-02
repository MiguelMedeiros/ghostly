import { useI18n } from "../../contexts/I18nContext";
import { movePinned, pinnedPlace, type PinnedPlace } from "../../lib/storage";
import { MenuItem } from "../Menu";

/*
 * A pinned chat's place among the pinned ones, from its ⋮: Move up and Move down, one place at a time. It is what the
 * drag in the chat list does (hooks/useRowReorder.ts) for the keyboard, a screen reader, and anyone who would rather
 * not drag; the new place is read out.
 */

const Arrow = ({ up }: { up?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={up ? "M12 19V5 M5 12l7-7 7 7" : "M12 5v14 M5 12l7 7 7-7"} />
  </svg>
);

/** The two rows, for a pinned chat with another pinned chat to move past; the one at an end cannot be used there. */
export function PinMoveItems({ chat, onMoved }: { chat: string; onMoved(place: PinnedPlace | undefined): void }) {
  const { t } = useI18n();
  const place = pinnedPlace(chat);
  if (!place || place.count < 2) return null;
  const first = place.index === 0, last = place.index === place.count - 1;
  return <>
    <MenuItem testId="chat-pin-up" disabled={first} title={first ? t("chat.menu.moveFirst") : undefined} className="disabled:opacity-40" onClick={() => onMoved(movePinned(chat, "up"))} icon={<Arrow up />}>{t("chat.menu.moveUp")}</MenuItem>
    <MenuItem testId="chat-pin-down" disabled={last} title={last ? t("chat.menu.moveLast") : undefined} className="disabled:opacity-40" onClick={() => onMoved(movePinned(chat, "down"))} icon={<Arrow />}>{t("chat.menu.moveDown")}</MenuItem>
  </>;
}

/** The line a screen reader hears after a move (hooks/usePinMoveNote.ts). */
export function PinMoveNote({ text }: { text: string }) {
  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-pin-announcement">{text}</p>;
}
