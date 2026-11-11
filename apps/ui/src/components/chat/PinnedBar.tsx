import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";
import type { PinView } from "@ghostly/browser/shared/types";
import { useI18n } from "../../contexts/I18nContext";
import { revealMessage } from "../../hooks/useRowWindow";
import { jumpToMessage, messageSnippet, type ReplyIndex } from "../../lib/replies";
import { PinIcon } from "../PinIcon";

const icon = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const button = "shrink-0 grid place-items-center w-8 h-8 max-md:w-11 max-md:h-11 rounded-full text-text-secondary hover:text-accent hover:bg-surface-hover transition-colors cursor-pointer";

/**
 * The bar under a chat's header while a message is pinned (WISP 400 § Pinned message): a line of it, found in this
 * chat by the id both sides know it by; a click scrolls to it and marks it, as a quote's tap does. ✕ unpins, where
 * this side may (`onUnpin`). The bar goes with the focus in it (its ✕ pressed from the keyboard, or the other side
 * unpinning while the focus is on its line or ⓘ): the focus then goes to `returnFocus` (the chat's ⋮), unless the
 * person moved it elsewhere meanwhile. Before, it fell to the page.
 */
export function PinnedBar({ pin, index, onUnpin, returnFocus }: { pin?: PinView; index: ReplyIndex; onUnpin?: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [info, setInfo] = useState(false);
  const infoId = useId();
  /** What in the bar has the focus, until the focus moves on or the bar goes. */
  const held = useRef<HTMLElement | null>(null);
  const pinned = pin?.id;
  useLayoutEffect(() => {
    const was = held.current;
    if (pinned || !was) return;
    held.current = null;
    const at = document.activeElement;
    if (!at || at === document.body) returnFocus?.current?.focus({ preventScroll: true });
  }, [pinned, returnFocus]);
  const onBlur = (e: FocusEvent) => {
    const target = e.target;
    if (e.relatedTarget) held.current = null;
    // To nothing: the person's own move if it is still in the page. One taken out with the bar is seen as it goes.
    else setTimeout(() => { if (held.current === target && target.isConnected && document.activeElement !== target) held.current = null; });
  };
  if (!pin?.id) return null;
  const original = index.byRef.get(pin.id) ?? (pin.messageId ? index.byId.get(pin.messageId) : undefined);
  const open = () => { if (original && !jumpToMessage(original.id) && revealMessage(original.id)) jumpToMessage(original.id); };
  const more = t("common.moreInfo");
  return (
    <div data-testid="pinned-bar" onFocus={e => { held.current = e.target as HTMLElement; }} onBlur={onBlur} className="pinned-bar shrink-0 border-b border-border bg-panel-header px-3 py-1 max-md:px-2">
      <div className="flex items-center gap-1">
        <button type="button" data-testid="pinned-open" onClick={open} disabled={!original}
          className="min-w-0 flex-1 flex items-center gap-2 rounded px-1 py-0.5 text-start enabled:cursor-pointer enabled:hover:bg-surface-hover">
          <span className="shrink-0 text-accent"><PinIcon active size={15} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium text-accent">{t("chat.pinned.bar")}</span>
            <span data-testid="pinned-snippet" dir="auto" className="block truncate text-sm text-text-secondary">{original ? messageSnippet(original, t) : t("chat.pinned.notHere")}</span>
          </span>
        </button>
        <button type="button" data-testid="pinned-info" aria-expanded={info} aria-controls={infoId} aria-label={more} title={more} onClick={() => setInfo(!info)}
          className={`${button} aria-expanded:text-accent`}>
          <svg {...icon}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
        </button>
        {onUnpin && <button type="button" data-testid="pinned-unpin" onClick={() => onUnpin()} aria-label={t("chat.pinned.unpin")} title={t("chat.pinned.unpin")} className={button}>
          <svg {...icon}><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>}
      </div>
      {info && <p id={infoId} data-testid="pinned-info-text" className="m-0 mb-1 ps-8 text-xs leading-relaxed text-text-secondary">{t("chat.pinned.info")}</p>}
    </div>
  );
}
