import { useEffect, useRef, type RefObject } from "react";
import { useT } from "../../contexts/I18nContext";
import { focusLost } from "../../lib/focus";

/**
 * The line under a chat's header that says its contact is blocked, with Unblock contact. Pressed, it unblocks the
 * contact and the line goes, its button with it: the focus goes to `returnFocus` (⋮, where the menu's Unblock contact
 * leaves it) rather than to the page. On a phone the button takes a 44 px tap; the line is as tall as it is there.
 */
export function ChatBlockedLine({ onUnblock, returnFocus }: { onUnblock: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const t = useT();
  const pressed = useRef(false);
  // Gone after its Unblock (the contact unblocked): only then, and only from the page, does the focus move.
  useEffect(() => () => {
    if (pressed.current && focusLost()) returnFocus.current?.focus({ preventScroll: true });
  }, [returnFocus]);
  return (
    <div data-testid="chat-blocked" className="flex items-center justify-center gap-2 bg-panel-header/60 px-4 py-1.5 max-md:py-0 text-xs text-text-secondary">
      <span>{t("chat.block.blocked")}</span>
      <button type="button" data-testid="chat-blocked-unblock" className="underline text-accent cursor-pointer max-md:min-h-11 max-md:px-2"
        onClick={() => { pressed.current = true; onUnblock(); }}>{t("chat.menu.unblock")}</button>
    </div>
  );
}
